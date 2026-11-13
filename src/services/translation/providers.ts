import { type AIChoice, type AIProviderConfiguration } from './providerTypes';
import { TranslationFailure } from './types';
import {
  httpObject,
  httpSend,
  nested,
  parseGoogleRPC,
  validateEndpoint,
  validateStatus,
  type TransportResponse,
} from './transport';
import {
  recordAIRequest,
  recordAIRequestFailed,
  recordAIRequestStarted,
} from './usage';

// Port of Zeus Ascent Edition: ZEUSNext/AIProviderService.swift.
// Provider discovery + generation for four kinds. Private account protocols
// (ChatGPT/Gemini web sessions) are best-effort ports of the Swift code and
// may break when the upstream web app changes — same caveat as Zeus.
// v3: streaming (openAI-compatible, XHR progress — no new native deps) and
// factual usage metering (tokens ONLY when the provider reports them).

const uuid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

const bearer = (secret: string): Record<string, string> =>
  secret.length > 0 ? { Authorization: `Bearer ${secret}` } : {};

// ---- OpenAI-compatible ------------------------------------------------------

const discoverOpenAICompatible = async (
  config: AIProviderConfiguration,
  secret: string,
): Promise<AIChoice[]> => {
  const url = validateEndpoint(config.baseURL, 'models');
  const value = (await httpObject(url.toString(), {
    headers: bearer(secret),
  })) as {
    data?: { id?: unknown; name?: unknown }[];
  };
  return ((value?.data as { id?: unknown; name?: unknown }[]) ?? [])
    .filter(row => typeof row?.id === 'string')
    .map(row => ({
      id: row.id as string,
      name: typeof row.name === 'string' ? row.name : (row.id as string),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
};

// ---- Gemini API (official) --------------------------------------------------

const discoverGeminiAPI = async (secret: string): Promise<AIChoice[]> => {
  if (!secret.trim()) {
    throw new TranslationFailure('أدخل مفتاح Gemini API أولًا.');
  }
  const models: AIChoice[] = [];
  let page: string | null = null;
  const seenPages = new Set<string>();
  do {
    const url = new URL(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
    url.searchParams.set('pageSize', '100');
    if (page) {
      if (seenPages.has(page)) {
        throw new TranslationFailure(
          'أعاد Gemini رمز صفحة مكررًا. أعد اكتشاف النماذج.',
        );
      }
      seenPages.add(page);
      url.searchParams.set('pageToken', page);
    }
    const value = (await httpObject(url.toString(), {
      headers: { 'x-goog-api-key': secret },
    })) as {
      models?: {
        name?: unknown;
        displayName?: unknown;
        supportedGenerationMethods?: unknown;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }[];
      nextPageToken?: unknown;
    };
    for (const model of value?.models ?? []) {
      const name = typeof model?.name === 'string' ? model.name : '';
      const methods = Array.isArray(model?.supportedGenerationMethods)
        ? (model.supportedGenerationMethods as unknown[])
        : [];
      if (name && methods.includes('generateContent')) {
        models.push({
          id: name.replace(/^models\//, ''),
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
          name:
            typeof model.displayName === 'string' ? model.displayName : name,
        });
      }
    }
    page =
      typeof value?.nextPageToken === 'string' ? value.nextPageToken : null;
  } while (page !== null && models.length < 500);
  return models;
};

const generateGeminiAPI = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
  options?: GenerateOptions,
): Promise<string> => {
  if (!/^[A-Za-z0-9._-]+$/.test(config.model)) {
    throw new TranslationFailure('معرّف النموذج غير صالح.');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
  const value = (await httpObject(url, {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
    headers: { 'x-goog-api-key': secret },
    signal: options?.signal,
  })) as {
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  };
  const parts = value?.candidates?.[0]?.content?.parts ?? [];
  const result = parts
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
  if (!result) {
    throw new TranslationFailure(
      'لم يُرجع Gemini نصًا؛ قد يكون المحتوى مرفوضًا أو الحد مستنفدًا.',
    );
  }
  return result;
};

// ---- ChatGPT account (backend-api protocol) ---------------------------------

const CHATGPT_BASE = 'https://android.chat.openai.com/backend-api/';

// chatGPTHeaders — decode the access token JWT to extract the account id and
// enforce expiry, then emit the mobile-client header set (verbatim port).
const chatGPTHeaders = (secret: string): Record<string, string> => {
  const parts = secret.trim().split('.');
  if (parts.length !== 3) {
    throw new TranslationFailure(
      'أدخل Access Token لحساب ChatGPT؛ مفتاح API يُستخدم مع مزود OpenAI المتوافق.',
    );
  }
  let encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(atobUnicode(encoded));
  } catch {
    throw new TranslationFailure('لم يتضمن الرمز معرّف حساب ChatGPT.');
  }
  const auth = claims['https://api.openai.com/auth'] as
    | Record<string, unknown>
    | undefined;
  const account = auth?.chatgpt_account_id;
  if (typeof account !== 'string') {
    throw new TranslationFailure('لم يتضمن الرمز معرّف حساب ChatGPT.');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    throw new TranslationFailure(
      'انتهت صلاحية رمز ChatGPT. أدخل رمزًا جديدًا.',
    );
  }
  return {
    Authorization: `Bearer ${secret}`,
    'ChatGPT-Account-ID': account,
    'User-Agent': 'ChatGPT/1.2026.195 (Android 16; build 2619512)',
    'oai-package-name': 'com.openai.chatgpt',
    'oai-client-type': 'android',
    'oai-device-id': uuid(),
    'chatgpt-residency-region': 'no_constraint',
    'x-device-tier': 'mid',
  };
};

// base64 -> UTF-8 string without Buffer (Hermes-safe).
const atobUnicode = (base64: string): string => {
  const binary = globalThis.atob
    ? globalThis.atob(base64)
    : // minimal fallback (Hermes ships atob since RN 0.74; kept for safety)
      base64;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const accountGet = async (
  path: string,
  headers: Record<string, string>,
): Promise<unknown> => httpObject(CHATGPT_BASE + path, { headers });

const discoverChatGPT = async (
  config: AIProviderConfiguration,
  secret: string,
): Promise<{
  models: AIChoice[];
  chats: AIChoice[];
  projects: AIProviderConfiguration['projects'];
  notice: string | null;
}> => {
  const headers = chatGPTHeaders(secret);
  const modelsValue = (await accountGet('models', headers)) as {
    models?: { slug?: unknown; title?: unknown }[];
  };
  const models = (
    (modelsValue?.models as { slug?: unknown; title?: unknown }[]) ?? []
  )
    .filter(row => typeof row?.slug === 'string')
    .map(row => ({
      id: row.slug as string,
      name: typeof row.title === 'string' ? row.title : (row.slug as string),
    }));
  if (!models.some(row => row.id === 'auto')) {
    models.unshift({ id: 'auto', name: 'اختيار الحساب التلقائي' });
  }
  const chats: AIChoice[] = [];
  for (let offset = 0; offset < Math.min(50, 500); offset += 50) {
    const list = (await accountGet(
      `conversations?offset=${offset}&limit=50&order=updated&is_archived=false`,
      headers,
    )) as { items?: { id?: unknown; title?: unknown }[] };
    const items = ((list?.items as { id?: unknown; title?: unknown }[]) ?? [])
      .filter(row => typeof row?.id === 'string')
      .map(row => ({
        id: row.id as string,
        name: typeof row.title === 'string' ? row.title : 'محادثة بلا عنوان',
      }));
    chats.push(...items);
    if (items.length < 50) break;
  }
  let projects: AIProviderConfiguration['projects'] = [];
  let notice: string | null = null;
  try {
    const value = (await accountGet(
      'gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=100&limit=100',
      headers,
    )) as { items?: unknown[] };
    projects = ((value?.items as Record<string, unknown>[]) ?? []).flatMap(
      item => {
        const wrapper = (item?.gizmo as Record<string, unknown>) ?? {};
        const gizmo = (wrapper.gizmo as Record<string, unknown>) ?? wrapper;
        const id = gizmo?.id;
        if (typeof id !== 'string') return [];
        const display = (gizmo.display as Record<string, unknown>) ?? {};
        const conversationItems =
          ((item?.conversations as Record<string, unknown>)?.items as {
            id?: unknown;
            title?: unknown;
          }[]) ?? [];
        return [
          {
            id,
            name: typeof display.name === 'string' ? display.name : 'مشروع',
            chats: conversationItems
              .filter(row => typeof row?.id === 'string')
              .map(row => ({
                id: row.id as string,
                name:
                  typeof row.title === 'string'
                    ? row.title
                    : 'محادثة بلا عنوان',
              })),
          },
        ];
      },
    );
  } catch (error) {
    notice = `جُلبت النماذج والمحادثات؛ تعذر جلب المشاريع: ${
      (error as Error).message
    }`;
  }
  return { models, chats, projects, notice };
};

// ---- Gemini account (batchexecute web protocol) -----------------------------

interface GeminiSession {
  at: string;
  sid: string;
  build: string;
  cookie: string;
}

// Captures "SNlM0e":"…"-style values from the Gemini app HTML.
const captureValue = (text: string, pattern: string): string | null => {
  const match = text.match(new RegExp(pattern));
  if (!match) return null;
  const found = match[0];
  const idx = found.indexOf('":"');
  if (idx === -1) return null;
  return found.slice(idx + 3, -1);
};

const geminiSession = async (
  config: AIProviderConfiguration,
  secret: string,
): Promise<GeminiSession> => {
  if (!secret || secret.includes('\n') || secret.includes('\r')) {
    throw new TranslationFailure(
      'أدخل ترويسة Cookie لحساب Google من جلسة تخصك.',
    );
  }
  const url = `https://gemini.google.com/u/${config.googleAccountIndex}/app`;
  const response = await httpSend(url, {
    headers: {
      Cookie: secret,
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html',
    },
    accept: 'text/html',
  });
  validateStatus(response.status);
  const at = captureValue(response.text, '"SNlM0e":"[^"]+"');
  const sid = captureValue(response.text, '"FdrFJe":"[^"]+"');
  if (!at || !sid) {
    throw new TranslationFailure(
      'لم تكتمل مصادقة Gemini. سجّل الدخول إلى موقعه وحدّث كوكيز الحساب.',
    );
  }
  return {
    at,
    sid,
    build: captureValue(response.text, '"cfb2h":"[^"]+"') ?? '',
    cookie: secret,
  };
};

const geminiRPC = async (
  config: AIProviderConfiguration,
  session: GeminiSession,
  id: string,
  payload: unknown,
): Promise<unknown[]> => {
  const url = new URL(
    `https://gemini.google.com/u/${config.googleAccountIndex}/_/BardChatUi/data/batchexecute`,
  );
  url.searchParams.set('rpcids', id);
  url.searchParams.set('source-path', `/u/${config.googleAccountIndex}/app`);
  url.searchParams.set('f.sid', session.sid);
  url.searchParams.set('bl', session.build);
  url.searchParams.set('rt', 'c');
  const form = `at=${encodeURIComponent(session.at)}&f.req=${encodeURIComponent(
    JSON.stringify([[[id, JSON.stringify(payload), null, 'generic']]]),
  )}`;
  const response = await httpSend(url.toString(), {
    method: 'POST',
    body: form,
    headers: {
      Cookie: session.cookie,
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/',
      'X-Same-Domain': '1',
    },
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
  });
  validateStatus(response.status);
  return parseGoogleRPC(response.text, id);
};

const discoverGeminiAccount = async (
  config: AIProviderConfiguration,
  secret: string,
): Promise<{ models: AIChoice[]; chats: AIChoice[] }> => {
  const session = await geminiSession(config, secret);
  const status = await geminiRPC(config, session, 'otAQ7b', []);
  const models: AIChoice[] = [];
  const body = status[0];
  if (body) {
    const code = (nested(body, [14]) as number) ?? 1000;
    if (code !== 1000) {
      throw new TranslationFailure(
        `حساب Gemini غير جاهز (${code}). أكمل تسجيل الدخول وشروط الخدمة في موقعه.`,
      );
    }
    const tiers = (nested(body, [16]) as number[]) ?? [];
    const flags = (nested(body, [17]) as number[]) ?? [];
    const field = tiers.includes(21) || tiers.includes(22) ? 13 : 12;
    const capacity = tiers.includes(22)
      ? 2
      : tiers.includes(21)
      ? 1
      : flags.includes(115)
      ? 4
      : tiers.includes(16) || flags.includes(106)
      ? 3
      : tiers.includes(8) || flags.includes(19)
      ? 2
      : 1;
    const rows = (nested(body, [15]) as unknown[][]) ?? [];
    for (const row of rows) {
      const id = row.length > 0 && typeof row[0] === 'string' ? row[0] : null;
      if (!id) continue;
      const name =
        (nested(row, [11]) as string) ??
        (nested(row, [19]) as string) ??
        (row[1] as string) ??
        id;
      const header: unknown[] = [
        1,
        null,
        null,
        null,
        id,
        null,
        null,
        0,
        [4, 5, 6, 8],
        null,
        null,
      ];
      while (header.length <= field) header.push(null);
      header[field] = capacity;
      header.push(null);
      header.push(null);
      header.push(
        (nested(row, [17]) as number) ?? (nested(row, [9]) as number) ?? 1,
      );
      models.push({ id, name, metadata: JSON.stringify(header) });
    }
  }
  const chats: AIChoice[] = [];
  for (const pinned of [1, 0]) {
    const values = await geminiRPC(config, session, 'MaZiqc', [
      Math.min(50, 500),
      null,
      [pinned, null, 1],
    ]);
    for (const value of values) {
      const rows = (nested(value, [2]) as unknown[][]) ?? [];
      for (const row of rows) {
        const id = row.length > 0 && typeof row[0] === 'string' ? row[0] : null;
        const name = nested(row, [1]) as string | null;
        if (id && name && !chats.some(chat => chat.id === id)) {
          chats.push({ id, name });
        }
      }
    }
  }
  return { models, chats };
};

const generateGeminiAccount = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
): Promise<string> => {
  const session = await geminiSession(config, secret);
  const history: unknown[] = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const content: unknown[] = [
    [prompt, 0, null, [], null, null, 0],
    ['ar'],
    history,
    null,
    null,
    null,
    [],
    0,
    [],
    [],
    1,
    0,
  ];
  const url = new URL(
    `https://gemini.google.com/u/${config.googleAccountIndex}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`,
  );
  url.searchParams.set('bl', session.build);
  url.searchParams.set('hl', 'ar');
  url.searchParams.set('f.sid', session.sid);
  url.searchParams.set('rt', 'c');
  url.searchParams.set(
    '_reqid',
    String(Math.floor(10000 + Math.random() * 90000)),
  );
  const headers: Record<string, string> = {
    Cookie: session.cookie,
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'X-Same-Domain': '1',
  };
  const chosen = config.models.find(row => row.id === config.model);
  if (chosen?.metadata) headers['x-goog-ext-525001261-jspb'] = chosen.metadata;
  const response = await httpSend(url.toString(), {
    method: 'POST',
    body: `at=${encodeURIComponent(session.at)}&f.req=${encodeURIComponent(
      JSON.stringify([null, JSON.stringify(content)]),
    )}`,
    headers,
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
  });
  validateStatus(response.status);
  let result = '';
  for (const line of response.text.split(/\r?\n/)) {
    try {
      const outer = JSON.parse(line);
      const innerText = nested(outer, [0, 2]);
      if (typeof innerText !== 'string') continue;
      const inner = JSON.parse(innerText);
      const text = nested(inner, [4, 0, 1, 0]);
      if (typeof text === 'string' && text.length > 0) result = text;
    } catch {
      // non-JSON line
    }
  }
  if (!result) {
    throw new TranslationFailure(
      'لم يُرجع Gemini نصًا. أعد اختبار الاتصال؛ بروتوكول الويب قد يتغير.',
    );
  }
  return result;
};

// ---- ChatGPT generation ------------------------------------------------------

const generateChatGPTAccount = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
): Promise<string> => {
  const headers = chatGPTHeaders(secret);
  const parent = uuid();
  const message: Record<string, unknown> = {
    id: uuid(),
    author: { role: 'user' },
    content: { content_type: 'text', parts: [prompt] },
    status: 'finished_successfully',
    recipient: 'all',
    metadata: {},
  };
  const body: Record<string, unknown> = {
    action: 'next',
    messages: [message],
    parent_message_id: parent,
    model: config.model,
    history_and_training_disabled: false,
    force_use_sse: true,
    stream: true,
    websocket_request_id: uuid(),
  };
  if (config.conversationID) body.conversation_id = config.conversationID;
  if (config.projectID) {
    (message.metadata as Record<string, unknown>).gizmo_id = config.projectID;
    body.conversation_mode = {
      kind: 'gizmo_interaction',
      gizmo_id: config.projectID,
    };
    body.conversation_origin = 'tpp';
  }
  const response = await httpSend(CHATGPT_BASE + 'conversation', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
    accept: 'text/event-stream',
  });
  validateStatus(response.status);
  let answer = '';
  for (const line of response.text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.error) {
      throw new TranslationFailure(
        'أعاد ChatGPT خطأ أثناء التوليد. تحقق من الجلسة وحد الاستخدام.',
      );
    }
    const msg = event.message as Record<string, unknown> | undefined;
    const author = msg?.author as Record<string, unknown> | undefined;
    if (author?.role === 'assistant') {
      const content = msg?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts)
        ? (content.parts as unknown[])
        : [];
      const text = parts
        .filter((p): p is string => typeof p === 'string')
        .join('');
      if (text) answer = text;
    }
  }
  if (!answer) {
    throw new TranslationFailure(
      'لم يصل رد نصي من ChatGPT. ربما تغير بروتوكول الحساب أو انتهت الجلسة.',
    );
  }
  return answer;
};

