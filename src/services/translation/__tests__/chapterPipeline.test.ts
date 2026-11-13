import {
  ReaderTranslationCoordinator,
  type CoordinatorApplyItem,
  type CoordinatorProgress,
} from '../coordinator';
import { TranslationMemory } from '../memory';
import { translateSegments } from '../textService';
import { AIChapterBudget } from '../chapterBudget';
import {
  createDefaultProvider,
  type AIProviderConfiguration,
} from '../providerTypes';
import { DEFAULT_TRANSLATION_PREFERENCES } from '../types';
import { InMemoryMemoryDriver, waitUntil } from './helpers';

const provider: AIProviderConfiguration = {
  ...createDefaultProvider(),
  id: 'test',
  model: 'test-model',
};
const scope = { novelId: 'n', chapterId: 'c' };
const prefs = {
  ...DEFAULT_TRANSLATION_PREFERENCES,
  engine: 'ai' as const,
  providerID: provider.id,
  aiMaxRequestsPerChapter: 1,
};
const rows = Array.from({ length: 300 }, (_, i) => ({
  id: `p${i}`,
  text: `Line ${i}`,
  chapter: 1,
  tier: i < 4 ? 0 : 2,
  distance: 0,
}));

function harness(
  budget = new AIChapterBudget(),
  driver = new InMemoryMemoryDriver(),
  chosenProvider = provider,
) {
  const applied: CoordinatorApplyItem[] = [],
    progress: CoordinatorProgress[] = [];
  const coordinator = new ReaderTranslationCoordinator(
    prefs,
    [chosenProvider],
    {
      memory: new TranslationMemory(driver),
      budget,
      translate: translateSegments,
      getSecret: async () => 'key',
      onApply: items => applied.push(...items),
      onProgress: state => progress.push(state),
      yieldSlice: async () => {},
    },
  );
  return { coordinator, applied, progress, budget, driver };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const input = JSON.parse(
      JSON.parse(init!.body as string).messages[0].content.split(
        'INPUT_JSON:\n',
      )[1],
    );
    const content = JSON.stringify(
      input.map((row: { id: string }) => ({ id: row.id, text: '[مرحبا]' })),
    );
    return {
      status: 200,
      url: String(url),
      headers: new Headers(),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    } as Response;
  });
});

it('sends 300 mixed-visibility paragraphs in ONE real provider call, in reading order', async () => {
  const h = harness();
  h.coordinator.addSegments(rows, scope);
  expect(await waitUntil(() => h.coordinator.status === 'completed')).toBe(
    true,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const prompt = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
    .messages[0].content;
  expect(
    JSON.parse(prompt.split('INPUT_JSON:\n')[1]).map(
      (row: { id: string }) => row.id,
    ),
  ).toEqual(rows.map(row => row.id + '_0'));
  expect(h.applied).toHaveLength(300);
  expect(h.progress.at(-1)?.requests).toBe(1);
});

it('does not reset chapter spend when more text arrives or the view is restored', async () => {
  const h = harness();
  h.coordinator.addSegments(rows.slice(0, 1), scope);
  await waitUntil(() => h.coordinator.status === 'completed');
  h.coordinator.addSegments(rows.slice(1, 2), scope);
  await waitUntil(() => h.coordinator.status === 'paused');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(h.progress.at(-1)?.error).toContain('للموافقة');
  h.coordinator.resume();
  await waitUntil(() => h.coordinator.status === 'completed');
  expect(fetch).toHaveBeenCalledTimes(2);
  h.coordinator.restore();
  h.coordinator.addSegments(rows.slice(2, 3), scope);
  await waitUntil(() => h.coordinator.status === 'paused');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('shares the request allowance and memory between prefetch and foreground', async () => {
  const a = harness();
  a.coordinator.addSegments(rows, scope);
  await waitUntil(() => a.coordinator.status === 'completed');
  const b = harness(a.budget, a.driver);
  b.coordinator.addSegments(
    rows.map(row => ({ ...row, id: 'new-' + row.id })),
    scope,
  );
  await waitUntil(() => b.coordinator.status === 'completed');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(b.applied).toHaveLength(300);
});

it('requires separate approval to retry a failed paid request', async () => {
  (fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  const h = harness();
  h.coordinator.addSegments(rows.slice(0, 1), scope);
  await waitUntil(() => h.coordinator.status === 'paused');
  h.coordinator.resume();
  await waitUntil(() => h.coordinator.status === 'paused');
  expect(fetch).toHaveBeenCalledTimes(1);
  h.coordinator.resume();
  await waitUntil(() => h.coordinator.status === 'completed');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('pauses a large initial chapter before spending, and asks for a specific plan', async () => {
  const h = harness();
  const longRows = rows
    .slice(0, 50)
    .map(row => ({ ...row, text: row.text + 'x'.repeat(1000) }));
  h.coordinator.addSegments(longRows, scope);
  expect(await waitUntil(() => h.coordinator.status === 'paused')).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  h.coordinator.resume();
  expect(await waitUntil(() => h.coordinator.status === 'completed')).toBe(
    true,
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('uses discovered model output capacity to keep a large chapter in ONE call', async () => {
  const h = harness(new AIChapterBudget(), new InMemoryMemoryDriver(), {
    ...provider,
    models: [
      {
        id: provider.model,
        name: 'Large model',
        inputTokenLimit: 100000,
        outputTokenLimit: 65000,
      },
    ],
  });
  h.coordinator.addSegments(
    rows
      .slice(0, 50)
      .map(row => ({ ...row, text: row.text + 'x'.repeat(1000) })),
    scope,
  );
  expect(await waitUntil(() => h.coordinator.status === 'completed')).toBe(
    true,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
