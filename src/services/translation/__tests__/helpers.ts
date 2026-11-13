// Test-only fakes for the translation service suites: an in-memory
// MemoryDriver that interprets the exact SQL subset TranslationMemory emits,
// a fake translate engine with call tracking, and bounded async flush loops.
// No network, no native modules, fully deterministic.

import type { MemoryDriver } from '../memory';
import type { translateSegments } from '../textService';
import type { TranslationSegment } from '../types';

export interface MemoryStatement {
  sql: string;
  params?: (string | number | null)[];
}

interface TranslationRow {
  text: string;
  used: number;
  bytes: number;
}

interface RefRow {
  novelId: string;
  chapterId: string;
  engine: string;
  target: string;
  updatedAt: number;
}

// Interprets only the SQL statements TranslationMemory actually sends (see
// memory.ts): schema no-ops, INSERT OR REPLACE, LRU touch updates, the
// MAX(256, COUNT/4) eviction, scoped ref deletions, clears, the per-key
// SELECT, the COUNT/SUM stats query and the per-novel GROUP BY breakdown.
// Maps are exposed so tests can inspect rows and count disk queries directly.
export class InMemoryMemoryDriver implements MemoryDriver {
  readonly translations = new Map<string, TranslationRow>();

  readonly refs = new Map<string, RefRow>();

  queryCount = 0;

  async execute(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<void> {
    this.run(sql, params ?? []);
  }

  async query<T>(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<T[]> {
    this.queryCount += 1;
    if (sql.includes('SELECT text FROM translations WHERE key')) {
      const row = this.translations.get(String(params?.[0]));
      return (row ? [{ text: row.text }] : []) as unknown as T[];
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM translations')) {
      let bytes = 0;
      for (const row of this.translations.values()) bytes += row.bytes;
      return [{ entries: this.translations.size, bytes }] as unknown as T[];
    }
    if (
      sql.includes('FROM translation_refs') &&
      sql.includes('GROUP BY r.novelId')
    ) {
      // Mirrors: SELECT novelId, COUNT(*), COALESCE(SUM(t.bytes),0) ... LEFT JOIN
      const groups = new Map<string, { count: number; bytes: number }>();
      for (const [key, ref] of this.refs.entries()) {
        const group = groups.get(ref.novelId) ?? { count: 0, bytes: 0 };
        group.count += 1;
        group.bytes += this.translations.get(key)?.bytes ?? 0;
        groups.set(ref.novelId, group);
      }
      return [...groups.entries()]
        .map(([novelId, group]) => ({ novelId, ...group }))
        .sort((a, b) => b.bytes - a.bytes) as unknown as T[];
    }
    return [];
  }

  async transaction(statements: MemoryStatement[]): Promise<void> {
    for (const statement of statements) {
      this.run(statement.sql, statement.params ?? []);
    }
  }

  private run(sql: string, params: (string | number | null)[]): void {
    if (sql.startsWith('PRAGMA') || sql.startsWith('CREATE')) return;
    if (sql === 'DELETE FROM translations') {
      this.translations.clear();
      return;
    }
    if (sql === 'DELETE FROM translation_refs') {
      this.refs.clear();
      return;
    }
    if (sql.includes('ORDER BY used LIMIT MAX(256')) {
      this.evictOldest();
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO translations')) {
      this.translations.set(String(params[0]), {
        text: String(params[1]),
        used: Number(params[2]),
        bytes: Number(params[3]),
      });
      return;
    }
    if (sql.startsWith('INSERT OR REPLACE INTO translation_refs')) {
      this.refs.set(String(params[0]), {
        novelId: String(params[1]),
        chapterId: String(params[2]),
        engine: String(params[3]),
        target: String(params[4]),
        updatedAt: Number(params[5]),
      });
      return;
    }
    if (sql.startsWith('UPDATE translations SET used')) {
      const row = this.translations.get(String(params[1]));
      if (row) row.used = Number(params[0]);
      return;
    }
    if (
      sql.startsWith(
        'DELETE FROM translations WHERE key IN (SELECT key FROM translation_refs',
      )
    ) {
      const novelId = String(params[0] ?? '');
      const chapterId = params.length > 1 ? String(params[1]) : null;
      for (const [key, ref] of this.refs.entries()) {
        if (ref.novelId !== novelId) continue;
        if (chapterId !== null && ref.chapterId !== chapterId) continue;
        this.translations.delete(key);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM translation_refs WHERE key NOT IN')) {
      for (const key of this.refs.keys()) {
        if (!this.translations.has(key)) this.refs.delete(key);
      }
      return;
    }
    if (sql.startsWith('DELETE FROM translation_refs')) {
      const novelId = String(params[0] ?? '');
      const chapterId = params.length > 1 ? String(params[1]) : null;
      for (const [key, ref] of this.refs.entries()) {
        if (
          ref.novelId === novelId &&
          (chapterId === null || ref.chapterId === chapterId)
        ) {
          this.refs.delete(key);
        }
      }
    }
  }

  // Mirrors: DELETE FROM translations ORDER BY used LIMIT MAX(256, COUNT/4).
  private evictOldest(): void {
    const limit = Math.max(256, Math.floor(this.translations.size / 4));
    const ordered = [...this.translations.entries()].sort(
      (a, b) => a[1].used - b[1].used,
    );
    for (const [key] of ordered.slice(0, limit)) this.translations.delete(key);
  }
}

// Fake engine resolving each segment with an Arabic marker prefix, so tests
// can tell translated output from source text. The jest.fn wrapper exposes
// call counts/args for assertions.
export const makeFakeTranslate = (
  prefix: string,
): jest.MockedFunction<typeof translateSegments> =>
  jest.fn(
    async (
      segments: TranslationSegment[],
      context,
    ): Promise<TranslationSegment[]> => {
      context.onRequest?.();
      return segments.map(segment => ({
        id: segment.id,
        text: `${prefix}${segment.text}`,
      }));
    },
  ) as unknown as jest.MockedFunction<typeof translateSegments>;

// Drains the microtask queue in bounded macrotask steps so async coordinator
// pumps settle without real timers or infinite loops.
export const flushAsync = async (rounds = 32): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }
};

// Resolves as soon as the predicate holds, with a hard iteration cap.
// Returns the final predicate value so callers can assert on it.
export const waitUntil = async (
  predicate: () => boolean,
  rounds = 400,
): Promise<boolean> => {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return true;
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }
  return predicate();
};