// ---- Public surface ----------------------------------------------------------

export interface GenerateOptions {
  // v3 instant translation: stream the OpenAI-compatible response and emit
  // every completed {id,text} object as soon as it closes in the JSON array.
  stream?: boolean;
  signal?: AbortSignal;
  onRequest?: () => void;
  onPartialItem?: (item: { id: string; text: string }) => void;
}

// Parse a growing SSE buffer; returns the trailing (incomplete) line.
const consumeSSEBuffer = (
  buffer: string,
  onDelta: (delta: string) => void,
): string => {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    let value;
    try {
      value = JSON.parse(payload);
    } catch {
      continue;
    }
    if (value?.error) {
      throw new TranslationFailure(
        'أوقف المزود البث قبل اكتمال الترجمة. تحقق من الحصة أو النموذج.',
      );
    }
    const delta =
      value?.choices?.[0]?.delta?.content ??
      value?.candidates?.[0]?.content?.parts
        ?.filter((part: { thought?: boolean }) => !part.thought)
        .map((part: { text?: string }) => part.text ?? '')
        .join('');
    if (typeof delta === 'string' && delta.length > 0) onDelta(delta);
  }
  return rest;
};

// Scan `full` from `start` for complete top-level {"id":...,"text":...}
// objects (brace-balanced, string-aware). Returns the index to resume from.
export const extractTranslationProgress = (
  full: string,
  start: number,
  emit: (item: { id: string; text: string }) => void,
): number => {
  let index = start;
  while (index < full.length) {
    const open = full.indexOf('{', index);
    if (open === -1) return index;
    let depth = 0,
      inString = false,
      escaped = false,
      close = -1;
    for (let cursor = open; cursor < full.length; cursor++) {
      const c = full[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}' && --depth === 0) {
        close = cursor;
        break;
      }
    }
    const raw = full.slice(open, close < 0 ? undefined : close + 1);
    if (close >= 0) {
      try {
        const item = JSON.parse(raw);
        if (typeof item.id === 'string' && typeof item.text === 'string') {
          emit(item);
        }
      } catch {
        /* final validation reports malformed JSON */
      }
      index = close + 1;
    } else {
      // Only display decoded string data, never executable provider markup.
      const id = raw.match(/"id"\s*:\s*("(?:\\.|[^"\\])*")/);
      const text = raw.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)/);
      if (id && text) {
        const prefix = text[1].replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
        try {
          emit({ id: JSON.parse(id[1]), text: JSON.parse('"' + prefix + '"') });
        } catch {
          /* wait for a complete escape sequence */
        }
      }
      return open;
    }
  }
  return index;
};

