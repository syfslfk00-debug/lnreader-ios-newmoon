// Moon novels v3 — translation usage metering (budget feature).
//
// Counts real AI requests and, when the provider reports token usage,
// prompt/completion tokens. Values are persisted in MMKV so they survive
// restarts. NEVER invented: if a provider does not report usage, the token
// counters stay untouched (requests/characters are still factual).

import { getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';

const USAGE_KEY = '@moon_translation_usage_v2';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TranslationUsageSnapshot {
  // All-time counters.
  requests: number; // provider generation attempts, including failures
  requestsFailed: number;
  inputChars: number;
  outputChars: number;
  promptTokens: number; // only when the provider reports usage
  completionTokens: number; // only when the provider reports usage
  hasTokenData: boolean;
  // Daily counter for the optional budget ceiling.
  dayKey: string; // YYYY-MM-DD (device local time)
  requestsToday: number;
}

const EMPTY: TranslationUsageSnapshot = {
  requests: 0,
  requestsFailed: 0,
  inputChars: 0,
  outputChars: 0,
  promptTokens: 0,
  completionTokens: 0,
  hasTokenData: false,
  dayKey: '',
  requestsToday: 0,
};

const todayKey = (): string => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const load = (): TranslationUsageSnapshot => {
  const stored = getMMKVObject<TranslationUsageSnapshot>(USAGE_KEY);
  if (!stored) return { ...EMPTY };
  return { ...EMPTY, ...stored };
};

const save = (snapshot: TranslationUsageSnapshot): void => {
  setMMKVObject(USAGE_KEY, snapshot);
};

export const getUsage = (): TranslationUsageSnapshot => load();

export const resetUsage = (): void => {
  save({ ...EMPTY });
};

interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
}

// Records output after a successful call; attempts are reserved at dispatch. `usage` is null
// when the provider did not report token counts.
export const recordAIRequest = (
  inputChars: number,
  outputChars: number,
  usage: ProviderUsage | null,
): void => {
  const snapshot = load();
  const day = todayKey();
  if (snapshot.dayKey !== day) {
    snapshot.dayKey = day;
    snapshot.requestsToday = 0;
  }
  snapshot.inputChars += inputChars;
  snapshot.outputChars += outputChars;
  if (usage && (usage.promptTokens || usage.completionTokens)) {
    snapshot.hasTokenData = true;
    snapshot.promptTokens += usage.promptTokens ?? 0;
    snapshot.completionTokens += usage.completionTokens ?? 0;
  }
  save(snapshot);
};

export const recordAIRequestStarted = (): void => {
  const snapshot = load();
  const day = todayKey();
  if (snapshot.dayKey !== day) {
    snapshot.dayKey = day;
    snapshot.requestsToday = 0;
  }
  snapshot.requests += 1;
  snapshot.requestsToday += 1;
  save(snapshot);
};

export const recordAIRequestFailed = (): void => {
  const snapshot = load();
  snapshot.requestsFailed += 1;
  save(snapshot);
};

// True when the optional daily limit is set and already reached. The caller
// stops the run with an Arabic message instead of spending more.
export const dailyLimitReached = (limit: number): boolean => {
  if (!limit || limit <= 0) return false;
  const snapshot = load();
  const day = todayKey();
  const today = snapshot.dayKey === day ? snapshot.requestsToday : 0;
  return today >= limit;
};

// Test/launch support: how long until the daily window rolls over.
export const msUntilNextDay = (): number => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime()) || DAY_MS;
};
