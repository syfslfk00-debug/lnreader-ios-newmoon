// ReaderTranslationCoordinator — the Zeus reader batch loop as a driver
// class: visible-first tiers with no tier mixing in a visible round, memory
// reuse across runs, pause/resume, the translate-failure path, restore
// counter resets and per-batch text dedupe. Memory is the real
// TranslationMemory on an in-memory driver; the engine is a fake resolving
// segments with an Arabic marker prefix. No network, no timers.

import {
  ReaderTranslationCoordinator,
  type CollectedSegment,
  type CoordinatorApplyItem,
  type CoordinatorProgress,
} from '../coordinator';
import { TranslationMemory } from '../memory';
import type { translateSegments } from '../textService';
import {
  DEFAULT_TRANSLATION_PREFERENCES,
  TranslationFailure,
  type TranslationPreferences,
  type TranslationSegment,
} from '../types';
import {
  InMemoryMemoryDriver,
  flushAsync,
  makeFakeTranslate,
  waitUntil,
} from './helpers';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  }),
}));

const SCOPE = { novelId: 'novel-1', chapterId: 'chapter-1' };
const PREFIX = 'مُترجم: ';

const makePrefs = (
  engine: TranslationPreferences['engine'] = 'googleWeb',
): TranslationPreferences => ({
  ...DEFAULT_TRANSLATION_PREFERENCES,
  engine,
  target: 'ar',
  retainTranslations: true,
});

interface Harness {
  coordinator: ReaderTranslationCoordinator;
  translate: jest.MockedFunction<typeof translateSegments>;
  driver: InMemoryMemoryDriver;
  applied: CoordinatorApplyItem[][];
  progress: CoordinatorProgress[];
}

const buildHarness = (
  translate: jest.MockedFunction<typeof translateSegments> = makeFakeTranslate(
    PREFIX,
  ),
  engine: TranslationPreferences['engine'] = 'googleWeb',
  driver: InMemoryMemoryDriver = new InMemoryMemoryDriver(),
): Harness => {
  const applied: CoordinatorApplyItem[][] = [];
  const progress: CoordinatorProgress[] = [];
  const coordinator = new ReaderTranslationCoordinator(makePrefs(engine), [], {
    memory: new TranslationMemory(driver),
    translate,
    getSecret: async () => '',
    onApply: items => {
      applied.push(items);
    },
    onProgress: value => {
      progress.push(value);
    },
    yieldSlice: async () => {},
  });
  coordinator.setScope(SCOPE);
  return { coordinator, translate, driver, applied, progress };
};

let nextSegmentIndex = 0;
const segment = (text: string, tier = 0): CollectedSegment => {
  nextSegmentIndex += 1;
  return {
    id: `seg-${String(nextSegmentIndex).padStart(4, '0')}`,
    text,
    tier,
    distance: tier * 10,
    chapter: 3,
  };
};

const flushUntil = async (
  coordinator: ReaderTranslationCoordinator,
  status: 'completed' | 'paused',
): Promise<boolean> => waitUntil(() => coordinator.status === status);

beforeEach(() => {
  nextSegmentIndex = 0;
});