// Progressive POST over XMLHttpRequest — RN fetch cannot stream, XHR can.
// JS-only: no native module, no new dependency, HTTPS unchanged.
const xhrStreamPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = 120_000;
    for (const [key, value] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(key, value);
      } catch {
        // Forbidden header: skip silently.
      }
    }
    let consumed = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ status: xhr.status, text: xhr.responseText ?? '' });
    };
    const abort = () => {
      xhr.abort();
      finish(new TranslationFailure('أُلغي طلب الترجمة.'));
    };
    const flush = () => {
      if (settled) return;
      try {
        if (xhr.status < 200 || xhr.status >= 300) return;
        if (
          xhr.responseURL &&
          new URL(xhr.responseURL).origin !== new URL(url).origin
        ) {
          throw new TranslationFailure('أعاد المزود توجيهًا غير متوقع.');
        }
        const text = xhr.responseText ?? '';
        if (text.length > 8_000_000) {
          throw new TranslationFailure('رد المزود أكبر من الحد المسموح.');
        }
        if (text.length > consumed) {
          onChunk(text.slice(consumed));
          consumed = text.length;
        }
      } catch (error) {
        finish(error as Error);
        xhr.abort();
      }
    };
    xhr.onprogress = flush;
    xhr.onload = () => {
      flush();
      finish();
    };
    xhr.onerror = () =>
      finish(new TranslationFailure('تعذر الاتصال بالمزود (بث تدريجي).'));
    xhr.ontimeout = () =>
      finish(new TranslationFailure('انتهت مهلة البث التدريجي من المزود.'));
    xhr.onabort = () => finish(new TranslationFailure('أُلغي طلب الترجمة.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    xhr.send(body);
  });

