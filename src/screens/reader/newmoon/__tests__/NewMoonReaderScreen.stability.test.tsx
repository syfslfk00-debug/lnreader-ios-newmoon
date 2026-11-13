// P0 acceptance test — «اضغط الشاشة لإظهار/إخفاء الأدوات 50 مرة».
//
// Contract under test (NewMoonReaderScreen):
//   1. The WebView `source.html` document NEVER changes during the session —
//      not when the dock toggles (tapping the screen), not when the status
//      bar hides/shows and safe-area insets change.
//   2. Exactly ONE `chapter` command reaches the shell for the initial open —
//      a dock/insets churn never re-triggers the chapter pipeline.
//   3. WebView.reload() is never called by dock toggling.
//   4. A REAL content-process termination (onContentProcessDidTerminate)
//      recovers: exactly one reload, a full re-handshake on the next `ready`,
//      and exactly one additional chapter send.
//   5. The loading overlay is gone once the chapter pipeline finishes.
//
// This test FAILS against the pre-fix screen where `shellHtml` depended on
// live `insets.top/bottom` (status-bar hide → new HTML string → WebView
// reload → black screen / unresponsive buttons).

import { act, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------- captures ---
const captured = {
  /** Every `source` object ever handed to the WebView mock (order preserved). */
  sources: [] as { html: string; baseUrl: string }[],
  /** Every `injectJavaScript` payload (RN → shell commands). */
  injected: [] as string[],
  /** Times the mock's reload() was invoked. */
  reloads: 0,
  /** The single mock WebView ref — the screen's own ref lands here. */
  ref: null as {
    injectJavaScript: (s: string) => void;
    reload: () => void;
  } | null,
  /** Latest props handed to the WebView mock (onMessage etc.). */
  props: null as Record<string, unknown> | null,
};

// ------------------------------------------------------------------- mocks ---
jest.mock('react-native-webview', () => {
  const { forwardRef, useImperativeHandle } =
    require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const MockWebView = forwardRef((_props: Record<string, unknown>, ref) => {
    captured.props = _props;
    captured.sources.push(_props.source as { html: string; baseUrl: string });
    useImperativeHandle(ref, () => ({
      injectJavaScript: (script: string) => {
        captured.injected.push(script);
      },
      reload: () => {
        captured.reloads += 1;
      },
      goBack: () => {},
      stopLoading: () => {},
    }));
    return <View testID="mock-webview" />;
  });
  MockWebView.displayName = 'MockWebView';
  return { __esModule: true, default: MockWebView };
});

let mockInsets = { top: 59, bottom: 34 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock('react-native-edge-to-edge', () => ({
  SystemBars: { setHidden: jest.fn(), setStyle: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: jest.fn(),
    addListener: () => jest.fn(),
    navigate: mockNavigate,
  }),
}));

jest.mock('@hooks/persisted', () => ({
  useLibrarySettings: () => ({ incognitoMode: false }),
  useTheme: () => ({ isDark: true, primary: '#000' }),
}));

jest.mock('@hooks/index', () => ({
  useBackHandler: () => {},
}));

jest.mock('@utils/readerAssets', () => ({
  getReaderAssetsPrefix: () => 'file:///mock/ReaderAssets',
}));

jest.mock('@utils/Storages', () => ({
  NOVEL_STORAGE: '/mock/storage',
  DOWNLOADS_STORAGE: '/mock/downloads',
}));

// In-memory MMKV — backs NewMoonAdapter settings, wordsStore, storage shim.
const mockMem = new Map<string, string>();
jest.mock('@utils/mmkv/mmkv', () => ({
  MMKVStorage: {
    getString: (k: string) => mockMem.get(k),
    set: (k: string, v: string) => {
      mockMem.set(k, v);
    },
    remove: (k: string) => {
      mockMem.delete(k);
    },
  },
  getMMKVObject: jest.fn(),
  setMMKVObject: jest.fn(),
}));

jest.mock('@modules/native-file', () => ({
  __esModule: true,
  default: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    exists: jest.fn(),
  },
}));

jest.mock('@database/queries/ChapterQueries', () => ({
  markChapterRead: jest.fn(),
  updateChapterProgress: jest.fn(),
  getNovelChaptersByName: jest.fn(),
  getCustomPages: jest.fn(),
  insertChapters: jest.fn(),
}));

jest.mock('@database/queries/HistoryQueries', () => ({
  insertHistory: jest.fn(),
}));

jest.mock('@database/queries/NovelQueries', () => ({
  switchNovelToLibraryQuery: jest.fn(),
}));

jest.mock('@services/plugin/fetch', () => ({
  fetchChapter: jest.fn(),
  fetchPage: jest.fn(),
}));

jest.mock('@screens/reader/utils/sanitizeChapterText', () => ({
  sanitizeChapterText: jest.fn(),
}));

jest.mock('@screens/reader/components/KeepScreenAwake', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@components', () => ({
  IconButtonV2: () => null,
}));

jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
}));