describe('ReaderTranslationCoordinator', () => {
  it('applies visible (tier 0) segments before background ones', async () => {
    const { coordinator, applied, progress } = buildHarness();
    const far = [
      segment('فقرة بعيدة أ', 2),
      segment('فقرة بعيدة ب', 2),
      segment('فقرة بعيدة ج', 2),
    ];
    const near = [segment('فقرة قريبة', 1)];
    const visible = [
      segment('ظاهر أ', 0),
      segment('ظاهر ب', 0),
      segment('ظاهر ج', 0),
      segment('ظاهر د', 0),
    ];

    // Queue order deliberately reversed: background first, visible last.
    coordinator.addSegments([...far, ...near, ...visible], SCOPE);

    expect(progress[0]).toMatchObject({
      status: 'running',
      total: 8,
      completed: 0,
    });
    expect(await flushUntil(coordinator, 'completed')).toBe(true);

    // Two rounds: one visible batch, then one background batch.
    expect(applied).toHaveLength(2);
    expect(applied[0].map(item => item.id)).toEqual(visible.map(row => row.id));

    const backgroundIds = new Set([...near, ...far].map(row => row.id));
    expect(applied[1].map(item => item.id)).toEqual(
      [...near, ...far].map(row => row.id), // tier 1 before tier 2
    );
    expect(applied[1].every(item => backgroundIds.has(item.id))).toBe(true);
    expect(applied.flat().every(item => item.text.startsWith(PREFIX))).toBe(
      true,
    );
    expect(progress[progress.length - 1]).toMatchObject({
      status: 'completed',
      completed: 8,
    });
  });

  it('never mixes tiers inside a visible round', async () => {
    const { coordinator, applied } = buildHarness();
    const visible = [
      segment('ظاهر أ', 0),
      segment('ظاهر ب', 0),
      segment('ظاهر ج', 0),
    ];
    const near = [segment('قريب أ', 1), segment('قريب ب', 1)];

    coordinator.addSegments([...near, ...visible], SCOPE);
    expect(await flushUntil(coordinator, 'completed')).toBe(true);

    expect(applied).toHaveLength(2);
    const visibleIds = new Set(visible.map(row => row.id));
    const nearIds = new Set(near.map(row => row.id));
    // First round: tier 0 only, even though tier 1 segments were queued first.
    expect(applied[0].length).toBeGreaterThan(0);
    expect(applied[0].every(item => visibleIds.has(item.id))).toBe(true);
    expect(applied[0].some(item => nearIds.has(item.id))).toBe(false);
    // Second round picks up the remaining tier only.
    expect(applied[1].every(item => nearIds.has(item.id))).toBe(true);
  });

  it('reuses prefilled memory and skips the translate call on a second identical run', async () => {
    const first = buildHarness();
    const texts = ['الفقرة الأولى', 'الفقرة الثانية', 'الفقرة الثالثة'];
    first.coordinator.addSegments(
      texts.map(text => segment(text)),
      SCOPE,
    );
    expect(await flushUntil(first.coordinator, 'completed')).toBe(true);
    expect(first.translate).toHaveBeenCalledTimes(1);

    // Second coordinator, same namespace inputs, same disk, cold session.
    const secondTranslate = makeFakeTranslate(PREFIX);
    const second = buildHarness(secondTranslate, 'googleWeb', first.driver);
    second.coordinator.addSegments(
      texts.map(text => segment(text)),
      SCOPE,
    );
    expect(await flushUntil(second.coordinator, 'completed')).toBe(true);

    expect(secondTranslate).not.toHaveBeenCalled();
    expect(second.applied.flat()).toHaveLength(texts.length);
    // Cached results carry the first run's translations.
    expect(
      second.applied
        .flat()
        .map(item => item.text)
        .sort(),
    ).toEqual(
      first.applied
        .flat()
        .map(item => item.text)
        .sort(),
    );
    expect(second.progress[second.progress.length - 1]).toMatchObject({
      status: 'completed',
      completed: 3,
      reused: 3,
    });
  });

  it('pauses before translating queued segments and finishes them after resume()', async () => {
    const { coordinator, translate, applied } = buildHarness();
    coordinator.addSegments([segment('أ'), segment('ب'), segment('ج')], SCOPE);
    coordinator.pause();

    expect(coordinator.status).toBe('paused');
    await flushAsync(50);
    expect(translate).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);

    coordinator.resume();
    expect(await flushUntil(coordinator, 'completed')).toBe(true);
    expect(applied.flat()).toHaveLength(3);
    expect(coordinator.status).toBe('completed');
  });

  it('keeps applied items, surfaces the Arabic failure and retries after resume (AI parts)', async () => {
    // v3 AI policy: 300 × 120-char segments ≈ 10.8k estimated tokens → the
    // planner emits 2 whole-chapter parts (≤ default ceiling of 3). Part 1
    // succeeds and stays applied; part 2 fails → paused + requeued; resume
    // retries ONLY the missing part (no re-billing for saved part 1).
    let attempts = 0;
    const flaky = jest.fn(
      async (
        input: TranslationSegment[],
        context: Parameters<typeof translateSegments>[1],
      ): Promise<TranslationSegment[]> => {
        context.onRequest?.();
        attempts += 1;
        if (attempts === 2) throw new TranslationFailure('فشل');
        return input.map(row => ({ id: row.id, text: `${PREFIX}${row.text}` }));
      },
    ) as unknown as jest.MockedFunction<typeof translateSegments>;

    const { coordinator, applied, progress, translate } = buildHarness(
      flaky,
      'ai',
    );
    const longText = 'نص طويل للفصل. '.repeat(8); // 120 chars
    const segments = Array.from({ length: 300 }, (_, index) =>
      segment(`${longText}#${index}`, 2),
    );
    coordinator.addSegments(segments, SCOPE); // one whole-chapter round

    expect(await flushUntil(coordinator, 'paused')).toBe(true);
    expect(coordinator.status).toBe('paused');
    expect(progress[progress.length - 1]?.error).toContain('فشل');
    // Part 1 was applied and saved before the failure; the request counter
    // reflects only the requests actually spent.
    expect(applied.flat()).toHaveLength(150);
    expect(applied.flat().every(item => item.text.startsWith(PREFIX))).toBe(
      true,
    );
    expect(progress[progress.length - 1]?.requests).toBe(2);
    // Two translate calls so far: part 1 + failed part 2.
    expect(translate).toHaveBeenCalledTimes(2);

    coordinator.resume();
    expect(await flushUntil(coordinator, 'completed')).toBe(true);
    expect(coordinator.status).toBe('completed');
    expect(progress[progress.length - 1]).toMatchObject({
      error: null,
      completed: 300,
    });
    // Retry covered ONLY part 2 — part 1 was never re-sent.
    expect(applied.flat()).toHaveLength(300);
    expect(attempts).toBe(3);
    // Every segment ends translated exactly once (no double-apply).
    const ids = applied.flat().map(item => item.id);
    expect(new Set(ids).size).toBe(300);
  });

  it('restore() resets all counters so progress reports total 0', async () => {
    const { coordinator, progress } = buildHarness();
    coordinator.addSegments([segment('أ'), segment('ب'), segment('ج')], SCOPE);
    expect(await flushUntil(coordinator, 'completed')).toBe(true);
    expect(progress[progress.length - 1]?.total).toBe(3);

    coordinator.restore();

    expect(coordinator.status).toBe('idle');
    expect(progress[progress.length - 1]).toEqual({
      status: 'idle',
      completed: 0,
      total: 0,
      reused: 0,
      error: null,
      requests: 0,
    });
  });

  it('bills repeated text once per batch and applies every occurrence', async () => {
    const { coordinator, translate, applied } = buildHarness();
    const repeated = 'النص المكرر';
    const unique = 'نص فريد';
    const dupes = [segment(repeated), segment(repeated)];

    coordinator.addSegments([...dupes, segment(unique)], SCOPE);
    expect(await flushUntil(coordinator, 'completed')).toBe(true);

    // One batch, one translate call, and the duplicate billed a single time.
    expect(translate).toHaveBeenCalledTimes(1);
    const billed = translate.mock.calls[0][0];
    expect(billed).toHaveLength(2);
    expect(billed.filter(row => row.text === repeated)).toHaveLength(1);

    // Both occurrences are applied with the same translation.
    expect(applied.flat()).toHaveLength(3);
    const appliedForDupes = applied
      .flat()
      .filter(item => dupes.some(row => row.id === item.id));
    expect(appliedForDupes.map(item => item.id).sort()).toEqual(
      dupes.map(row => row.id).sort(),
    );
    expect(new Set(appliedForDupes.map(item => item.text))).toEqual(
      new Set([`${PREFIX}${repeated}`]),
    );
  });
});