const generateStreamOpenAICompatible = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
  options: GenerateOptions,
): Promise<string> => {
  const gemini = config.kind === 'geminiAPI';
  const url = gemini
    ? new URL(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          config.model,
        )}:streamGenerateContent?alt=sse`,
      )
    : validateEndpoint(config.baseURL, 'chat/completions');
  let full = '';
  let buffer = '';
  let scan = 0;
  const flush = (chunk: string): void => {
    buffer = consumeSSEBuffer(buffer + chunk, delta => {
      full += delta;
    });
    scan = extractTranslationProgress(full, scan, item =>
      options.onPartialItem?.(item),
    );
  };
  const result = await xhrStreamPost(
    url.toString(),
    {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(gemini ? { 'x-goog-api-key': secret } : bearer(secret)),
    },
    JSON.stringify(
      gemini
        ? { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
        : {
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
          },
    ),
    flush,
    options.signal,
  );
  validateStatus(result.status);
  flush('\n');
  // Fallback: server ignored stream:true and answered plain JSON.
  if (full.length === 0) {
    try {
      const value = JSON.parse(result.text);
      const text = value?.choices?.[0]?.message?.content;
      if (typeof text === 'string') full = text;
    } catch {
      // Handled below.
    }
  }
  if (full.length === 0) {
    throw new TranslationFailure('لم يُرجع المزود نصًا من البث التدريجي.');
  }
  extractTranslationProgress(full, scan, item => options.onPartialItem?.(item));
  return full;
};

export const discoverProvider = async (
  input: AIProviderConfiguration,
  secret: string,
): Promise<AIProviderConfiguration> => {
  const config: AIProviderConfiguration = { ...input, discoveryNotice: null };
  switch (config.kind) {
    case 'openAICompatible':
      config.models = await discoverOpenAICompatible(config, secret);
      break;
    case 'geminiAPI':
      config.models = await discoverGeminiAPI(secret);
      break;
    case 'chatGPTAccount': {
      const found = await discoverChatGPT(config, secret);
      config.models = found.models;
      config.chats = found.chats;
      config.projects = found.projects;
      config.discoveryNotice = found.notice;
      break;
    }
    case 'geminiAccount': {
      const found = await discoverGeminiAccount(config, secret);
      config.models = found.models;
      config.chats = found.chats;
      config.projects = []; // Gemini account does not expose ChatGPT-style Projects.
      break;
    }
  }
  if (config.models.length === 0) {
    throw new TranslationFailure(
      'اتصل الخادم لكنه لم يُرجع نماذج متاحة لهذا الحساب. لا توجد نماذج مُختلقة؛ تحقق من العنوان أو الجلسة.',
    );
  }
  if (!config.models.some(row => row.id === config.model)) {
    config.model = config.models[0].id;
  }
  config.lastChecked = new Date().toISOString();
  return config;
};

export const generateWithProvider = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
  options?: GenerateOptions,
): Promise<string> => {
  if (!config.model) {
    throw new TranslationFailure(
      'اختر نموذجًا بعد اختبار اتصال المزود في الإعدادات.',
    );
  }
  if (options?.signal?.aborted) {
    throw new TranslationFailure('أُلغي طلب الترجمة.');
  }
  if (config.kind === 'openAICompatible') {
    validateEndpoint(config.baseURL, 'chat/completions');
  }
  if (config.kind === 'geminiAPI' && !/^[A-Za-z0-9._-]+$/.test(config.model)) {
    throw new TranslationFailure('معرّف النموذج غير صالح.');
  }
  options?.onRequest?.();
  recordAIRequestStarted();
  try {
    const text = await dispatchGenerate(prompt, config, secret, options);
    return text;
  } catch (error) {
    recordAIRequestFailed();
    throw error;
  }
};

const dispatchGenerate = async (
  prompt: string,
  config: AIProviderConfiguration,
  secret: string,
  options?: GenerateOptions,
): Promise<string> => {
  switch (config.kind) {
    case 'openAICompatible': {
      if (options?.stream) {
        const text = await generateStreamOpenAICompatible(
          prompt,
          config,
          secret,
          options,
        );
        recordAIRequest(prompt.length, text.length, null);
        return text;
      }
      const url = validateEndpoint(config.baseURL, 'chat/completions');
      const value = (await httpObject(url.toString(), {
        method: 'POST',
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        headers: bearer(secret),
        signal: options?.signal,
      })) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = value?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length === 0) {
        throw new TranslationFailure(
          'لم يُرجع المزود نصًا من chat/completions.',
        );
      }
      recordAIRequest(prompt.length, text.length, {
        promptTokens: value?.usage?.prompt_tokens,
        completionTokens: value?.usage?.completion_tokens,
      });
      return text;
    }
    case 'geminiAPI': {
      const text = options?.stream
        ? await generateStreamOpenAICompatible(prompt, config, secret, options)
        : await generateGeminiAPI(prompt, config, secret, options);
      recordAIRequest(prompt.length, text.length, null);
      return text;
    }
    case 'chatGPTAccount':
      return generateChatGPTAccount(prompt, config, secret);
    case 'geminiAccount':
      return generateGeminiAccount(prompt, config, secret);
    default:
      throw new TranslationFailure('نوع مزود غير معروف.');
  }
};

// Real generation test used by the settings screen (Zeus AIProviderEditor).
export const TEST_CONNECTION_PROMPT = 'Reply with exactly OK.';

export type { TransportResponse };
