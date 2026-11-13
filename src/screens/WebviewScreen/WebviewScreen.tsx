import { useWebViewScrollProbe } from '../../testing/useWebViewScrollProbe';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { WebViewNavigation } from 'react-native-webview';
import type { WebViewProgressEvent } from 'react-native-webview/lib/WebViewTypes';
import { ProgressBar } from 'react-native-paper';

import { IconButtonV2 } from '@components';
import { getPlugin } from '@plugins/pluginManager';
import { useBackHandler } from '@hooks';
import { useTheme } from '@hooks/persisted';
import { WebviewScreenProps } from '@navigators/types';
import { getUserAgent } from '@hooks/persisted/useUserAgent';
import { loadPreferences } from '@services/translation';
import { resolveUrl } from '@services/plugin/fetch';
import {
  WEBVIEW_LOCAL_STORAGE,
  WEBVIEW_SESSION_STORAGE,
  store,
} from '@plugins/helpers/storage';
import Appbar from './components/Appbar';
import Menu from './components/Menu';
import {
  INITIAL_PAGE_TRANSLATION_STATE,
  PageTranslationController,
  type PageTranslationEvent,
  type PageTranslationState,
} from './pageTranslationController';
import { PAGE_TRANSLATION_JS } from './pageTranslation';

type StorageData = {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
};

