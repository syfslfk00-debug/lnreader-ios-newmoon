import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import NativeFile from '@modules/native-file';
import { dbManager } from '@database/db';
import { novelSchema, chapterSchema } from '@database/schema';
import type { ChapterInfo, NovelInfo } from '@database/types';
import type {
  ReaderStackParamList,
  RootStackParamList,
} from '@navigators/types';
import NewMoonReaderScreen from '@screens/reader/newmoon/NewMoonReaderScreen';
import WebviewScreen from '@screens/WebviewScreen/WebviewScreen';
import { DEFAULT_SETTINGS } from '../reader/newmoon/sections';
import {
  clearScrollFor,
  saveWorSettingsPatch,
} from '@screens/reader/newmoon/NewMoonAdapter';
import { DEFAULT_TRANSLATION_PREFERENCES } from '@services/translation/types';
import { savePreferences } from '@services/translation/prefs';
import { NOVEL_STORAGE } from '@utils/Storages';

const Reader = createNativeStackNavigator<ReaderStackParamList>();
const Browser = createNativeStackNavigator<RootStackParamList>();
const PLUGIN = '__moon_e2e_local__';
const content = Array.from(
  { length: 600 },
  (_, i) =>
    `<p>Paragraph ${i}. The moon rose above the hills. [نص عربي لاختبار التمرير وتنسيق الأقواس.]</p>`,
).join('');

/** Entry is guarded by a simulator-only native constant, including Release CI. */
export default function IOSWebViewFixtures({ mode }: { mode: string }) {
  const [fixture, setFixture] = useState<{
    novel: NovelInfo;
    chapter: ChapterInfo;
    url: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      savePreferences({ ...DEFAULT_TRANSLATION_PREFERENCES });
      saveWorSettingsPatch({
        ...DEFAULT_SETTINGS,
        dockOpen: false,
        tapToToggle: false,
      });
      const novel = await dbManager.write(async tx =>
        tx
          .insert(novelSchema)
          .values({
            path: '/e2e',
            pluginId: PLUGIN,
            name: 'Moon scroll fixture',
            isLocal: true,
            inLibrary: true,
          })
          .onConflictDoUpdate({
            target: [novelSchema.path, novelSchema.pluginId],
            set: { name: 'Moon scroll fixture' },
          })
          .returning()
          .get(),
      );
      if (!novel) throw new Error('Fixture novel was not inserted');
      const chapters: ChapterInfo[] = [];
      for (let index = 1; index <= 3; index++) {
        const chapter = await dbManager.write(async tx =>
          tx
            .insert(chapterSchema)
            .values({
              novelId: novel.id,
              path: `/e2e/${index}`,
              name: `Fixture chapter ${index}`,
              position: index,
              isDownloaded: true,
            })
            .onConflictDoUpdate({
              target: [chapterSchema.novelId, chapterSchema.path],
              set: { progress: 0, unread: true, isDownloaded: true },
            })
            .returning()
            .get(),
        );
        if (!chapter) throw new Error('Fixture chapter was not inserted');
        const directory = `${NOVEL_STORAGE}/${PLUGIN}/${novel.id}/${chapter.id}`;
        await NativeFile.mkdir(directory);
        await NativeFile.writeFile(`${directory}/index.html`, content);
        clearScrollFor(novel.id, chapter.id);
        chapters.push(chapter);
      }
      const file = `${NativeFile.DocumentDirectoryPath}/moon-e2e-browser.html`;
      await NativeFile.writeFile(
        file,
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:20px sans-serif;line-height:2;padding:16px}</style></head><body>${content}</body></html>`,
      );
      if (active) {
        setFixture({ novel, chapter: chapters[0], url: 'file://' + file });
      }
    };
    void prepare().catch(value => {
      if (active) setError(String(value));
    });
    return () => {
      active = false;
    };
  }, []);
  if (error) return <Text testID="moon-fixture-error">{error}</Text>;
  if (!fixture) return <Text>Preparing local fixture…</Text>;
  if (mode === 'browser') {
    return (
      <NavigationContainer>
        <Browser.Navigator screenOptions={{ headerShown: false }}>
          <Browser.Screen
            name="WebviewScreen"
            component={WebviewScreen}
            initialParams={{
              name: 'Moon browser fixture',
              url: fixture.url,
              pluginId: PLUGIN,
            }}
          />
        </Browser.Navigator>
      </NavigationContainer>
    );
  }
  return (
    <NavigationContainer>
      <Reader.Navigator screenOptions={{ headerShown: false }}>
        <Reader.Screen
          name="Chapter"
          component={NewMoonReaderScreen}
          initialParams={{ novel: fixture.novel, chapter: fixture.chapter }}
        />
      </Reader.Navigator>
    </NavigationContainer>
  );
}
