import type { AIProviderConfiguration } from './providerTypes';
import { TranslationFailure } from './types';
// Moon novels v3 — AI batch policy (engine === 'ai' ONLY).
//
// Zeus Ascent translated chapter content through fixed-size rounds
// (24,000 chars / 256 segments visible, 10,000 / 64 background). That is
// perfect for metered web endpoints, but for AI providers it produces many
// paid requests: a 4,000-word chapter arrives as 4+ requests even though a
// modern model could translate the whole chapter in one call.
//
// This policy replaces the round caps for the `ai` engine only:
//   1. Prefer sending the WHOLE chapter as a single request.
//   2. If the estimated output exceeds the per-request token budget, split
//      into two large parts.
//   3. A 4,000-word chapter targets at most three large parts.
// Never: per-paragraph requests, unjustified small batches, or silent
// truncation. Parts are translated sequentially and every part is saved to
// the translation memory before the next request is paid for.
//
// Google / Google Cloud / Microsoft / Cloudflare keep their Zeus-verbatim
// limits untouched (enforced by the callers).

// Conservative token estimate for mixed EN/ZH -> AR prose: ~3.4 characters
// (code points) per token. Deliberately pessimistic so we UNDER-fill
// requests rather than overflow the model's output window.
export const CHARS_PER_TOKEN = 3.4;

// Default per-request output budget (tokens). Fits models with an 8k output
// window including JSON envelope overhead. Providers that report a smaller
// usable window should override via provider.maxOutputTokens (future).
export const AI_OUTPUT_TOKEN_BUDGET = 6000;

// Hard per-part input ceiling (code points). Even when the token estimate
// looks safe, never place more input than this into one request — it keeps
// request payloads bounded for providers with 8k/16k input windows.
export const AI_MAX_PART_CHARS = 40_000;

// Reader collect caps for the `ai` engine: large enough that the shell
// hands the coordinator the whole chapter in a single trCollect round, so
// the policy (not the shell) decides the actual request split.
export const AI_COLLECT_CAPS = { maxCharacters: 120_000, maxSegments: 4_096 };

// Absolute ceiling for segments inside one AI part — JSON prompts with
// thousands of short lines confuse small models; keep parts chunky but sane.
export const AI_MAX_PART_SEGMENTS = 1_024;

export const estimateTokens = (text: string): number =>
  Math.ceil(Array.from(text).length / CHARS_PER_TOKEN);

export interface AIPlanLimits {
  outputTokenBudget: number; // AI_OUTPUT_TOKEN_BUDGET
  maxCharsPerPart: number; // AI_MAX_PART_CHARS
  maxSegmentsPerPart: number; // AI_MAX_PART_SEGMENTS
  maxRequestsPerChapter: number; // prefs.aiMaxRequestsPerChapter (1..12)
}

export const AI_PLAN_DEFAULTS: AIPlanLimits = {
  outputTokenBudget: AI_OUTPUT_TOKEN_BUDGET,
  maxCharsPerPart: AI_MAX_PART_CHARS,
  maxSegmentsPerPart: AI_MAX_PART_SEGMENTS,
  maxRequestsPerChapter: 3,
};

export const clampMaxRequests = (value: number): number => {
  const rounded = Math.round(value);
  const base =
    Number.isFinite(rounded) && rounded >= 1
      ? rounded
      : AI_PLAN_DEFAULTS.maxRequestsPerChapter;
  return Math.min(12, Math.max(1, base));
};

export interface AIPlan {
  // Slice indexes: parts[i] = [start, end) over the ordered segment array.
  parts: [number, number][];
  requests: number; // === parts.length
  // True when the plan needed more requests than the user's ceiling — the
  // coordinator must pause and ask before spending them (no silent spend).
  exceedsCeiling: boolean;
  // Human-readable Arabic explanation for the pause dialog.
  reason?: string;
}

