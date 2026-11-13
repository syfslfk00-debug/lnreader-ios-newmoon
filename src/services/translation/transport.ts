import { TranslationFailure } from './types';

// Port of Zeus Ascent Edition: ZEUSNext/AITransport.swift (AIHTTP).
// Adaptation notes (documented, deliberate):
// - URLSession -> RN fetch. The Swift AIRedirectPolicy blocked cross-origin
//   redirects; RN fetch follows redirects transparently, so callers must use
//   validateEndpoint()-derived URLs and we re-check the final response URL is
//   same-origin before parsing (rejectCredentialCrossOrigin below).
// - The bounded byte-stream (8 MB incremental + cancellation per byte) becomes
//   a content-length pre-check plus a post-read size check; RN fetch has no
//   incremental byte iterator without bespoke native code.
// - timeoutIntervalForRequest 60s -> AbortController 60s.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

// AIHTTP.endpoint — HTTPS only (HTTP allowed for loopback), no userinfo,
// no query, no fragment. Path is appended for API-relative endpoints.
export const validateEndpoint = (base: string, path = ''): URL => {
  const fail = () =>
    new TranslationFailure(
      'أدخل عنوان HTTPS صالحًا للمزود. HTTP متاح للخادم المحلي فقط.',
    );
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    throw fail();
  }
  const host = url.hostname;
  if (
    !host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOCAL_HOSTS.includes(host))
    )
  ) {
    throw fail();
  }
  if (path.length > 0) {
    const left = url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const right = path.startsWith('/') ? path : `/${path}`;
    return new URL(url.origin + left + right);
  }
  return url;
};

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  url: string;
}

// AIHTTP.validate — Arabic status messages verbatim.
export const validateStatus = (status: number): void => {
  if (status >= 200 && status < 300) return;
  if (status === 401) {
    throw new TranslationFailure(
      'انتهت الجلسة أو مفتاح المزود غير صحيح. حدّث بيانات الاتصال.',
    );
  }
  if (status === 403) {
    throw new TranslationFailure(
      'رفض المزود الطلب. افتح موقعه لإكمال تسجيل الدخول أو تحقق من صلاحيات الحساب.',
    );
  }
  if (status === 429) {
    throw new TranslationFailure(
      'وصلت إلى حد استخدام المزود. انتظر قليلًا أو اختر مزودًا آخر.',
    );
  }
  throw new TranslationFailure(`تعذر الاتصال بالمزود (HTTP ${status}).`);
};

const MAX_RESPONSE_BYTES = 8_000_000;

export const httpSend = async (
  url: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    accept?: string;
    contentType?: string;
  } = {},
): Promise<TransportResponse> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
  try {
    const headers: Record<string, string> = {
      Accept: init.accept ?? 'application/json',
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = init.contentType ?? 'application/json';
    }
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers)) headers[k] = v;
    }
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      signal: controller.signal,
    });
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES) {
      throw new TranslationFailure('رد المزود أكبر من الحد المسموح.');
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new TranslationFailure('رد المزود أكبر من الحد المسموح.');
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      url: response.url,
    };
  } catch (error) {
    if (error instanceof TranslationFailure) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TranslationFailure(
        'انتهت مهلة الاتصال بالمزود. أعد المحاولة أو اختر مزودًا آخر.',
      );
    }
    throw new TranslationFailure(
      'تعذر الوصول إلى خدمة الترجمة. تحقق من الشبكة.',
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
};

export const httpObject = async (
  url: string,
  init?: Parameters<typeof httpSend>[1],
): Promise<unknown> => {
  const response = await httpSend(url, init);
  if (response.status < 200 || response.status >= 300) {
    let detail = '';
    try {
      const error = JSON.parse(response.text)?.error;
      if (typeof error?.status === 'string') detail = error.status;
      if (typeof error?.message === 'string') detail += ': ' + error.message;
      if (init?.headers) {
        for (const value of Object.values(init.headers)) {
          if (value) {
            detail = detail.split(value).join('[redacted]');
            const token = value.replace(/^Bearer\s+/i, '');
            if (token) detail = detail.split(token).join('[redacted]');
          }
        }
      }
    } catch {
      /* use status-specific message */
    }
    try {
      validateStatus(response.status);
    } catch (error) {
      throw new TranslationFailure(
        (error as Error).message + (detail ? ' ' + detail.slice(0, 500) : ''),
      );
    }
  }
  // Redirect guard (stands in for AIRedirectPolicy): the endpoint we called
  // must be the endpoint that answered, or we refuse to parse the payload.
  const called = new URL(url);
  const answered = new URL(response.url);
  if (answered.origin !== called.origin) {
    throw new TranslationFailure(
      'أعاد المزود توجيهًا غير متوقع؛ أُلغي الطلب حمايةً لبياناتك.',
    );
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new TranslationFailure('رد غير صالح من خدمة الترجمة.');
  }
};

// Form encoder mirroring AIHTTP.form: sorted keys, '+' escaped as %2B so
// Google/Visco endpoints receive literal plus signs.
export const encodeForm = (values: Record<string, string>): string =>
  Object.keys(values)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      key =>
        `${encodeURIComponent(key)}=${encodeURIComponent(values[key]).replace(
          /\+/g,
          '%2B',
        )}`,
    )
    .join('&');

// Multi-value form (Google batch: repeated q= parameters, order preserved).
export const encodeFormValues = (pairs: [string, string][]): string =>
  pairs
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value).replace(
          /\+/g,
          '%2B',
        )}`,
    )
    .join('&');

// AIHTTP.rpc — parse Google internal framing (anti-XSSI "wrb.fr" lines) used
// by the Gemini account protocol.
export const parseGoogleRPC = (data: string, id: string): unknown[] => {
  const out: unknown[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    const a = value as unknown[];
    if (
      a.length > 2 &&
      a[0] === 'wrb.fr' &&
      a[1] === id &&
      typeof a[2] === 'string'
    ) {
      try {
        out.push(JSON.parse(a[2]));
      } catch {
        // malformed inner JSON — skip
      }
      return;
    }
    for (const v of a) visit(v);
  };
  for (const line of data.split(/\r?\n/)) {
    try {
      visit(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
  return out;
};

// AIHTTP.nested — safe deep array index walk.
export const nested = (value: unknown, path: number[]): unknown => {
  let result: unknown = value;
  for (const index of path) {
    if (!Array.isArray(result) || (result as unknown[]).length <= index) {
      return null;
    }
    result = (result as unknown[])[index];
  }
  return result ?? null;
};
