// Ported from Zeus Ascent Edition: ZEUSNext/TranslationData.swift.
// AI provider configuration types. ChatGPT/Gemini *account* kinds are kept for
// parity; their web-session protocols are best-effort ports and may break when
// the upstream web app changes (same caveat as Zeus).

export type AIProviderKind =
  | 'chatGPTAccount'
  | 'geminiAccount'
  | 'openAICompatible'
  | 'geminiAPI';

export const AI_PROVIDER_KINDS: { id: AIProviderKind; title: string }[] = [
  { id: 'chatGPTAccount', title: 'حساب ChatGPT' },
  { id: 'geminiAccount', title: 'حساب Gemini' },
  { id: 'openAICompatible', title: 'OpenAI / مزود متوافق' },
  { id: 'geminiAPI', title: 'Gemini API الرسمي' },
];

export const isAccountKind = (kind: AIProviderKind): boolean =>
  kind === 'chatGPTAccount' || kind === 'geminiAccount';

export interface AIChoice {
  id: string;
  name: string;
  metadata?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface AIProject {
  id: string;
  name: string;
  chats: AIChoice[];
}

export interface AIProviderConfiguration {
  id: string;
  name: string;
  kind: AIProviderKind;
  baseURL: string;
  model: string;
  models: AIChoice[];
  chats: AIChoice[];
  projects: AIProject[];
  projectID: string | null;
  conversationID: string | null;
  googleAccountIndex: number;
  instruction: string;
  lastChecked: string | null; // ISO date (serialized prefs)
  discoveryNotice: string | null;
}

export const makeProviderID = (): string =>
  // UUID v4 without external deps (Hermes has no crypto.randomUUID).
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

export const createDefaultProvider = (): AIProviderConfiguration => ({
  id: makeProviderID(),
  name: '',
  kind: 'openAICompatible',
  baseURL: 'https://api.openai.com/v1',
  model: '',
  models: [],
  chats: [],
  projects: [],
  projectID: null,
  conversationID: null,
  googleAccountIndex: 0,
  instruction: '',
  lastChecked: null,
  discoveryNotice: null,
});

// Public connection metadata only; the Workers AI token lives in secrets.ts.
export interface CloudflareTranslationConfiguration {
  endpoint: string;
  accountID: string;
  accountName: string;
  model: string;
  models: AIChoice[];
  instruction: string;
  lastChecked: string | null;
}