// Chainable dbManager stub for NewMoonAdapter.fetchReaderOrderChapters.
jest.mock('@database/db', () => ({
  __esModule: true,
  dbManager: {
    select: () => {
      const chain: Record<string, unknown> = {};
      const finish = () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: () => ({
                  all: () => mockOrderedChapters,
                }),
              }),
            }),
          }),
        }),
      });
      Object.assign(chain, finish());
      return chain;
    },
  },
}));

jest.mock('@database/manager/manager', () => ({
  __esModule: true,
  castInt: (v: unknown) => v,
}));

const mockOrderedChapters = [
  { id: 101, name: 'الفصل الأول', page: '1', position: 1 },
  { id: 102, name: 'الفصل الثاني', page: '1', position: 2 },
] as unknown as import('@database/types').ChapterInfo[];

// eslint-disable-next-line import/first -- imports after jest.mock factories are required
import NewMoonReaderScreen from '../NewMoonReaderScreen';

const novel = {
  id: 7,
  name: 'رواية القمر',
  path: '/novel/path',
  pluginId: 'test-plugin',
  cover: 'https://example.com/cover.jpg',
  inLibrary: true,
} as unknown as import('@database/types').NovelInfo;

const chapter = {
  id: 101,
  novelId: 7,
  name: 'الفصل الأول',
  path: '/chapter/1',
  page: '1',
  position: 1,
} as unknown as import('@database/types').ChapterInfo;