// Natural split points: paragraph boundaries are ALWAYS respected — parts
// only break between segments, never inside one. Segments are already
// ordered reading-order by the coordinator.
export const planAIParts = (
  segments: { id: string; text: string }[],
  limits: Partial<AIPlanLimits> = {},
): AIPlan => {
  const config: AIPlanLimits = { ...AI_PLAN_DEFAULTS, ...limits };
  const maxRequests = clampMaxRequests(config.maxRequestsPerChapter);
  if (
    segments.some(
      segment =>
        Array.from(segment.text).length > config.maxCharsPerPart ||
        estimateTokens(segment.text) > config.outputTokenBudget,
    )
  ) {
    throw new TranslationFailure(
      'توجد فقرة تتجاوز سعة النموذج المتاحة. اختر نموذجًا أكبر قبل إرسال الفصل.',
    );
  }

  if (segments.length === 0) {
    return { parts: [], requests: 0, exceedsCeiling: false };
  }

  // Natural request count: how many budget-sized requests the chapter needs.
  // A chapter that fits ONE request stays ONE request; 4,000 words (~24k
  // chars ≈ 7k tokens) lands at 2; only genuinely huge chapters exceed the
  // user's ceiling — and then we PAUSE for approval instead of spending.
  let totalTokens = 0;
  for (const segment of segments) totalTokens += estimateTokens(segment.text);
  const natural = Math.min(
    Math.max(1, Math.ceil(totalTokens / config.outputTokenBudget)),
    segments.length,
  );

  const parts = cutParts(segments, totalTokens, config, natural);
  if (parts.length <= maxRequests) {
    return { parts, requests: parts.length, exceedsCeiling: false };
  }
  return {
    parts,
    requests: parts.length,
    exceedsCeiling: true,
    reason:
      `هذا الفصل كبير: يُقدَّر بـ ${parts.length} طلبات ذكاء اصطناعي ` +
      `والحد الحالي ${maxRequests}. تابع للموافقة على الطلبات الإضافية، ` +
      'أو اختر نموذجًا أكبر سيُترجم الفصل بطلبات أقل.',
  };
};

// Greedy fill: walk segments in order, close a part when the NEXT segment
// would overflow the output-token budget or the hard char/segment ceilings.
// targetParts (when finite) distributes tokens evenly instead, producing
// "large halves/thirds" as the spec requires instead of budget-sized slivers.
const cutParts = (
  segments: { id: string; text: string }[],
  totalTokens: number,
  config: AIPlanLimits,
  targetParts: number,
): [number, number][] => {
  if (segments.length === 0) return [];
  const perPartTokens = Math.ceil(totalTokens / targetParts);
  const parts: [number, number][] = [];
  let start = 0;
  let tokens = 0;
  let chars = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const text = segments[index].text;
    const segmentTokens = estimateTokens(text);
    const segmentChars = Array.from(text).length;
    const wouldOverflowTokens =
      tokens > 0 && tokens + segmentTokens > perPartTokens;
    const wouldOverflowHard =
      tokens + segmentTokens > config.outputTokenBudget ||
      chars + segmentChars > config.maxCharsPerPart ||
      index - start + 1 > config.maxSegmentsPerPart;

    if (
      (wouldOverflowTokens && parts.length + 1 < targetParts) ||
      wouldOverflowHard
    ) {
      // Close current part BEFORE this segment (never splits a segment).
      parts.push([start, index]);
      start = index;
      tokens = segmentTokens;
      chars = segmentChars;
    } else {
      tokens += segmentTokens;
      chars += segmentChars;
    }
  }
  parts.push([start, segments.length]);
  return parts.filter(([from, to]) => to > from);
};

// Arabic notice shown in the reader status card while an AI run uses the
// multi-part policy — transparency about real request counts (spec item).
export const describeAIPlan = (requests: number, segments: number): string =>
  `${requests} طلب${requests === 1 ? '' : 'ات'} للنموذج · ${segments} فقرة`;

// Discovery limits are advisory and leave room for the JSON envelope. Unknown
// models retain conservative defaults rather than inventing a larger window.
export const limitsForProvider = (
  provider: AIProviderConfiguration | null,
): AIPlanLimits => {
  const model = provider?.models.find(row => row.id === provider.model);
  const output = model?.outputTokenLimit;
  const input = model?.inputTokenLimit;
  return {
    ...AI_PLAN_DEFAULTS,
    outputTokenBudget:
      output && output > 0
        ? Math.max(1, Math.floor(output * 0.75))
        : AI_OUTPUT_TOKEN_BUDGET,
    maxCharsPerPart:
      input && input > 0
        ? Math.max(1, Math.min(120_000, Math.floor((input - 2048) * 2)))
        : AI_MAX_PART_CHARS,
    maxSegmentsPerPart: 4096,
  };
};
