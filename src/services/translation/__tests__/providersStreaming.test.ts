import {
  discoverProvider,
  extractTranslationProgress,
  generateWithProvider,
} from '../providers';
import { translateSegments } from '../textService';
import { createDefaultProvider } from '../providerTypes';
import { DEFAULT_TRANSLATION_PREFERENCES } from '../types';

class StreamXHR {
  static last: StreamXHR;
  responseText = '';
  responseURL = '';
  status = 200;
  timeout = 0;
  body = '';
  headers: Record<string, string> = {};
  onprogress?: () => void;
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() {
    StreamXHR.last = this;
  }
  open(_method: string, url: string) {
    this.responseURL = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(body: string) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  push(delta: string, gemini = false, notify = true) {
    const value = gemini
      ? { candidates: [{ content: { parts: [{ text: delta }] } }] }
      : { choices: [{ delta: { content: delta } }] };
    this.responseText += `data: ${JSON.stringify(value)}\r\n\r\n`;
    if (notify) this.onprogress?.();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.XMLHttpRequest = StreamXHR as unknown as typeof XMLHttpRequest;
});

it.each(['openAICompatible', 'geminiAPI'] as const)(
  'streams %s before completion, using original paragraph IDs',
  async kind => {
    const partial = jest.fn();
    const provider = { ...createDefaultProvider(), kind, model: 'test' };
    const promise = translateSegments([{ id: 'p1', text: 'Hello world' }], {
      prefs: { ...DEFAULT_TRANSLATION_PREFERENCES, engine: 'ai' },
      provider,
      secret: 'key',
      stream: true,
      onPartial: partial,
    });
    const xhr = StreamXHR.last;
    xhr.push('[{"id":"p1_0","text":"مر', kind === 'geminiAPI');
    expect(partial).toHaveBeenLastCalledWith({ id: 'p1', text: 'مر' });
    xhr.push('حبًا"}]', kind === 'geminiAPI', false); // load must flush bytes without a final progress event
    xhr.onload?.();
    await expect(promise).resolves.toEqual([{ id: 'p1', text: 'مرحبًا' }]);
    expect(
      xhr.headers[kind === 'geminiAPI' ? 'x-goog-api-key' : 'Authorization'],
    ).toBe(kind === 'geminiAPI' ? 'key' : 'Bearer key');
  },
);

it('rejects incomplete streams even when preview items were displayed', async () => {
  const promise = translateSegments([{ id: 'p', text: 'Hello' }], {
    prefs: { ...DEFAULT_TRANSLATION_PREFERENCES, engine: 'ai' },
    provider: { ...createDefaultProvider(), model: 'test' },
    secret: '',
    stream: true,
  });
  StreamXHR.last.push('[{"id":"p_0","text":"hello"}');
  StreamXHR.last.onload?.();
  await expect(promise).rejects.toThrow('ترجمة مكتملة');
});

it('aborts the underlying request and rejects on cancellation', async () => {
  const controller = new AbortController();
  const promise = generateWithProvider(
    'test',
    { ...createDefaultProvider(), model: 'test' },
    '',
    { stream: true, signal: controller.signal },
  );
  controller.abort();
  await expect(promise).rejects.toThrow('أُلغي');
});

it('decodes split JSON escapes without displaying raw escape syntax', () => {
  const emit = jest.fn();
  extractTranslationProgress('[{"id":"p","text":"Hi \\u06', 0, emit);
  expect(emit).toHaveBeenLastCalledWith({ id: 'p', text: 'Hi ' });
  extractTranslationProgress('[{"id":"p","text":"Hi \\u0645"}]', 0, emit);
  expect(emit).toHaveBeenLastCalledWith({ id: 'p', text: 'Hi م' });
});

it('discovers Gemini model pages with the entered key and actual capacity limits', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async url =>
      ({
        status: 200,
        url: String(url),
        headers: new Headers(),
        text: async () =>
          JSON.stringify(
            String(url).includes('pageToken')
              ? {
                  models: [
                    {
                      name: 'models/embedding',
                      supportedGenerationMethods: ['embedContent'],
                    },
                  ],
                }
              : {
                  models: [
                    {
                      name: 'models/gemini-live-test',
                      displayName: 'Test',
                      supportedGenerationMethods: ['generateContent'],
                      inputTokenLimit: 100000,
                      outputTokenLimit: 8000,
                    },
                  ],
                  nextPageToken: 'next',
                },
          ),
      } as Response),
  );
  const result = await discoverProvider(
    { ...createDefaultProvider(), kind: 'geminiAPI' },
    'valid-key',
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
    'x-goog-api-key': 'valid-key',
  });
  expect(result.model).toBe('gemini-live-test');
  expect(result.models).toHaveLength(1);
  expect(result.models[0].outputTokenLimit).toBe(8000);
});

it('reports Gemini permission errors without exposing the API key', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    async url =>
      ({
        status: 403,
        url: String(url),
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: {
              status: 'PERMISSION_DENIED',
              message: 'Request with valid-key was restricted',
            },
          }),
      } as Response),
  );
  const promise = discoverProvider(
    { ...createDefaultProvider(), kind: 'geminiAPI' },
    'valid-key',
  );
  await expect(promise).rejects.toThrow('PERMISSION_DENIED');
  await expect(promise).rejects.not.toThrow('valid-key');
});
