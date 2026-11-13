import type {
  AIProviderConfiguration,
  CloudflareTranslationConfiguration,
} from './providerTypes';

// Ported from Zeus Ascent Edition: ZEUSNext/TranslationData.swift (branch
// edition/ascent-parity-20261101, commit 71023ca). Engine enum, preferences and
// languages are 1:1 ports; browser-profile fields were dropped because Moon
// novels has no Zeus profile system.

export type TranslationEngine =
  | 'googleWeb'
  | 'googleCloud'
  | 'ai'
  | 'cloudflare'
  | 'microsoftVisco';

export const TRANSLATION_ENGINES: { id: TranslationEngine; title: string }[] = [
  { id: 'googleWeb', title: 'Google Translate — خدمة الويب' },
  { id: 'googleCloud', title: 'Google Cloud Translation — رسمي' },
  { id: 'ai', title: 'الذكاء الاصطناعي' },
  { id: 'cloudflare', title: 'Cloudflare Workers AI' },
  { id: 'microsoftVisco', title: 'Microsoft Translator — عبر Visco' },
];

// Verbatim from TranslationData.swift line 30.
export const TRANSLATION_LANGUAGES: [string, string][] = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['de', 'Deutsch'],
  ['tr', 'Türkçe'],
  ['fa', 'فارسی'],
  ['ur', 'اردو'],
  ['he', 'עברית'],
  ['ru', 'Русский'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh-CN', '中文'],
  ['pt', 'Português'],
  ['it', 'Italiano'],
  ['id', 'Indonesia'],
];

// Swift wrote contains(_:) on Array; JS equivalent is includes().
export const isRTLLanguage = (language: string): boolean =>
  ['ar', 'fa', 'ur', 'he', 'ps', 'yi'].includes(language.split('-')[0]);

export interface TranslationSegment {
  id: string;
  text: string;
}

// Failure carries an already-localized Arabic message, mirroring
// TranslationFailure.message in Swift.
export class TranslationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationFailure';
  }
}

// Moon novels additions (reader-facing, no Zeus equivalent needed there):
// readerAutomatic / prefetchNextChapters / glossary / customInstruction.
// v3 additions: unified automatic-translation master switch with per-scope
// toggles (metadata / reader / browser), translated-metadata display modes,
// AI batching policy knobs and a usage budget.
export type MetadataTitleMode = 'arabic' | 'both' | 'original';

export interface TranslationPreferences {
  engine: TranslationEngine;
  target: string;
  suggest: boolean;
  automatic: boolean;
  dynamicContent: boolean;
  excludedHosts: string[];
  providerID: string | null;
  cloudflare: CloudflareTranslationConfiguration | null;
  retainTranslations: boolean | null;
  suggestionDuration: number | null;
  readerAutomatic: boolean;
  prefetchNextChapters: number; // 0 = off, 1..2 chapters pre-translated
  glossary: { term: string; replacement: string }[];
  customInstruction: string;
  // --- v3: unified automatic translation ---------------------------------
  autoTranslate: boolean; // master switch (الترجمة التلقائية)
  autoScopeMetadata: boolean; // novel titles + summaries + genres
  autoScopeReader: boolean; // chapter content inside New Moon reader
  autoScopeBrowser: boolean; // pages of the internal browser
  metadataTitleMode: MetadataTitleMode; // how titles render when translated
  chapterTitles: boolean; // translate chapter list titles (independent)
  // --- v3: AI batching policy (engine === 'ai' ONLY) ---------------------
  aiStreaming: boolean; // incremental SSE display (openAI-compatible only)
  aiMaxRequestsPerChapter: number; // soft target 1..3, hard ceiling 1..12
  // --- v3: usage budget ---------------------------------------------------
  aiDailyRequestLimit: number; // 0 = unlimited; else hard daily ceiling
}