const sendShell = (payload: Record<string, unknown>) => {
  act(() => {
    (captured.props?.onMessage as (e: unknown) => void)?.({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
};

const injectedKinds = () =>
  captured.injected
    .map(s => {
      const m = s.match(/"kind":"([a-zA-Z]+)"/);
      return m ? m[1] : null;
    })
    .filter(Boolean) as string[];

const injectedChapters = () =>
  injectedKinds().filter(k => k === 'chapter').length;

describe('NewMoonReaderScreen — drawer navigation wiring', () => {
  beforeEach(() => {
    captured.sources.length = 0;
    captured.injected.length = 0;
    captured.reloads = 0;
    captured.props = null;
    mockMem.clear();
    mockInsets = { top: 59, bottom: 34 };
    const NativeFile = require('@modules/native-file').default;
    NativeFile.readFile.mockResolvedValue('<p>نص</p>');
    const chapterQueries = require('@database/queries/ChapterQueries');
    chapterQueries.markChapterRead.mockResolvedValue(undefined);
    chapterQueries.updateChapterProgress.mockResolvedValue(undefined);
    chapterQueries.getNovelChaptersByName.mockResolvedValue([]);
    chapterQueries.getCustomPages.mockReturnValue([]);
    chapterQueries.insertChapters.mockResolvedValue(undefined);
    require('@database/queries/HistoryQueries').insertHistory.mockResolvedValue(
      undefined,
    );
    require('@database/queries/NovelQueries').switchNovelToLibraryQuery.mockResolvedValue(
      undefined,
    );
    const pluginFetch = require('@services/plugin/fetch');
    pluginFetch.fetchChapter.mockResolvedValue('<p>فصل</p>');
    pluginFetch.fetchPage.mockResolvedValue(null);
    require('@screens/reader/utils/sanitizeChapterText').sanitizeChapterText.mockImplementation(
      (_p: unknown, _n: unknown, _c: unknown, html: unknown) => String(html),
    );
  });

  it('routes every drawer nav target to a real app screen (no dead buttons)', async () => {
    render(
      <NewMoonReaderScreen route={{ params: { novel, chapter } } as never} />,
    );
    sendShell({ t: 'ready' });
    await waitFor(() => expect(injectedChapters()).toBe(1));

    sendShell({ t: 'nav', to: 'home' });
    expect(mockNavigate).toHaveBeenCalledWith('BottomNavigator', {
      screen: 'Library',
    });

    sendShell({ t: 'nav', to: 'downloads' });
    expect(mockNavigate).toHaveBeenCalledWith('MoreStack', {
      screen: 'Downloads',
    });

    sendShell({ t: 'nav', to: 'settings' });
    expect(mockNavigate).toHaveBeenCalledWith('MoreStack', {
      screen: 'SettingsStack',
      params: { screen: 'Settings' },
    });

    sendShell({ t: 'nav', to: 'about' });
    expect(mockNavigate).toHaveBeenCalledWith('MoreStack', { screen: 'About' });

    // contact was removed from the shell — a stale message must not navigate
    mockNavigate.mockClear();
    sendShell({ t: 'nav', to: 'contact' });
    expect(mockNavigate).not.toHaveBeenCalled();

    // the document is still frozen after all that navigation
    expect(captured.reloads).toBe(0);
  });
});

describe('NewMoonReaderScreen — 50-tap document stability (P0)', () => {
  // restoreMocks wipes module-factory implementations between tests —
  // re-arm every async mock here.
  beforeEach(() => {
    captured.sources.length = 0;
    captured.injected.length = 0;
    captured.reloads = 0;
    captured.ref = null;
    captured.props = null;
    mockMem.clear();
    mockInsets = { top: 59, bottom: 34 };

    mockNavigate.mockClear();

    const NativeFile = require('@modules/native-file').default;
    NativeFile.readFile.mockResolvedValue('<p>نص الفصل للقراءة</p>');

    const chapterQueries = require('@database/queries/ChapterQueries');
    chapterQueries.markChapterRead.mockResolvedValue(undefined);
    chapterQueries.updateChapterProgress.mockResolvedValue(undefined);
    chapterQueries.getNovelChaptersByName.mockResolvedValue([]);
    chapterQueries.getCustomPages.mockReturnValue([]);
    chapterQueries.insertChapters.mockResolvedValue(undefined);

    require('@database/queries/HistoryQueries').insertHistory.mockResolvedValue(
      undefined,
    );
    require('@database/queries/NovelQueries').switchNovelToLibraryQuery.mockResolvedValue(
      undefined,
    );

    const pluginFetch = require('@services/plugin/fetch');
    pluginFetch.fetchChapter.mockResolvedValue('<p>فصل من الشبكة</p>');
    pluginFetch.fetchPage.mockResolvedValue(null);

    require('@screens/reader/utils/sanitizeChapterText').sanitizeChapterText.mockImplementation(
      (_p: unknown, _n: unknown, _c: unknown, html: unknown) => String(html),
    );
  });

  it('keeps the WebView document frozen through 50 dock toggles + inset changes', async () => {
    const view = render(
      <NewMoonReaderScreen route={{ params: { novel, chapter } } as any} />,
    );

    // Boot: the shell announces `ready` → the bridge flushes its queued boot
    // messages (chapters/settings/words/fav) and the chapter pipeline runs.
    sendShell({ t: 'ready' });
    await waitFor(() => expect(injectedChapters()).toBe(1));

    const htmlAtBoot = captured.sources[captured.sources.length - 1].html;
    expect(htmlAtBoot).toContain('wor-body');
    expect(captured.props?.decelerationRate).toBe('normal');

    // 50 taps: dock toggle (shell → RN) with the status bar following
    // (insets.top/bottom flip, exactly like the real hide/show cycle).
    for (let i = 0; i < 50; i++) {
      const open = i % 2 === 0;
      mockInsets = open ? { top: 59, bottom: 34 } : { top: 0, bottom: 0 };
      sendShell({ t: 'dock', open });
      // Force a rerender so the screen re-evaluates the (frozen) memo.
      view.rerender(
        <NewMoonReaderScreen route={{ params: { novel, chapter } } as any} />,
      );
    }

    // 1. The document never changed — not once in 50 toggles.
    captured.sources.forEach(src => {
      expect(src.html).toBe(htmlAtBoot);
    });

    // 2. Exactly one chapter send for the initial open — no reload churn.
    expect(injectedChapters()).toBe(1);

    // 3. No document reloads were triggered.
    expect(captured.reloads).toBe(0);

    // 4. Loading overlay released after the chapter pipeline finished.
    await waitFor(() =>
      expect(JSON.stringify(view.toJSON())).not.toContain('ActivityIndicator'),
    );
    expect(view.toJSON()).toBeTruthy();
  });

  it('safe-area deltas travel through the bridge (settings patch), not the document', async () => {
    const view = render(
      <NewMoonReaderScreen route={{ params: { novel, chapter } } as any} />,
    );
    sendShell({ t: 'ready' });
    await waitFor(() => expect(injectedChapters()).toBe(1));

    // Change the (mocked) insets and re-render — as if the status bar had
    // just hidden. The screen must push a settings patch through the bridge
    // instead of rebuilding the document.
    act(() => {
      mockInsets = { top: 0, bottom: 0 };
    });
    view.rerender(
      <NewMoonReaderScreen route={{ params: { novel, chapter } } as any} />,
    );

    const findLastSettings = () =>
      [...captured.injected]
        .reverse()
        .find(s => s.includes('"kind":"settings"') && s.includes('"safeTop"'));
    await waitFor(() => expect(findLastSettings()).toBeTruthy());
    const lastSettings = findLastSettings();
    expect(lastSettings).toContain('"safeTop":0');
    expect(lastSettings).toContain('"safeBottom":0');
    // Document still identical.
    const htmls = new Set(captured.sources.map(s => s.html));
    expect(htmls.size).toBe(1);
    // No chapter re-send was triggered by the inset change.
    expect(injectedChapters()).toBe(1);
  });

  it('recovers from a real content-process kill: reload once, re-handshake, chapter re-sent once', async () => {
    render(
      <NewMoonReaderScreen route={{ params: { novel, chapter } } as any} />,
    );
    sendShell({ t: 'ready' });
    await waitFor(() => expect(injectedChapters()).toBe(1));
    expect(captured.reloads).toBe(0);

    // iOS killed the WKWebView content process:
    act(() => {
      (captured.props?.onContentProcessDidTerminate as () => void)?.();
    });
    expect(captured.reloads).toBe(1);

    // The reloaded shell boots again:
    sendShell({ t: 'ready' });
    await waitFor(() => expect(injectedChapters()).toBe(2));
    // settings/chapters/words/fav all re-sent after the handshake
    expect(
      injectedKinds().filter(k => k === 'chapters').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      captured.sources.every(s => s.html === captured.sources[0].html),
    ).toBe(true);
  });
});
