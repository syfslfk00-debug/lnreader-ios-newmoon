// Public surface of the moon-translation module (Zeus Ascent engine port).
// Screens should import from here only.

export * from './types';
export * from './providerTypes';
export {
  translateSegments,
  splitText,
  splitCloudflareText,
  parseGoogleBatch,
} from './textService';
export { validateAIResponse } from './validation';
export {
  discoverProvider,
  generateWithProvider,
  TEST_CONNECTION_PROMPT,
} from './providers';
export {
  translateCloudflare,
  discoverCloudflareModels,
  validateCloudflareToken,
  parseCloudflareConnection,
  cloudflareErrorMessage,
  CLOUDFLARE_DEFAULT_ENDPOINT,
  CLOUDFLARE_DEFAULT_MODEL,
} from './cloudflare';
export { splitVisco, translateVisco, VISCO_ENDPOINT } from './visco';
export {
  TranslationMemory,
  namespaceHash,
  entryKey,
  MEMORY_SCHEMA,
} from './memory';
export type {
  MemoryDriver,
  MemoryEntry,
  MemoryNovelStats,
  TranslationMemoryStats,
} from './memory';
export { createSqliteMemoryDriver } from './memorySqlite';
export { readSecret, saveSecret, deleteSecret } from './secrets';
export {
  loadPreferences,
  savePreferences,
  loadProviders,
  saveProviders,
  createProvider,
  providerById,
} from './prefs';
export { detectLanguage, primarySubtag } from './detect';
export {
  AI_COLLECT_CAPS,
  AI_MAX_PART_CHARS,
  AI_MAX_PART_SEGMENTS,
  AI_OUTPUT_TOKEN_BUDGET,
  AI_PLAN_DEFAULTS,
  clampMaxRequests,
  describeAIPlan,
  estimateTokens,
  planAIParts,
  limitsForProvider,
  type AIPlan,
  type AIPlanLimits,
} from './aiPolicy';
export {
  dailyLimitReached,
  getUsage,
  msUntilNextDay,
  recordAIRequest,
  recordAIRequestFailed,
  resetUsage,
  type TranslationUsageSnapshot,
} from './usage';
export {
  forceMetadata,
  isAlreadyTargetLanguage,
  metadataIsRTL,
  metadataPendingCount,
  queueMetadata,
  subscribeMetadata,
  translatedMetadata,
  type MetadataItem,
  type MetadataKind,
} from './metadata';
export { ReaderTranslationCoordinator } from './coordinator';
export {
  ARABIC_QUERY_PATTERN,
  isArabicPluginLang,
  pluginSearchTarget,
  translateSearchQuery,
} from './query';
export type {
  CollectedSegment,
  CoordinatorApplyItem,
  CoordinatorProgress,
  CoordinatorScope,
  CoordinatorStatus,
  CoordinatorDeps,
} from './coordinator';
