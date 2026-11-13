import { useWebViewScrollProbe } from '../../../testing/useWebViewScrollProbe';
// lnreader-ios/src/screens/reader/newmoon/NewMoonReaderScreen.tsx
//
// RN controller for the REAL New-moon-2 reader engine (src/reader/newmoon/).
// The full UI lives inside the engine's self-contained HTML shell rendered in
// a WebView; this screen is the bridge + data layer:
//
//   • shell → RN messages arrive via onMessage (JSON {t: …}) — handled below.
//   • RN → shell commands go through NewMoonBridge (queued until `ready`,
//     injected as window.__wor.receive({...})).
//   • Chapters come from the classic LNReader pipeline (downloaded file →
//     plugin fetch → sanitizeChapterText) and are converted to wor text with
//     htmlToWorText + word-replacement store before buildWorSectionHTML.
//   • Chapter identity is positional (NewMoonAdapter) — no sequential-number
//     assumptions anywhere.
//
// Performance rules honored: shellHtml is built ONCE per mount and the
// WebView source NEVER changes after mount — not even when the status bar
// hides. Safe-area changes are pushed through the bridge as a settings patch
// (the shell re-writes --wor-safe-top/bottom in applyTheme), so tapping the
// screen to toggle the dock can never reload the document.
//
// WebView lifecycle protocol (documented contract):
//   1. mount      → source={html: shellHtml} (frozen string)
//   2. load start → if the bridge was already ready this is a REAL reload
//                   (WKWebView content-process kill, OOM, etc.): reset the
//                   bridge, bump the doc epoch, cancel in-flight chapter
//                   fetches and show the overlay again.
//   3. `ready`    → shell booted: mark bridge ready, flush queue, re-send
//                   settings/chapters/words/fav, then re-send the chapter ONLY
//                   if none reached the bridge yet (chapterSentRef guard — no
//                   duplicate fetches).
//   4. content-process termination (iOS) / render-process gone (Android)
//                 → recoverDocument(): reload + full re-handshake.
//   5. Stale-guard: docEpochRef invalidates needNext/append work from a dead
//                   document; chapterReqRef cancels superseded chapter loads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SystemBars } from 'react-native-edge-to-edge';
import WebView from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import type { ChapterScreenProps, RootStackParamList } from '@navigators/types';

import type { StringMap } from '@i18n/types';
import { getString } from '@i18n/translations';
import { useLibrarySettings, useTheme } from '@hooks/persisted';
import { useBackHandler } from '@hooks/index';
import { getReaderAssetsPrefix } from '@utils/readerAssets';
import { NOVEL_STORAGE } from '@utils/Storages';
import NativeFile from '@modules/native-file';
import {
  markChapterRead,
  updateChapterProgress,
  getNovelChaptersByName,
} from '@database/queries/ChapterQueries';
import { insertHistory } from '@database/queries/HistoryQueries';
import { switchNovelToLibraryQuery } from '@database/queries/NovelQueries';
import { IconButtonV2 } from '@components';
import { fetchChapter } from '@services/plugin/fetch';
import { sanitizeChapterText } from '../utils/sanitizeChapterText';
import KeepScreenAwake from '../components/KeepScreenAwake';
import type { ChapterInfo, NovelInfo } from '@database/types';

import buildWorShell from '../../../reader/newmoon/worShell';
import {
  buildWorSectionHTML,
  isLightColor,
  THEME_CYCLE,
} from '../../../reader/newmoon/sections';
import {
  buildColoredRegexSources,
  buildColoredTerms,
  effectiveTerms,
  loadWordsStore,
  replaceTermsInText,
  saveWordsStore,
  novelScopeOf,
  sortWordsList,
} from '../../../reader/newmoon/wordsStore';
import { htmlToWorText } from '../../../reader/newmoon/htmlToWorText';
import {
  NewMoonBridge,
  parseShellEvent,
  type WebViewHandle,
} from './NewMoonBridge';
import {
  TranslationController,
  type TranslationShellEvent,
} from './translationController';
import { getLegacyTtsPrefs } from './settingsMigration';
import {
  buildWNumMap,
  clearScrollFor,
  computePercent,
  extendChaptersFromSource,
  fetchReaderOrderChapters,
  loadScrollOffset,
  loadWorSettings,
  neighborWNum,
  saveLastPosition,
  saveScrollOffset,
  saveWorSettingsPatch,
  shellChapterList,
  sortChaptersInReaderOrder,
  type WorReaderSettings,
} from './NewMoonAdapter';

const TTS_CHUNK_CHARS = 3000;

type TranslationKey = keyof StringMap;

/** Chapter text split into TTS-sized chunks on line boundaries. */
export const buildTtsChunks = (text: string): string[] => {
  const chunks: string[] = [];
  let current = '';
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (current && current.length + trimmed.length + 1 > TTS_CHUNK_CHARS) {
      chunks.push(current);
      current = trimmed;
    } else {
      current = current ? `${current}\n${trimmed}` : trimmed;
    }
  });
  if (current) {
    chunks.push(current);
  }
  return chunks;
};

type WordItem = {
  id: string;
  original: string;
  replacement: string;
  exact: boolean;
  color: string | null;
};

type WordsStore = { novel: Record<string, WordItem[]>; global: WordItem[] };

