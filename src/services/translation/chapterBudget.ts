import { getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';
import { clampMaxRequests } from './aiPolicy';

/** Shared by foreground and prefetch. Restoring the page must not reset spend. */
export class AIChapterBudget {
  private readonly entries = new Map<
    string,
    { spent: number; approved: number }
  >();

  constructor(private readonly persistent = false) {
    if (persistent) {
      try {
        const stored = getMMKVObject<
          [string, { spent: number; approved: number }][]
        >('@moon_chapter_requests_v1');
        if (Array.isArray(stored)) {
          for (const row of stored) {
            if (
              Array.isArray(row) &&
              typeof row[0] === 'string' &&
              Number.isSafeInteger(row[1]?.spent) &&
              row[1].spent >= 0 &&
              Number.isSafeInteger(row[1]?.approved) &&
              row[1].approved >= 0
            ) {
              this.entries.set(row[0], row[1]);
            }
          }
        }
      } catch {
        /* damaged usage metadata must not prevent app startup */
      }
    }
  }

  private save(): void {
    if (this.persistent) {
      setMMKVObject('@moon_chapter_requests_v1', [...this.entries]);
    }
  }

  private entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { spent: 0, approved: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  spent(key: string): number {
    return this.entry(key).spent;
  }

  allowance(key: string, limit: number): number {
    return Math.max(clampMaxRequests(limit), this.entry(key).approved);
  }

  approve(key: string, total: number): void {
    this.entry(key).approved = total;
    this.save();
  }

  reserve(key: string): void {
    this.entry(key).spent += 1;
    this.save();
  }
}

export const sharedChapterBudget = new AIChapterBudget(true);