// Mirrors NewMoonBridge.toInjectableLiteral: JSON.stringify output IS a valid
// JS object literal except U+2028/U+2029, which are literal line terminators
// inside an injected script and would split the command.
const toInjectableLiteral = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const WebviewScreen = ({ route, navigation }: WebviewScreenProps) => {
  const { name, url, pluginId, isNovel } = route.params;
  const isSave = getPlugin(pluginId)?.webStorageUtilized;
  const uri = useMemo(
    () => resolveUrl(pluginId, url, isNovel),
    [isNovel, pluginId, url],
  );
  const userAgent = useMemo(() => getUserAgent(), []);

  const theme = useTheme();
  const scrollProbe = useWebViewScrollProbe();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView<object> | null>(null);

  const [progress, setProgress] = useState(0);
  const [title, setTitle] = useState(name || '');
  const [currentUrl, setCurrentUrl] = useState(uri);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [tempData, setTempData] = useState<StorageData>();
  const [menuVisible, setMenuVisible] = useState(false);
  const [translation, setTranslation] = useState<PageTranslationState>(
    INITIAL_PAGE_TRANSLATION_STATE,
  );

  const currentUrlRef = useRef(uri);
  const translationRef = useRef<PageTranslationController | null>(null);

  // One controller per mount (same pattern as the reader's
  // TranslationController): it owns the page-translation state machine and
  // reaches the WebView exclusively through injectJavaScript.
  useEffect(() => {
    const controller = new PageTranslationController({
      inject: command => {
        webViewRef.current?.injectJavaScript(
          `window.__moonTrReceive && window.__moonTrReceive(${toInjectableLiteral(
            command,
          )}); true;`,
        );
      },
      url: () => currentUrlRef.current,
      prefs: () => loadPreferences(),
      onState: setTranslation,
    });
    translationRef.current = controller;
    return () => {
      controller.dispose();
      if (translationRef.current === controller) {
        translationRef.current = null;
      }
    };
    // webViewRef/currentUrlRef are stable refs; the controller lives for the
    // whole mount.
  }, []);

  const handleNavigation = (e: WebViewNavigation) => {
    if (!e.loading) {
      setTitle(e.title);
    }
    setCurrentUrl(e.url);
    currentUrlRef.current = e.url;
    translationRef.current?.onNavigation(e.url);
    setCanGoBack(e.canGoBack);
    setCanGoForward(e.canGoForward);
  };

  const handleLoadProgress = useCallback(
    ({ nativeEvent }: WebViewProgressEvent) => {
      const next = nativeEvent.progress;
      // Progress is reported continuously: re-rendering the screen (and with
      // it the WebView element) for sub-percent changes is wasted work.
      setProgress(current =>
        next === 1 || Math.abs(next - current) >= 0.05 ? next : current,
      );
    },
    [],
  );

  // The page translator posts enveloped messages ({__moonTr: 1, …}) — routed
  // to the controller FIRST. Every other message keeps the original raw
  // web-storage dump behavior untouched.
  const handleMessage = ({
    nativeEvent,
  }: {
    nativeEvent: { data: string };
  }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(nativeEvent.data);
    } catch {
      return;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).__moonTr === 1
    ) {
      translationRef.current?.handleEvent(parsed as PageTranslationEvent);
      return;
    }
    setTempData(parsed as StorageData);
  };

  const saveData = () => {
    if (pluginId && tempData && isSave) {
      store.set(
        pluginId + WEBVIEW_LOCAL_STORAGE,
        JSON.stringify(tempData?.localStorage || {}),
      );
      store.set(
        pluginId + WEBVIEW_SESSION_STORAGE,
        JSON.stringify(tempData?.sessionStorage || {}),
      );
    }
  };

  useBackHandler(() => {
    if (menuVisible) {
      setMenuVisible(false);
      return true;
    }
    if (canGoBack) {
      webViewRef.current?.goBack();
      return true;
    }
    saveData();
    return false;
  });

  const injectJavaScriptCode =
    'window.ReactNativeWebView.postMessage(JSON.stringify({localStorage, sessionStorage}))';

  // The storage dump script with the page-translator installer appended to
  // the SAME injected script. The installer is idempotent (guarded by
  // __moonPageTranslate) and only registers listeners.
  const injectedJavaScript = `${injectJavaScriptCode};(${PAGE_TRANSLATION_JS})();`;

  // A new `source` reloads the page, so keep it stable across progress updates.
  const source = useMemo(() => ({ uri }), [uri]);

  return (
    <>
      <Appbar
        title={title}
        currentUrl={currentUrl}
        theme={theme}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        webView={webViewRef}
        setMenuVisible={setMenuVisible}
        goBack={() => {
          saveData();
          navigation.goBack();
        }}
      />
      <ProgressBar
        color={theme.primary}
        progress={Math.round(1000 * progress) / 1000}
        visible={progress !== 1}
      />
      <WebView<object>
        userAgent={userAgent}
        ref={webViewRef}
        source={source}
        decelerationRate="normal"
        setDisplayZoomControls={true}
        setBuiltInZoomControls={false}
        setSupportMultipleWindows={false}
        injectedJavaScript={injectedJavaScript}
        onNavigationStateChange={handleNavigation}
        onLoadProgress={handleLoadProgress}
        onMessage={handleMessage}
      />
      {scrollProbe.probe}
      {translation.running && translation.error === null ? (
        <View
          style={[
            styles.translationChip,
            { backgroundColor: theme.surface2, top: insets.top + 68 },
          ]}
        >
          <Text style={{ color: theme.onSurface }}>
            {`جارٍ الترجمة… ${translation.completed}`}
          </Text>
        </View>
      ) : null}
      {translation.error !== null ? (
        <View
          style={[
            styles.translationBanner,
            { backgroundColor: theme.surface2, bottom: insets.bottom + 12 },
          ]}
        >
          <Text
            numberOfLines={3}
            style={[styles.translationError, { color: theme.error }]}
          >
            {translation.error}
          </Text>
          <Pressable onPress={() => translationRef.current?.resume()}>
            <Text style={{ color: theme.primary }}>متابعة</Text>
          </Pressable>
        </View>
      ) : null}
      {menuVisible ? (
        <Menu
          theme={theme}
          currentUrl={currentUrl}
          webView={webViewRef}
          setMenuVisible={setMenuVisible}
        />
      ) : null}
      {menuVisible ? (
        <Pressable
          style={styles.translationScrim}
          onPress={() => setMenuVisible(false)}
        >
          <View
            style={[
              styles.translationMenu,
              { backgroundColor: theme.surface2, bottom: insets.bottom + 16 },
            ]}
          >
            <Pressable
              style={styles.translationMenuItem}
              onPress={() => {
                setMenuVisible(false);
                translationRef.current?.start();
              }}
            >
              <IconButtonV2
                name="translate"
                color={theme.onSurface}
                padding={4}
                theme={theme}
              />
              <Text style={{ color: theme.onSurface }}>ترجمة الصفحة</Text>
            </Pressable>
            {translation.translated ? (
              <Pressable
                style={styles.translationMenuItem}
                onPress={() => {
                  setMenuVisible(false);
                  translationRef.current?.restore();
                }}
              >
                <IconButtonV2
                  name="restore"
                  color={theme.onSurface}
                  padding={4}
                  theme={theme}
                />
                <Text style={{ color: theme.onSurface }}>إظهار الأصل</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      ) : null}
      <Modal
        visible={translation.offered}
        transparent
        animationType="slide"
        onRequestClose={() => translationRef.current?.dismissOffer()}
      >
        <Pressable
          style={styles.offerScrim}
          onPress={() => translationRef.current?.dismissOffer()}
        >
          <Pressable
            style={[styles.offerCard, { backgroundColor: theme.surface }]}
          >
            <View style={styles.offerHeader}>
              <Text style={[styles.offerTitle, { color: theme.onSurface }]}>
                ترجمة الصفحة إلى العربية؟
              </Text>
              <IconButtonV2
                name="close"
                color={theme.onSurfaceVariant}
                onPress={() => translationRef.current?.dismissOffer()}
                padding={8}
                theme={theme}
              />
            </View>
            <Text style={[styles.offerHint, { color: theme.onSurfaceVariant }]}>
              تم اكتشاف محتوى غير عربي في هذه الصفحة.
            </Text>
            <Pressable
              style={[styles.offerButton, { backgroundColor: theme.primary }]}
              onPress={() => translationRef.current?.start()}
            >
              <Text style={{ color: theme.onPrimary }}>ترجمة</Text>
            </Pressable>
            <Pressable
              style={styles.offerSecondaryButton}
              onPress={() => translationRef.current?.excludeHost()}
            >
              <Text style={{ color: theme.onSurfaceVariant }}>
                عدم الترجمة لهذا الموقع
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

export default WebviewScreen;

const styles = StyleSheet.create({
  offerButton: {
    alignItems: 'center',
    borderRadius: 12,
    paddingVertical: 12,
  },
  offerCard: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 4,
    gap: 10,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  offerHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  offerHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  offerScrim: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  offerSecondaryButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  offerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  translationBanner: {
    alignItems: 'center',
    borderRadius: 12,
    elevation: 4,
    flexDirection: 'row',
    gap: 12,
    left: 12,
    padding: 12,
    position: 'absolute',
    right: 12,
  },
  translationChip: {
    alignSelf: 'center',
    borderRadius: 16,
    elevation: 3,
    paddingHorizontal: 12,
    paddingVertical: 6,
    position: 'absolute',
  },
  translationError: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  translationMenuItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  translationMenu: {
    borderRadius: 12,
    elevation: 4,
    overflow: 'hidden',
    position: 'absolute',
    right: 12,
  },
  translationScrim: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