const NewMoonReaderScreen = ({
  route,
}: {
  route: ChapterScreenProps['route'];
}) => {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const theme = useTheme();
  const scrollProbe = useWebViewScrollProbe();
  const insets = useSafeAreaInsets();
  const novel: NovelInfo = route.params.novel;
  const initialChapter: ChapterInfo = route.params.chapter;
  const { incognitoMode } = useLibrarySettings();

  // ---------------------------------------------------------------- refs ---
  const webViewRef = useRef<WebViewHandle | null>(null);
  const bridgeRef = useRef(new NewMoonBridge(webViewRef));
  /** Zeus-translation controller — one per mount (created in an effect
   *  below); talks to the shell only via the bridge, never the source. */
  const translationCtlRef = useRef<TranslationController | null>(null);
  /** worText per rendered section (wNum → text) — lets the translation
   *  prefetcher reuse already-extracted lines without re-reading files. */
  const sectionLinesRef = useRef<Map<number, string>>(new Map());

  // --------------------------------------------------------------- state ---
  /** One-time settings snapshot for render-phase reads (shell HTML, dock
   *  init, theme) — the ref below is the live copy for callbacks/effects. */
  const [initialSettings] = useState<WorReaderSettings>(() =>
    loadWorSettings(),
  );
  const settingsRef = useRef<WorReaderSettings>(initialSettings);
  const wordsStoreRef = useRef<WordsStore>({ novel: {}, global: [] });
  const coloredRef = useRef<{ src: string; color: string; escaped: string }[]>(
    [],
  );

  /** Ordered chapters (reader order) — identity source of truth. */
  const orderedRef = useRef<ChapterInfo[]>([]);
  const wNumMapRef = useRef<Map<number, ChapterInfo>>(new Map());
  /** Shell number (position) of the chapter that owns the document. */
  const currentWNumRef = useRef(0);
  /** Shell number (position) of the section the reader is looking at —
   *  differs from currentWNumRef once continuous mode appends sections. */
  const viewedWNumRef = useRef(0);
  /** wNums appended below the current chapter in continuous mode. */
  const appendedRef = useRef<number[]>([]);
  const endReachedRef = useRef(false);
  const loadingNextRef = useRef(false);
  /** Set once a `chapter` message has been handed to the bridge. */
  const chapterSentRef = useRef(false);
  /** True while a primary chapter load is in flight. */
  const loadingChapterRef = useRef(false);
  /** Dock-next in continuous mode → scroll to the freshly appended section. */
  const autoScrollNextRef = useRef(false);
  /** Epoch guard: drops stale needNext fetches after a doc swap. */
  const docEpochRef = useRef(0);
  const chapterReqRef = useRef(0);
  const markedReadRef = useRef<number | undefined>(undefined);
  const lastScrollRef = useRef<{
    wNum: number;
    inOffset: number;
    global: number;
    ratio: number;
  } | null>(null);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingMoreChaptersRef = useRef(false);
  const isFavoriteRef = useRef(!!novel.inLibrary);
  /** Set right before our own goBack so beforeRemove lets it through. */
  const allowRemoveRef = useRef(false);

  // chapter text for TTS (post word-replacement)
  const ttsChunksRef = useRef<string[]>([]);
  const ttsIndexRef = useRef(0);
  const ttsPlayingRef = useRef(false);
  /** Legacy TTS voice prefs (type-checked once at mount) — keeps the user's
   *  existing voice settings working with the native speech bar. */
  const ttsPrefsRef = useRef(getLegacyTtsPrefs());

  // --------------------------------------------------------------- state ---
  const [loading, setLoading] = useState(true);
  const [loadingNext, setLoadingNext] = useState(false);
  const [dockOpen, setDockOpen] = useState(initialSettings.dockOpen !== false);
  /** Safe-area values captured at mount — they seed the frozen document. */
  const [mountInsets] = useState(() => ({
    top: insets.top,
    bottom: insets.bottom,
  }));
  const [, setIsFavorite] = useState(!!novel.inLibrary);
  const [chapterTitle, setChapterTitle] = useState(initialChapter.name);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  /** Mirrors the engine's keepAwake switch → native wake lock. */
  const [keepAwake, setKeepAwake] = useState(
    initialSettings.keepAwake === true,
  );

  const shellTheme = useMemo(() => {
    const light = isLightColor(initialSettings.bgColor);
    return {
      background: initialSettings.bgColor,
      foreground: light ? '#1c1c1c' : '#f3f3f3',
    };
  }, [initialSettings]);

  // ---------------------------------------------------------- shell html ---
  // Built ONCE per mount from values captured at mount time. Settings changes
  // NEVER rebuild it (the shell applies settings via the bridge) and live
  // safe-area insets are NOT dependencies — the status-bar hide/show cycle
  // that accompanies dock toggling would otherwise produce a new HTML string
  // and reload the whole document (the P0 "chapter reloads on every tap"
  // bug). Live insets travel through the bridge instead (see the effect
  // below); the frozen document only carries the mount-time values.
  const shellHtml = useMemo(
    () =>
      buildWorShell({
        safeTop: mountInsets.top,
        safeBottom: mountInsets.bottom,
        novelTitle: novel.name,
        novelCover: novel.cover ?? '',
        userName: '',
        userRole: '', // (c) admin tools card stays hidden — no account system
        initialSettings: { ...initialSettings },
        fontsBase: getReaderAssetsPrefix(),
      }),
    [initialSettings, mountInsets, novel.name, novel.cover],
  );
  const assetsUriPrefix = useMemo(() => getReaderAssetsPrefix(), []);

  // ------------------------------------------------------------- senders ---
  const sendSettings = useCallback((settings: WorReaderSettings) => {
    bridgeRef.current.post({ kind: 'settings', settings: { ...settings } });
  }, []);

  const sendChapters = useCallback(() => {
    bridgeRef.current.post({
      kind: 'chapters',
      list: shellChapterList(orderedRef.current),
      total: orderedRef.current.length,
    });
  }, []);

  const sendWords = useCallback(() => {
    bridgeRef.current.post({
      kind: 'words',
      items: {
        novel: sortWordsList(novelScopeOf(wordsStoreRef.current, novel.id)),
        global: sortWordsList(wordsStoreRef.current.global || []),
      },
    });
  }, [novel.id]);

  const sendFav = useCallback((value: boolean) => {
    isFavoriteRef.current = value;
    bridgeRef.current.post({ kind: 'fav', value });
  }, []);

  // ---------------------------------------------------- chapter pipeline ---
  const coloredTermsFor = useCallback(() => {
    const terms = effectiveTerms(wordsStoreRef.current, novel.id);
    coloredRef.current = buildColoredRegexSources(buildColoredTerms(terms));
    return terms;
  }, [novel.id]);

  /** Downloaded file → plugin fetch (classic LNReader pipeline). */
  const loadChapterHtml = useCallback(
    async (chap: ChapterInfo): Promise<string> => {
      const filePath = `${NOVEL_STORAGE}/${novel.pluginId}/${chap.novelId}/${chap.id}/index.html`;
      try {
        return await NativeFile.readFile(filePath);
      } catch {
        return await fetchChapter(novel.pluginId, chap.path);
      }
    },
    [novel.pluginId],
  );

  /**
   * Sanitized HTML → wor text (word replacements applied) → section HTML.
   * Returns the section html plus the plain text kept for TTS.
   */
  const buildSection = useCallback(
    (chap: ChapterInfo, wNum: number, sanitizedHtml: string, idx: number) => {
      const terms = coloredTermsFor();
      const worText = replaceTermsInText(htmlToWorText(sanitizedHtml), terms);
      const S = { ...settingsRef.current, colored: coloredRef.current };
      const html = buildWorSectionHTML(
        {
          number: wNum,
          title: chap.name,
          content: worText,
          copyrightStyles: null,
        },
        idx,
        S,
      );
      return { html, worText };
    },
    [coloredTermsFor],
  );

  const sendChapterToShell = useCallback(
    (
      chap: ChapterInfo,
      wNum: number,
      sectionHtml: string,
      opts: { keepScroll?: boolean; scrollOffset?: number } = {},
    ) => {
      const total = orderedRef.current.length;
      const hasPrev = wNum > 1;
      const hasNext = neighborWNum(wNum, 1, total) !== null;
      const percent = computePercent(wNum, total);
      chapterSentRef.current = true;
      bridgeRef.current.post({
        kind: 'chapter',
        number: wNum,
        title: chap.name,
        novelTitle: novel.name,
        total,
        percent: `${percent}%`,
        percentValue: percent,
        hasPrev,
        hasNext,
        html: sectionHtml,
        commentCount: 0,
        showCommentsButton: false,
        authorCard: null,
        isFavorite: isFavoriteRef.current,
        scrollOffset: opts.keepScroll ? 0 : opts.scrollOffset ?? 0,
        keepScroll: !!opts.keepScroll,
      });
    },
    [novel.name],
  );

  /** Loads + renders a chapter as the PRIMARY document (resets the doc). */
  const loadChapter = useCallback(
    async (chap: ChapterInfo, wNum: number) => {
      const reqId = ++chapterReqRef.current;
      const epoch = ++docEpochRef.current;
      appendedRef.current = [];
      endReachedRef.current = false;
      loadingChapterRef.current = true;
      setLoading(true);
      setChapterTitle(chap.name);
      ttsChunksRef.current = [];
      stopTtsRef.current();

      try {
        const rawHtml = await loadChapterHtml(chap);
        if (reqId !== chapterReqRef.current) {
          return; // stale — a newer load superseded this one
        }
        const sanitized = sanitizeChapterText(
          novel.pluginId,
          novel.name,
          chap.name,
          rawHtml,
        );
        const { html, worText } = buildSection(chap, wNum, sanitized, 0);
        if (reqId !== chapterReqRef.current || epoch !== docEpochRef.current) {
          return;
        }

        currentWNumRef.current = wNum;
        viewedWNumRef.current = wNum;
        ttsChunksRef.current = buildTtsChunks(worText);
        setChapterTitle(chap.name);

        const scrollOffset = incognitoMode
          ? 0
          : loadScrollOffset(novel.id, chap.id);
        sendChapterToShell(chap, wNum, html, { scrollOffset });
        // Translation bookkeeping for the new document section: re-arm the
        // shell config + scope (bridge-only — the source string is frozen).
        translationCtlRef.current?.onChapterChanged();
        translationCtlRef.current?.setChapterScope(novel.id, chap.id, wNum);
        sectionLinesRef.current.clear();
        sectionLinesRef.current.set(wNum, worText);
        setLoading(false);

        if (!incognitoMode) {
          insertHistory(chap.id).catch(() => {});
        }
      } catch (e) {
        if (reqId !== chapterReqRef.current) {
          return;
        }
        setLoading(false);
        bridgeRef.current.post({
          kind: 'toast',
          text: getString('newMoon.chapterLoadFailed', {
            message: e instanceof Error ? e.message : String(e),
          }),
        });
      } finally {
        if (reqId === chapterReqRef.current) {
          loadingChapterRef.current = false;
        }
      }
    },
    [
      buildSection,
      incognitoMode,
      loadChapterHtml,
      novel.id,
      novel.name,
      novel.pluginId,
      sendChapterToShell,
    ],
  );

  // ------------------------------------------------------ tts (expo-speech) ---
  const speakNextChunkRef = useRef<() => void>(() => {});
  const stopTtsRef = useRef<() => void>(() => {});

  // Latest-closure assignment happens in an effect (never during render).
  useEffect(() => {
    stopTtsRef.current = () => {
      if (ttsPlayingRef.current) {
        ttsPlayingRef.current = false;
        setTtsPlaying(false);
        Speech.stop().catch(() => {});
      }
    };

    speakNextChunkRef.current = () => {
      if (!ttsPlayingRef.current) {
        return;
      }
      const chunks = ttsChunksRef.current;
      const index = ttsIndexRef.current;
      if (index >= chunks.length) {
        ttsPlayingRef.current = false;
        setTtsPlaying(false);
        return;
      }
      ttsIndexRef.current = index + 1;
      // expo-speech's speak() is synchronous-void; runtime errors surface
      // through the onError callback below (not a rejected promise).
      Speech.speak(chunks[index], {
        rate: ttsPrefsRef.current.rate,
        pitch: ttsPrefsRef.current.pitch,
        onDone: () => speakNextChunkRef.current(),
        onError: () => stopTtsRef.current(),
      });
    };
  });

  const toggleTts = useCallback(() => {
    if (ttsPlayingRef.current) {
      stopTtsRef.current();
      return;
    }
    if (!ttsChunksRef.current.length) {
      return;
    }
    ttsPlayingRef.current = true;
    ttsIndexRef.current = 0;
    setTtsPlaying(true);
    speakNextChunkRef.current();
  }, []);

  useEffect(
    () => () => {
      Speech.stop().catch(() => {});
    },
    [],
  );

  // ------------------------------------------------------------- scroll ---
  const flushScrollSave = useCallback(() => {
    if (scrollSaveTimer.current) {
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = null;
    }
    const last = lastScrollRef.current;
    if (!last || incognitoMode) {
      return;
    }
    const chap = wNumMapRef.current.get(last.wNum);
    if (!chap) {
      return;
    }
    saveScrollOffset(novel.id, chap.id, last.inOffset);
    saveLastPosition(novel.id, chap.id, last.wNum, last.inOffset);
    updateChapterProgress(
      chap.id,
      Math.min(100, Math.max(0, Math.round(last.ratio * 100))),
    ).catch(() => {});
    if (last.ratio >= 0.97 && markedReadRef.current !== chap.id) {
      markedReadRef.current = chap.id;
      markChapterRead(chap.id).catch(() => {});
    }
  }, [incognitoMode, novel.id]);

  const queueScrollSave = useCallback(
    (wNum: number, inOffset: number, ratio: number) => {
      lastScrollRef.current = { wNum, inOffset, global: 0, ratio };
      if (incognitoMode) {
        return;
      }
      if (scrollSaveTimer.current) {
        clearTimeout(scrollSaveTimer.current);
      }
      scrollSaveTimer.current = setTimeout(flushScrollSave, 600);
    },
    [flushScrollSave, incognitoMode],
  );

  // ---------------------------------------------------------- navigation ---
  const resolveChapterRow = useCallback(
    async (wNum: number): Promise<ChapterInfo | undefined> => {
      const local = wNumMapRef.current.get(wNum);
      if (local) {
        return local as ChapterInfo;
      }
      // Beyond the loaded window — the ordered query answers by position.
      const rows = await fetchReaderOrderChapters(novel.id, wNum - 1, 1);
      return rows[0];
    },
    [novel.id],
  );

  const navigateToWNum = useCallback(
    async (wNum: number) => {
      if (!wNum || wNum === currentWNumRef.current) {
        return;
      }
      const forward = wNum > currentWNumRef.current;
      const chap = await resolveChapterRow(wNum);
      if (!chap) {
        bridgeRef.current.post({
          kind: 'toast',
          text: getString(
            forward ? 'newMoon.noNextChapter' : 'newMoon.noPreviousChapter',
          ),
        });
        return;
      }
      // Engine behavior: forward navigation starts the target chapter fresh.
      if (forward) {
        clearScrollFor(novel.id, chap.id);
      }
      markedReadRef.current = undefined;
      await loadChapter(chap, wNum);
    },
    [loadChapter, novel.id, resolveChapterRow],
  );

  // ---------------------------------------------- continuous mode (needNext) ---
  const fetchNextForContinuous = useCallback(async () => {
    if (loadingNextRef.current || endReachedRef.current) {
      return;
    }
    if (!settingsRef.current.continuousMode) {
      return;
    }
    const epoch = docEpochRef.current;
    const lastWNum =
      appendedRef.current.length > 0
        ? appendedRef.current[appendedRef.current.length - 1]
        : currentWNumRef.current;
    const nextWNum = lastWNum + 1;
    if (nextWNum > orderedRef.current.length) {
      // Loaded window exhausted — try to extend from the source plugin once
      // (same mechanism as the dock's «تحميل المزيد») before declaring the end.
      try {
        const inserted = await extendChaptersFromSource(novel);
        if (inserted > 0 && epoch === docEpochRef.current) {
          orderedRef.current = await fetchReaderOrderChapters(novel.id);
          wNumMapRef.current = buildWNumMap(orderedRef.current);
          sendChapters();
        }
      } catch {
        // source unavailable — decide with what the DB has
      }
      if (nextWNum > orderedRef.current.length) {
        endReachedRef.current = true;
        bridgeRef.current.post({ kind: 'endReached' });
        return;
      }
    }

    loadingNextRef.current = true;
    setLoadingNext(true);
    bridgeRef.current.post({ kind: 'loadingNext', value: true });
    try {
      const chap = await resolveChapterRow(nextWNum);
      if (!chap || epoch !== docEpochRef.current) {
        endReachedRef.current = true;
        bridgeRef.current.post({ kind: 'endReached' });
        return;
      }
      const rawHtml = await loadChapterHtml(chap);
      if (epoch !== docEpochRef.current) {
        return; // user navigated away — stale append, drop it
      }
      const sanitized = sanitizeChapterText(
        novel.pluginId,
        novel.name,
        chap.name,
        rawHtml,
      );
      const { html, worText } = buildSection(chap, nextWNum, sanitized, 1);
      appendedRef.current.push(nextWNum);
      // Stash the plain text so the translation prefetcher can reuse it
      // without a second file read (bounded — only recent sections kept).
      sectionLinesRef.current.set(nextWNum, worText);
      if (sectionLinesRef.current.size > 8) {
        const oldest = sectionLinesRef.current.keys().next();
        if (oldest.done !== true) {
          sectionLinesRef.current.delete(oldest.value);
        }
      }
      // Memory namespace parity for continuous sections:
      // reader:{novelId}:{owningChapterId}#{section}.
      translationCtlRef.current?.associateChapter(nextWNum, chap.id);
      // appendChapter never auto-scrolls — the reader keeps their position
      // (scrollToChapter is only sent for explicit next-nav, like the engine).
      bridgeRef.current.post({ kind: 'appendChapter', number: nextWNum, html });
      if (autoScrollNextRef.current) {
        autoScrollNextRef.current = false;
        // Engine parity: the parent delays the scroll so the appended DOM
        // settles first (WorReader.tsx uses the same 350ms timeout).
        setTimeout(() => {
          bridgeRef.current.post({ kind: 'scrollToChapter', number: nextWNum });
        }, 350);
      }
    } catch {
      endReachedRef.current = true;
      bridgeRef.current.post({ kind: 'endReached' });
    } finally {
      loadingNextRef.current = false;
      setLoadingNext(false);
      bridgeRef.current.post({ kind: 'loadingNext', value: false });
    }
  }, [buildSection, loadChapterHtml, novel, resolveChapterRow, sendChapters]);

  // ------------------------------------------------------------- words ---
  const wordsAction = useCallback(
    async (msg: Record<string, unknown>) => {
      const scope = msg.scope === 'global' ? 'global' : 'novel';
      const novelIdKey = String(novel.id);
      const listFor = (): WordItem[] =>
        scope === 'global'
          ? wordsStoreRef.current.global || []
          : novelScopeOf(wordsStoreRef.current, novel.id);
      const commit = async (next: WordItem[], toastKey: TranslationKey) => {
        if (scope === 'global') {
          wordsStoreRef.current.global = next;
        } else {
          wordsStoreRef.current.novel[novelIdKey] = next;
        }
        await saveWordsStore(wordsStoreRef.current);
        coloredTermsFor();
        sendWords();
        bridgeRef.current.post({
          kind: 'wordsSaved',
          items: {
            novel: sortWordsList(novelScopeOf(wordsStoreRef.current, novel.id)),
            global: sortWordsList(wordsStoreRef.current.global || []),
          },
          toast: getString(toastKey),
        });
        // Galaxy behavior: word changes re-render the open chapter in place.
        const wNum = currentWNumRef.current;
        const chap = wNumMapRef.current.get(wNum);
        if (chap) {
          rebuildCurrentRef.current();
        }
      };

      const list = listFor();
      if (msg.action === 'addRep') {
        const original = String(msg.original || '').trim();
        if (!original) {
          bridgeRef.current.post({
            kind: 'toast',
            text: getString('newMoon.wordRequired'),
          });
          return;
        }
        const item: WordItem = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          original,
          replacement: String(msg.replacement || '').trim(),
          exact: !!msg.exact,
          color:
            typeof msg.color === 'string' &&
            /^#[0-9a-fA-F]{3,8}$/.test(msg.color)
              ? msg.color
              : null,
        };
        await commit([...list, item], 'newMoon.wordAdded');
      } else if (msg.action === 'updateRep') {
        const idx = list.findIndex(r => r.id === msg.id);
        if (idx === -1) {
          bridgeRef.current.post({
            kind: 'toast',
            text: getString('newMoon.wordNotFound'),
          });
          return;
        }
        const next = list.slice();
        next[idx] = {
          ...next[idx],
          original: String(msg.original || '').trim(),
          replacement: String(msg.replacement || '').trim(),
          exact: !!msg.exact,
          color:
            typeof msg.color === 'string' &&
            /^#[0-9a-fA-F]{3,8}$/.test(msg.color)
              ? msg.color
              : null,
        };
        await commit(next, 'newMoon.wordUpdated');
      } else if (msg.action === 'deleteRep') {
        await commit(
          list.filter(r => r.id !== msg.id),
          'newMoon.wordDeleted',
        );
      } else if (msg.action === 'clearScope') {
        await commit([], 'newMoon.wordsCleared');
      }
    },
    [coloredTermsFor, novel.id, sendWords],
  );

  // ------------------------------------------- current chapter re-render ---
  /** Rebuilds the displayed chapter in place (keepScroll) — structural
   *  setting changes and word changes only; NEVER a WebView reload. */
  const rebuildCurrentRef = useRef<() => void>(() => {});
  useEffect(() => {
    rebuildCurrentRef.current = () => {
      const wNum = currentWNumRef.current;
      const chap = wNumMapRef.current.get(wNum);
      if (!chap) {
        return;
      }
      void (async () => {
        try {
          const rawHtml = await loadChapterHtml(chap);
          const sanitized = sanitizeChapterText(
            novel.pluginId,
            novel.name,
            chap.name,
            rawHtml,
          );
          const { html, worText } = buildSection(chap, wNum, sanitized, 0);
          ttsChunksRef.current = buildTtsChunks(worText);
          sectionLinesRef.current.set(wNum, worText);
          sendChapterToShell(chap, wNum, html, {
            keepScroll: true,
          });
        } catch {
          // keep the currently rendered chapter on rebuild failure
        }
      })();
    };
  });

  // ----------------------------------------------------- chapters list ---
  const loadChapters = useCallback(async () => {
    const ordered = await fetchReaderOrderChapters(novel.id);
    if (!ordered.length) {
      try {
        await extendChaptersFromSource(novel);
      } catch {
        // source unavailable — proceed with what the DB has
      }
    }
    const final = await fetchReaderOrderChapters(novel.id);
    orderedRef.current = final;
    wNumMapRef.current = buildWNumMap(final);
    sendChapters();
  }, [novel, sendChapters]);

  const loadMoreChapters = useCallback(async () => {
    if (loadingMoreChaptersRef.current) {
      return;
    }
    loadingMoreChaptersRef.current = true;
    try {
      const inserted = await extendChaptersFromSource(novel);
      if (inserted > 0) {
        const before = orderedRef.current.map(c => c.id);
        const fresh = await fetchReaderOrderChapters(novel.id);
        // Append-only guarantee: the previous ordered ids must be a prefix.
        const stablePrefix = before.every((id, i) => fresh[i]?.id === id);
        // Identity of the chapter on screen, captured BEFORE the swap so a
        // plugin reorder can be remapped below.
        const displayedId =
          before[currentWNumRef.current - 1] ?? initialChapter.id;
        orderedRef.current = fresh;
        wNumMapRef.current = buildWNumMap(fresh);
        sendChapters();
        if (!stablePrefix) {
          // Order changed under us (plugin re-insert) — remap and re-render.
          const newWNum = fresh.findIndex(c => c.id === displayedId);
          if (newWNum !== -1) {
            currentWNumRef.current = newWNum + 1;
            viewedWNumRef.current = newWNum + 1;
          }
          rebuildCurrentRef.current();
        }
      } else {
        // Nothing new — re-send so the shell hides the "load more" button.
        sendChapters();
      }
    } catch {
      bridgeRef.current.post({
        kind: 'chaptersSearchResults',
        q: null,
        results: [],
        total: orderedRef.current.length,
        loadFailed: true,
      });
    } finally {
      loadingMoreChaptersRef.current = false;
    }
  }, [initialChapter.id, novel, sendChapters]);

  const searchChapters = useCallback(
    (q: string) => {
      const query = String(q || '').trim();
      if (!query) {
        return;
      }
      void (async () => {
        try {
          const rows = await getNovelChaptersByName(novel.id, query);
          const results = sortChaptersInReaderOrder(rows).flatMap(row => {
            const wNum = orderedRef.current.findIndex(c => c.id === row.id);
            return wNum === -1 ? [] : [{ number: wNum + 1, title: row.name }];
          });
          bridgeRef.current.post({
            kind: 'chaptersSearchResults',
            q: query,
            results,
            total: orderedRef.current.length,
          });
        } catch {
          bridgeRef.current.post({
            kind: 'chaptersSearchResults',
            q: query,
            results: [],
            total: orderedRef.current.length,
            loadFailed: true,
          });
        }
      })();
    },
    [novel.id],
  );

  // ------------------------------------------------------------ settings ---
  const applySettingsPatch = useCallback((patch: Record<string, unknown>) => {
    settingsRef.current = {
      ...settingsRef.current,
      ...patch,
    } as WorReaderSettings;
    saveWorSettingsPatch(patch);
    bridgeRef.current.post({ kind: 'settings', settings: patch });
    if (typeof patch.keepAwake === 'boolean') {
      setKeepAwake(patch.keepAwake);
    }
  }, []);

  const handleThemeCycle = useCallback(() => {
    const S = settingsRef.current;
    let idx = THEME_CYCLE.findIndex(t => t.bgPreset === S.bgPreset);
    if (idx === -1) {
      idx = THEME_CYCLE.findIndex(
        t => t.bgColor.toLowerCase() === String(S.bgColor).toLowerCase(),
      );
    }
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    applySettingsPatch({
      bgPreset: next.bgPreset,
      bgColor: next.bgColor,
      textColor: next.textColor,
      customColors: false,
    });
  }, [applySettingsPatch]);

  // ----------------------------------------------------------- favorites ---
  const toggleFavorite = useCallback(async () => {
    try {
      const updated = await switchNovelToLibraryQuery(
        novel.path,
        novel.pluginId,
      );
      const value = updated ? !!updated.inLibrary : !isFavoriteRef.current;
      setIsFavorite(value);
      sendFav(value);
    } catch {
      sendFav(isFavoriteRef.current);
      bridgeRef.current.post({
        kind: 'toast',
        text: getString('newMoon.favoriteFailed'),
      });
    }
  }, [novel.path, novel.pluginId, sendFav]);

  // ------------------------------------------------------------- goBack ---
  const goBackToNovel = useCallback(() => {
    allowRemoveRef.current = true;
    flushScrollSave();
    navigation.goBack();
  }, [flushScrollSave, navigation]);

  // -------------------------------------------------- translation (Zeus) ---
  // One controller per mount: it owns prefs, the SQLite memory and the Zeus
  // coordinator, and reaches the shell EXCLUSIVELY through the bridge queue
  // — the frozen-document rules above are untouched.
  const kickPrefetchRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const ctl = new TranslationController();
    ctl.setBridge(msg => {
      bridgeRef.current.post(msg);
    });
    translationCtlRef.current = ctl;
    return () => {
      ctl.dispose();
      if (translationCtlRef.current === ctl) {
        translationCtlRef.current = null;
      }
    };
    // bridgeRef is a stable ref; the controller lives for the whole mount.
  }, []);

  // v3: picking up preference changes made in the settings screen without
  // any WebView reload — the controller re-reads MMKV on every focus.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      translationCtlRef.current?.refreshPrefs();
    });
    return unsubscribe;
  }, [navigation]);

  // Latest-closure re-binding (never during render — react-compiler rule).
  useEffect(() => {
    translationCtlRef.current?.setNavigation(routeName => {
      // 'TranslationSettings' belongs to the translation settings feature;
      // navigate defensively so an unbuilt route can never crash the reader.
      (navigation as unknown as { navigate: (name: string) => void }).navigate(
        routeName,
      );
    });
    translationCtlRef.current?.setOnCompleted(() => {
      if (
        (translationCtlRef.current?.preferences.prefetchNextChapters ?? 0) > 0
      ) {
        void kickPrefetchRef.current();
      }
    });
  });

  useEffect(() => {
    kickPrefetchRef.current = async () => {
      const ctl = translationCtlRef.current;
      if (!ctl) {
        return;
      }
      const count = Math.min(
        2,
        Math.max(0, ctl.preferences.prefetchNextChapters),
      );
      if (count === 0) {
        return;
      }
      const total = orderedRef.current.length;
      for (let step = 1; step <= count; step += 1) {
        const wNum = neighborWNum(currentWNumRef.current, step, total);
        if (wNum === null) {
          return;
        }
        const chap = wNumMapRef.current.get(wNum);
        if (!chap) {
          return;
        }
        let worText = sectionLinesRef.current.get(wNum);
        if (worText === undefined) {
          try {
            const rawHtml = await loadChapterHtml(chap);
            const sanitized = sanitizeChapterText(
              novel.pluginId,
              novel.name,
              chap.name,
              rawHtml,
            );
            worText = buildSection(chap, wNum, sanitized, 1).worText;
          } catch {
            // Prefetch is best-effort — a failed load just ends the chain.
            return;
          }
        }
        ctl.prefetchNext({
          novelId: novel.id,
          chapterId: chap.id,
          wNum,
          lines: worText.split('\n'),
        });
      }
    };
  });

  // ------------------------------------------------- shell → RN dispatch ---
  const handleShellEventRef = useRef<(event: Record<string, unknown>) => void>(
    () => {},
  );

  // Latest-closure assignment happens in an effect (never during render —
  // required for react-compiler correctness).
  useEffect(() => {
    handleShellEventRef.current = event => {
      switch (event.t) {
        case 'ready': {
          bridgeRef.current.markReady();
          sendSettings(settingsRef.current);
          sendChapters();
          sendWords();
          sendFav(isFavoriteRef.current);
          // Engine parity: after flushing the queue, re-send the chapter ONLY
          // if none reached the bridge yet (slow boot ordering); a chapter
          // queued pre-ready is flushed above, and a fresh load in flight will
          // post its own — never duplicate the fetch.
          if (!chapterSentRef.current && !loadingChapterRef.current) {
            rebuildCurrentRef.current();
          }
          // Translation: re-arm config + scope for the (possibly reloaded)
          // document — bridge messages only, never a source change.
          translationCtlRef.current?.onChapterChanged();
          const readyChapter = wNumMapRef.current.get(currentWNumRef.current);
          if (readyChapter) {
            translationCtlRef.current?.setChapterScope(
              novel.id,
              readyChapter.id,
              currentWNumRef.current,
            );
          }
          break;
        }
        case 'scroll': {
          const wNum = Number(event.chapter) || currentWNumRef.current;
          const inOffset =
            event.inOffset != null
              ? Number(event.inOffset)
              : Number(event.offset);
          const ratio = Number(event.ratio) || 0;
          // Continuous mode: the reader has scrolled into an appended section —
          // track it like the engine's currentViewedChapter (drives dock-next
          // section scrolling and non-continuous neighbor navigation).
          viewedWNumRef.current = wNum;
          queueScrollSave(wNum, inOffset, ratio);
          break;
        }
        case 'scrollMetrics': {
          // v3 scroll instrumentation: real frame pacing per gesture, used by
          // the simulator scroll-quality runs and visible in device logs.
          // eslint-disable-next-line no-console
          console.log(
            '[moon-scroll]',
            JSON.stringify({
              frames: event.frames,
              longFrames: event.longFrames,
              maxFrameMs: event.maxFrame,
              avgFrameMs: event.avgFrame,
              durationMs: event.durationMs,
            }),
          );
          break;
        }
        case 'needNext':
          void fetchNextForContinuous();
          break;
        case 'nav': {
          if (event.dir === 'next') {
            const S = settingsRef.current;
            if (S.continuousMode) {
              // Engine parity (WorReader.tsx navigateNextPrev): the anchor is
              // the document's primary chapter, but the lookup index is the
              // section the reader is currently VIEWING.
              const secNums = [currentWNumRef.current, ...appendedRef.current];
              const idx = secNums.indexOf(viewedWNumRef.current);
              const nextSec =
                idx !== -1
                  ? secNums[idx + 1]
                  : appendedRef.current.length > 0
                  ? null
                  : undefined;
              if (nextSec) {
                bridgeRef.current.post({
                  kind: 'scrollToChapter',
                  number: nextSec,
                });
                break;
              }
              if (endReachedRef.current) {
                bridgeRef.current.post({
                  kind: 'toast',
                  text: getString('newMoon.noNextChapter'),
                });
                break;
              }
              // Not appended yet — fetch it, then scroll to it (autoScroll flag,
              // same as the engine's autoScrollNextRef).
              autoScrollNextRef.current = true;
              void fetchNextForContinuous();
              break;
            }
            const next = neighborWNum(
              currentWNumRef.current,
              1,
              orderedRef.current.length,
            );
            if (next === null) {
              bridgeRef.current.post({
                kind: 'toast',
                text: getString('newMoon.noNextChapter'),
              });
            } else {
              void navigateToWNum(next);
            }
          } else if (event.dir === 'prev') {
            const prev = neighborWNum(
              currentWNumRef.current,
              -1,
              orderedRef.current.length,
            );
            if (prev === null) {
              bridgeRef.current.post({
                kind: 'toast',
                text: getString('newMoon.noPreviousChapter'),
              });
            } else {
              void navigateToWNum(prev);
            }
          } else if (event.to === 'novel') {
            goBackToNovel();
          } else if (event.to === 'home') {
            // Drawer «الرئيسية» → the Library tab (app home).
            navigation.navigate('BottomNavigator', { screen: 'Library' });
          } else if (event.to === 'downloads') {
            navigation.navigate('MoreStack', { screen: 'Downloads' });
          } else if (event.to === 'settings') {
            navigation.navigate('MoreStack', {
              screen: 'SettingsStack',
              params: { screen: 'Settings' },
            });
          } else if (event.to === 'about') {
            navigation.navigate('MoreStack', { screen: 'About' });
          }
          // 'contact' was removed from the shell drawer (site-specific, no
          // mobile equivalent); the defensive break below covers any stale
          // shell still sending it.
          break;
        }
        case 'goto':
          if (event.number) {
            void navigateToWNum(Number(event.number));
          }
          break;
        case 'chaptersLoadMore':
          void loadMoreChapters();
          break;
        case 'chaptersSearch':
          searchChapters(String(event.q ?? ''));
          break;
        case 'settings':
          if (event.patch && typeof event.patch === 'object') {
            applySettingsPatch(event.patch as Record<string, unknown>);
          }
          break;
        case 'words':
          void wordsAction(event);
          break;
        case 'wordsOpen':
          sendWords();
          break;
        case 'themeCycle':
          handleThemeCycle();
          break;
        case 'fav':
          void toggleFavorite();
          break;
        case 'dock':
          setDockOpen(!!event.open);
          break;
        case 'exit':
          goBackToNovel();
          break;
        case 'novelPage':
        case 'profile':
          goBackToNovel();
          break;
        case 'comments':
        case 'report':
        case 'tool':
          // UI removed from the shell; handlers stay defensive no-ops.
          break;
        case 'error':
          // Shell-side exception surfaced to the user as a toast by the
          // engine itself; nothing to log in release builds.
          break;
        case 'trDetect':
        case 'trCollect':
        case 'trApplied':
        case 'trRestored':
        case 'trButton':
        case 'trSettings':
          // Translation feature — full handling lives in the controller.
          translationCtlRef.current?.handleShellEvent(
            event as TranslationShellEvent,
          );
          break;
        default:
          break;
      }
    };
  });

  // ----------------------------------------------------- safe-area sync ---
  // The document is frozen, so live safe-area changes (status bar hide/show
  // from dock toggling, rotation, iPadOS stage-manager edges) must reach the
  // shell as a settings patch. The engine's `settings` receive branch merges
  // safeTop/safeBottom into S and applyTheme() rewrites --wor-safe-top/bottom
  // — a pure CSS-variable update with zero document reloads.
  useEffect(() => {
    if (
      insets.top === mountInsets.top &&
      insets.bottom === mountInsets.bottom
    ) {
      return;
    }
    bridgeRef.current.post({
      kind: 'settings',
      settings: { safeTop: insets.top, safeBottom: insets.bottom },
    });
  }, [insets.top, insets.bottom, mountInsets]);

  // ------------------------------------------------ document recovery ---
  /** Full re-handshake after the WebView document died or was reloaded:
   *  invalidates stale work, clears the bridge queue, re-arms the chapter
   *  pipeline and reloads the (frozen) source. Reading position and theme
   *  survive — both live outside the document (MMKV + the shell re-applies
   *  settings from settingsRef on the next `ready`). */
  const recoverDocument = useCallback(() => {
    docEpochRef.current += 1; // stale needNext/append work is dropped
    chapterReqRef.current += 1; // in-flight chapter fetches are dropped
    loadingChapterRef.current = false;
    chapterSentRef.current = false;
    loadingNextRef.current = false;
    endReachedRef.current = false;
    appendedRef.current = [];
    setLoadingNext(false);
    setLoading(true);
    bridgeRef.current.reset();
    webViewRef.current?.reload();
  }, []);

  // WKWebView kills its content process under memory pressure (iPad 7 has
  // ~3GB); without this handler the reader stays a BLACK screen forever.
  const onContentProcessTerminate = useCallback(() => {
    recoverDocument();
  }, [recoverDocument]);

  /** Watchdog: the loading overlay must never trap the reader. If no chapter
   *  pipeline activity is visible after 30s, drop the overlay — the shell
   *  renders whatever it has and the user can tap to retry navigation. */
  useEffect(() => {
    if (!loading) {
      return;
    }
    const timer = setTimeout(() => {
      if (!loadingChapterRef.current) {
        setLoading(false);
      }
    }, 30000);
    return () => clearTimeout(timer);
  }, [loading]);

  // ------------------------------------------------------------- effects ---
  // Boot: chapters + words + the initial chapter.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) {
      return;
    }
    bootRef.current = true;
    void (async () => {
      await loadChapters();
      const store = await loadWordsStore(novel.id, novel.name);
      wordsStoreRef.current = store;
      coloredTermsFor();
      sendWords();
      const wNum =
        [...wNumMapRef.current.entries()].find(
          ([, c]) => c.id === initialChapter.id,
        )?.[0] ?? 1;
      await loadChapter(initialChapter, wNum);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Immersive: the status bar follows the engine's dock state.
  useEffect(() => {
    StatusBar.setHidden(!dockOpen);
    SystemBars.setHidden(!dockOpen);
    return () => {
      StatusBar.setHidden(false);
      SystemBars.setHidden(false);
    };
  }, [dockOpen]);

  // Android hardware back + iOS edge swipe both route through the shell so an
  // open overlay (chapters sheet / words sheet / search / drawer) closes
  // first; the shell emits exit{} otherwise.
  useBackHandler(
    useCallback(() => {
      bridgeRef.current.post({ kind: 'backPress' });
      return true;
    }, []),
  );

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', e => {
      flushScrollSave();
      if (allowRemoveRef.current) {
        allowRemoveRef.current = false;
        return;
      }
      e.preventDefault();
      bridgeRef.current.post({ kind: 'backPress' });
    });
    return unsubscribe;
  }, [flushScrollSave, navigation]);

  // Flush the very last position when leaving the reader.
  useEffect(
    () => () => {
      if (scrollSaveTimer.current) {
        clearTimeout(scrollSaveTimer.current);
      }
      const last = lastScrollRef.current;
      if (last && !incognitoMode) {
        const chap = wNumMapRef.current.get(last.wNum);
        if (chap) {
          saveScrollOffset(novel.id, chap.id, last.inOffset);
          saveLastPosition(novel.id, chap.id, last.wNum, last.inOffset);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --------------------------------------------------------- webview io ---
  const handleOnMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const parsed = parseShellEvent(event.nativeEvent?.data);
      if (parsed) {
        handleShellEventRef.current(parsed);
      }
    },
    [],
  );

  // A load that begins while the bridge was already ready is a REAL document
  // reload (content-process kill recovery, system OOM reload…). Reset the
  // handshake so buffered commands are never injected into a half-booted
  // document. The FIRST load start (bridge not ready yet) is the normal boot
  // and must keep its buffered boot messages.
  const handleLoadStart = useCallback(() => {
    if (bridgeRef.current.isReady()) {
      recoverDocument();
    }
  }, [recoverDocument]);

  // ------------------------------------------------------------- render ---
  const webViewBackground = useMemo(
    () => (isLightColor(initialSettings.bgColor) ? '#f3efe7' : '#000000'),
    [initialSettings],
  );

  const shellSource = useMemo(
    () => ({ baseUrl: assetsUriPrefix, html: shellHtml }),
    [assetsUriPrefix, shellHtml],
  );

  return (
    <View
      style={[styles.container, { backgroundColor: shellTheme.background }]}
    >
      <WebView
        ref={webViewRef}
        source={shellSource}
        style={{ backgroundColor: webViewBackground }}
        decelerationRate="normal"
        originWhitelist={['*']}
        mixedContentMode="always"
        domStorageEnabled
        allowFileAccess
        onMessage={handleOnMessage}
        onLoadStart={handleLoadStart}
        // iOS: WKWebView content process was killed (memory pressure) — the
        // view would otherwise stay a black screen forever. Android: render
        // process gone. Both recover through the full re-handshake.
        onContentProcessDidTerminate={onContentProcessTerminate}
        onRenderProcessGone={onContentProcessTerminate}
      />

      {scrollProbe.probe}
      {/* Engine 'keepAwake' switch → native wake lock (same as classic). */}
      {keepAwake ? <KeepScreenAwake /> : null}

      {loading ? (
        <View
          style={[styles.overlay, { backgroundColor: shellTheme.background }]}
          pointerEvents="auto"
        >
          <ActivityIndicator size="large" color={shellTheme.foreground} />
        </View>
      ) : null}

      {loadingNext ? (
        <View style={styles.loadingNext} pointerEvents="none">
          <Text style={styles.loadingNextText}>
            {getString('newMoon.loadingNext')}
          </Text>
        </View>
      ) : null}

      {dockOpen ? (
        <View
          style={[
            styles.nativeBar,
            {
              backgroundColor: shellTheme.background,
              paddingTop: insets.top,
              borderBottomColor: shellTheme.foreground + '22',
            },
          ]}
        >
          <IconButtonV2
            name="arrow-left"
            size={22}
            color={shellTheme.foreground}
            theme={theme}
            padding={6}
            onPress={goBackToNovel}
            accessibilityLabel={getString('newMoon.novelDetails')}
          />
          <Text
            numberOfLines={1}
            style={[styles.barTitle, { color: shellTheme.foreground }]}
          >
            {chapterTitle}
          </Text>
          <IconButtonV2
            name={ttsPlaying ? 'stop-circle-outline' : 'play-circle-outline'}
            size={22}
            color={shellTheme.foreground}
            theme={theme}
            padding={6}
            onPress={toggleTts}
            accessibilityLabel={getString(
              ttsPlaying ? 'newMoon.ttsStop' : 'newMoon.ttsPlay',
            )}
          />
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  overlay: {
    // RN 0.86 types dropped StyleSheet.absoluteFillObject — spell it out.
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  loadingNext: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 20,
  },
  loadingNextText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  nativeBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 30,
  },
  barTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default NewMoonReaderScreen;