export const DEFAULT_TRANSLATION_PREFERENCES: TranslationPreferences = {
  engine: 'googleWeb',
  target: 'ar',
  suggest: true,
  automatic: false,
  dynamicContent: true,
  excludedHosts: [],
  providerID: null,
  cloudflare: null,
  retainTranslations: null,
  suggestionDuration: null,
  readerAutomatic: false,
  prefetchNextChapters: 0,
  glossary: [],
  customInstruction: '',
  autoTranslate: false,
  autoScopeMetadata: true,
  autoScopeReader: true,
  autoScopeBrowser: true,
  metadataTitleMode: 'arabic',
  chapterTitles: false,
  aiStreaming: false,
  aiMaxRequestsPerChapter: 3,
  aiDailyRequestLimit: 0,
};

export const suggestionSeconds = (prefs: TranslationPreferences): number =>
  Math.min(30, Math.max(0, prefs.suggestionDuration ?? 1.5));

export const keepsTranslations = (prefs: TranslationPreferences): boolean =>
  prefs.retainTranslations ?? true;

export const usesAIBatches = (prefs: TranslationPreferences): boolean =>
  prefs.engine === 'ai' || prefs.engine === 'cloudflare';

// True when the engine is the generic AI engine (NOT cloudflare — its worker
// keeps its own Zeus-verbatim limits and must never inherit AI policy).
export const isAIEngine = (prefs: TranslationPreferences): boolean =>
  prefs.engine === 'ai';

// Automatic translation resolution. The legacy `automatic` / `readerAutomatic`
// fields keep working (OR-mapped) so installs upgraded from v2 never silently
// lose behaviour; the new master switch gates the new scopes.
export type AutoScope = 'metadata' | 'reader' | 'browser';

export const autoEnabled = (
  scope: AutoScope,
  prefs: TranslationPreferences,
): boolean => {
  if (!prefs.autoTranslate) {
    // Legacy v2 keys stay honoured while the master switch is untouched/off.
    if (scope === 'browser') return prefs.automatic;
    if (scope === 'reader') return prefs.readerAutomatic;
    return false;
  }
  if (scope === 'metadata') return prefs.autoScopeMetadata;
  if (scope === 'reader') {
    return prefs.autoScopeReader || prefs.readerAutomatic;
  }
  return prefs.autoScopeBrowser || prefs.automatic;
};

export const streamsLargeBatches = (
  prefs: TranslationPreferences,
  provider: AIProviderConfiguration | null,
): boolean =>
  prefs.engine === 'ai' &&
  prefs.aiStreaming === true &&
  (provider?.kind === 'openAICompatible' || provider?.kind === 'geminiAPI');

export const secretKey = (
  prefs: TranslationPreferences,
  provider: AIProviderConfiguration | null,
): string => {
  switch (prefs.engine) {
    case 'microsoftVisco':
      return '';
    case 'googleCloud':
      return 'google-cloud';
    case 'cloudflare':
      return 'cloudflare-workers-ai';
    default:
      return provider?.id ?? '';
  }
};

// Memory namespace identity (see memory.ts): same fields as Zeus
// TranslationMemory.identity. Never includes secrets.
export const memoryIdentity = (
  pageID: string,
  prefs: TranslationPreferences,
  provider: AIProviderConfiguration | null,
): string[] => {
  const identity: string[] = ['v2', pageID, prefs.engine, prefs.target];
  if (prefs.engine === 'ai') {
    identity.push(
      provider?.id ?? '',
      provider?.baseURL ?? '',
      provider?.model ?? '',
      provider?.instruction ?? '',
      provider?.projectID ?? '',
      provider?.conversationID ?? '',
    );
  }
  if (prefs.engine === 'cloudflare') {
    identity.push(
      prefs.cloudflare?.endpoint ?? '',
      prefs.cloudflare?.accountID ?? '',
      prefs.cloudflare?.model ?? '',
      prefs.cloudflare?.instruction ?? '',
    );
  }
  return identity;
};
