// lnreader-ios/src/screens/settings/SettingsStorageScreen/index.tsx
//
// «البيانات والتخزين» — a REAL storage manager:
//  • device capacity vs. app-container usage, measured natively (never guessed)
//  • a proportional breakdown of every measurable category
//  • per-novel downloaded sizes with real deletion (files + SQLite flags)
//  • explicit errors and real freed-bytes feedback — no fake success
//  • personal data (library/progress/settings/cookies) is never deletable here

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons';

import { Appbar, ConfirmationDialog, SafeAreaView } from '@components/index';
import { useTheme } from '@hooks/persisted';
import { getString } from '@i18n/translations';
import { showToast } from '@utils/showToast';
import { ThemeColors } from '@theme/types';
import type { StringMap } from '@i18n/types';

import {
  TranslationMemory,
  createSqliteMemoryDriver,
  type MemoryNovelStats,
} from '@services/translation';
import { getNovelNamesByIds } from '@database/queries/NovelQueries';

import {
  deleteNovelChapters,
  deleteStorageCategory,
  getNovelStorageBreakdown,
  getStorageOverview,
  type NovelStorageEntry,
  type StorageCategory,
  type StorageCategoryId,
  type StorageOverview,
} from '@services/storage/storageService';

// ------------------------------------------------------------- format ---
export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes < 1024) {
    return '0 MB';
  }
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
};

export const CATEGORY_META: Record<
  StorageCategoryId,
  { icon: string; color: (t: ThemeColors) => string }
> = {
  downloads: { icon: 'download-outline', color: t => t.primary },
  plugins: { icon: 'puzzle-outline', color: t => t.tertiary ?? t.primary },
  images: {
    icon: 'image-multiple-outline',
    color: t => t.secondary ?? t.primary,
  },
  backups: { icon: 'backup-restore', color: t => t.primaryContainer },
  webview: { icon: 'web', color: t => t.outline },
  crashLogs: { icon: 'bug-outline', color: t => t.error ?? t.outline },
  caches: { icon: 'cached', color: t => t.outlineVariant ?? t.outline },
  databases: { icon: 'database-outline', color: t => t.onSurfaceVariant },
  translations: { icon: 'translate', color: t => t.primary },
  temp: { icon: 'folder-clock-outline', color: t => t.outline },
};

// --------------------------------------------------- saved translations ---
type TranslationRow = MemoryNovelStats & { name: string };

const META_REF_PREFIX = 'meta:';
const MAX_TRANSLATION_ROWS = 50;

/** `meta:{pluginId}:{novelPath}` identities render as-is without the prefix. */
const translationRowName = (
  novelId: string,
  dbNames: Map<string, string>,
): string =>
  novelId.startsWith(META_REF_PREFIX)
    ? novelId.slice(META_REF_PREFIX.length)
    : dbNames.get(novelId) ?? novelId;

const SettingsStorageScreen = () => {
  const navigation = useNavigation();
  const theme = useTheme();

  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [novels, setNovels] = useState<NovelStorageEntry[]>([]);
  const [orphanBytes, setOrphanBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<StorageCategoryId | number | null>(null);

  const [categoryToDelete, setCategoryToDelete] =
    useState<StorageCategory | null>(null);
  const [novelToDelete, setNovelToDelete] = useState<NovelStorageEntry | null>(
    null,
  );

  const [translationRows, setTranslationRows] = useState<TranslationRow[]>([]);
  const [translationBusy, setTranslationBusy] = useState<string | null>(null);
  const [translationToDelete, setTranslationToDelete] =
    useState<TranslationRow | null>(null);
  const memoryRef = useRef<TranslationMemory | null>(null);

  const measure = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, bd] = await Promise.all([
        getStorageOverview(),
        getNovelStorageBreakdown(),
      ]);
      setOverview(ov);
      setNovels(bd.novels);
      setOrphanBytes(bd.orphanBytes);
    } catch (e) {
      showToast(
        getString('storage.measureFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void measure();
  }, [measure]);

  // Saved-translations breakdown: lazy TranslationMemory instance (same
  // pattern as the translation settings screen), names resolved in one batch.
  const refreshTranslations = useCallback(async () => {
    const memory = memoryRef.current;
    if (!memory) {
      return;
    }
    try {
      await memory.initialize();
      const stats = await memory.statsByNovel();
      const dbIds = stats
        .map(row => Number(row.novelId))
        .filter(id => Number.isInteger(id) && id > 0);
      const pairs = await getNovelNamesByIds(dbIds).catch(() => []);
      const dbNames = new Map(pairs.map(p => [String(p.id), p.name]));
      setTranslationRows(
        stats.map(row => ({
          ...row,
          name: translationRowName(row.novelId, dbNames),
        })),
      );
    } catch {
      setTranslationRows([]);
    }
  }, []);

  useEffect(() => {
    memoryRef.current = new TranslationMemory(createSqliteMemoryDriver());
    void refreshTranslations();
  }, [refreshTranslations]);

  const rebuildable = useMemo(
    () => overview?.categories.filter(c => c.rebuildable && !c.logical) ?? [],
    [overview],
  );
  const totalRebuildable = useMemo(
    () => rebuildable.reduce((sum, c) => sum + c.bytes, 0),
    [rebuildable],
  );

  const deviceUsed = overview
    ? Math.max(0, overview.deviceTotalBytes - overview.deviceFreeBytes)
    : 0;

  const handleDeleteCategory = useCallback(async () => {
    if (!categoryToDelete) {
      return;
    }
    const id = categoryToDelete.id;
    const expected = categoryToDelete.bytes;
    setBusy(id);
    setCategoryToDelete(null);
    try {
      const { freedBytes, errors } = await deleteStorageCategory(id);
      if (errors.length) {
        showToast(
          getString('storage.deletePartial', {
            freed: formatBytes(freedBytes),
            errors: errors.slice(0, 2).join(' · '),
          }),
        );
      } else {
        showToast(
          getString('storage.deleted', { freed: formatBytes(freedBytes) }),
        );
      }
      void expected; // real freed bytes are always reported, not the estimate
    } catch (e) {
      showToast(
        getString('storage.deleteFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(null);
      void measure();
    }
  }, [categoryToDelete, measure]);

  const handleDeleteNovelChapters = useCallback(async () => {
    if (!novelToDelete) {
      return;
    }
    const target = novelToDelete;
    setBusy(target.novelId);
    setNovelToDelete(null);
    try {
      const { freedBytes, errors } = await deleteNovelChapters(
        { id: target.novelId, pluginId: target.pluginId },
        target.bytes,
      );
      if (errors.length) {
        showToast(getString('storage.novelDeleteIncomplete'));
      } else {
        showToast(
          getString('storage.deleted', { freed: formatBytes(freedBytes) }),
        );
      }
    } catch (e) {
      showToast(
        getString('storage.deleteFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(null);
      void measure();
    }
  }, [measure, novelToDelete]);

  const handleDeleteTranslation = useCallback(async () => {
    if (!translationToDelete) {
      return;
    }
    const target = translationToDelete;
    setTranslationBusy(target.novelId);
    setTranslationToDelete(null);
    try {
      await memoryRef.current?.removeNovel(target.novelId);
      showToast(getString('translationsStorage.deleted'));
    } catch (e) {
      showToast(
        getString('storage.deleteFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setTranslationBusy(null);
      // Refresh BOTH views: the rows above and the 'translations' category.
      void refreshTranslations();
      void measure();
    }
  }, [measure, refreshTranslations, translationToDelete]);

  const renderCategory = (category: StorageCategory) => {
    const meta = CATEGORY_META[category.id];
    return (
      <View
        key={category.id}
        style={[
          styles.categoryRow,
          { backgroundColor: theme.surfaceContainerLow ?? theme.surface },
        ]}
      >
        <View
          style={[
            styles.categoryIcon,
            { backgroundColor: meta.color(theme) + '22' },
          ]}
        >
          <MaterialCommunityIcons
            name={meta.icon as never}
            size={20}
            color={meta.color(theme)}
          />
        </View>
        <View style={styles.categoryText}>
          <Text style={[styles.categoryName, { color: theme.onSurface }]}>
            {getString(
              `storage.category.${category.id}` as Extract<
                keyof StringMap,
                `storage.category.${StorageCategoryId}`
              >,
            )}
          </Text>
          <Text
            style={[styles.categorySize, { color: theme.onSurfaceVariant }]}
          >
            {formatBytes(category.bytes)}
            {category.files > 0
              ? `  ·  ${category.files} ${getString('storage.files')}`
              : ''}
            {category.note ? `  ·  ${category.note}` : ''}
          </Text>
        </View>
        {category.deletable ? (
          <MaterialCommunityIcons
            name={busy === category.id ? 'loading' : 'delete-outline'}
            size={22}
            color={theme.onSurfaceVariant}
            onPress={() => setCategoryToDelete(category)}
            accessibilityRole="button"
            accessibilityLabel={getString('storage.delete')}
            style={styles.deleteIcon}
          />
        ) : (
          <MaterialCommunityIcons
            name="lock-outline"
            size={18}
            color={theme.onSurfaceVariant}
            style={styles.deleteIcon}
          />
        )}
      </View>
    );
  };

  return (
    <SafeAreaView excludeTop style={styles.container}>
      <Appbar
        mode="small"
        title={getString('storage.title')}
        handleGoBack={navigation.goBack}
        theme={theme}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={measure}
            tintColor={theme.primary}
          />
        }
      >
        {/* Device overview */}
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surfaceContainerLow ?? theme.surface },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.onSurface }]}>
            {getString('storage.device')}
          </Text>
          <View style={styles.deviceBar}>
            <View
              style={[
                styles.deviceBarSegment,
                {
                  backgroundColor: theme.primary,
                  flex: Math.max(deviceUsed, 1),
                },
              ]}
            />
            <View
              style={[
                styles.deviceBarSegment,
                {
                  backgroundColor: theme.surfaceVariant,
                  flex: Math.max(overview?.deviceFreeBytes ?? 1, 1),
                },
              ]}
            />
          </View>
          <View style={styles.deviceLegend}>
            <Text style={{ color: theme.onSurfaceVariant, fontSize: 12 }}>
              {getString('storage.used')}: {formatBytes(deviceUsed)}
            </Text>
            <Text style={{ color: theme.onSurfaceVariant, fontSize: 12 }}>
              {getString('storage.free')}:{' '}
              {formatBytes(overview?.deviceFreeBytes ?? 0)}
            </Text>
            <Text style={{ color: theme.onSurfaceVariant, fontSize: 12 }}>
              {getString('storage.total')}:{' '}
              {formatBytes(overview?.deviceTotalBytes ?? 0)}
            </Text>
          </View>
          <Text style={[styles.appDataLine, { color: theme.onSurface }]}>
            {getString('storage.appData')}:{' '}
            {formatBytes(overview?.containerBytes ?? 0)}
          </Text>
        </View>

        {/* Rebuildable breakdown chart */}
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surfaceContainerLow ?? theme.surface },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.onSurface }]}>
            {getString('storage.breakdown')}
          </Text>
          {rebuildable.length ? (
            <View style={styles.stackBar}>
              {rebuildable.map(category => {
                const meta = CATEGORY_META[category.id];
                const flex = Math.max(
                  category.bytes,
                  totalRebuildable > 0 ? totalRebuildable * 0.004 : 1,
                );
                return (
                  <View
                    key={category.id}
                    style={{ flex, backgroundColor: meta.color(theme) }}
                  />
                );
              })}
            </View>
          ) : null}
        </View>

        {/* Categories */}
        {overview?.categories.map(renderCategory)}

        {/* Saved translations (translation memory) */}
        <Text style={[styles.sectionTitle, { color: theme.onSurface }]}>
          {getString('translationsStorage.title')}
        </Text>
        <View style={styles.novelsList}>
          {translationRows.length ? (
            translationRows.slice(0, MAX_TRANSLATION_ROWS).map(row => (
              <View
                key={row.novelId}
                style={[
                  styles.novelRow,
                  {
                    backgroundColor: theme.surfaceContainerLow ?? theme.surface,
                  },
                ]}
              >
                <View style={styles.novelText}>
                  <Text
                    numberOfLines={1}
                    style={[styles.novelTitle, { color: theme.onSurface }]}
                  >
                    {row.name}
                  </Text>
                  <Text
                    style={{
                      color: theme.onSurfaceVariant,
                      fontSize: 12,
                    }}
                  >
                    {getString('translationsStorage.entries', {
                      count: row.count,
                    })}
                    {' · '}
                    {getString('translationsStorage.size', {
                      mb: (row.bytes / 1048576).toFixed(1),
                    })}
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name={
                    translationBusy === row.novelId
                      ? 'loading'
                      : 'delete-outline'
                  }
                  size={22}
                  color={theme.error ?? theme.onSurfaceVariant}
                  onPress={() => setTranslationToDelete(row)}
                  accessibilityRole="button"
                  accessibilityLabel={getString(
                    'translationsStorage.deleteTitle',
                  )}
                />
              </View>
            ))
          ) : (
            <Text style={{ color: theme.onSurfaceVariant, padding: 12 }}>
              {getString('translationsStorage.empty')}
            </Text>
          )}
        </View>
        <Text style={[styles.orphanNote, { color: theme.onSurfaceVariant }]}>
          {getString('translationsStorage.note')}
        </Text>

        {/* Per-novel downloads */}
        <Text style={[styles.sectionTitle, { color: theme.onSurface }]}>
          {getString('storage.novelsSection')}
        </Text>
        <View style={styles.novelsList}>
          {novels.length ? (
            novels.map(novel => (
              <View
                key={`${novel.pluginId}-${novel.novelId}`}
                style={[
                  styles.novelRow,
                  {
                    backgroundColor: theme.surfaceContainerLow ?? theme.surface,
                  },
                ]}
              >
                <View style={styles.novelText}>
                  <Text
                    numberOfLines={1}
                    style={[styles.novelTitle, { color: theme.onSurface }]}
                  >
                    {novel.title}
                  </Text>
                  <Text style={{ color: theme.onSurfaceVariant, fontSize: 12 }}>
                    {formatBytes(novel.bytes)} · {novel.fileCount}{' '}
                    {getString('storage.files')}
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name={busy === novel.novelId ? 'loading' : 'delete-outline'}
                  size={22}
                  color={theme.error ?? theme.onSurfaceVariant}
                  onPress={() => setNovelToDelete(novel)}
                  accessibilityRole="button"
                  accessibilityLabel={getString('storage.deleteNovelChapters')}
                />
              </View>
            ))
          ) : (
            <Text style={{ color: theme.onSurfaceVariant, padding: 12 }}>
              {getString('storage.noNovelData')}
            </Text>
          )}
        </View>
        {orphanBytes > 0 ? (
          <Text style={[styles.orphanNote, { color: theme.onSurfaceVariant }]}>
            {getString('storage.orphans', { size: formatBytes(orphanBytes) })}
          </Text>
        ) : null}

        <Text style={[styles.disclaimer, { color: theme.onSurfaceVariant }]}>
          {getString('storage.disclaimer')}
        </Text>
      </ScrollView>

      {/* Delete category confirmation */}
      <ConfirmationDialog
        visible={!!categoryToDelete}
        title={getString('storage.confirmDeleteTitle')}
        message={
          categoryToDelete
            ? getString('storage.confirmDeleteCategory', {
                name: getString(
                  `storage.category.${categoryToDelete.id}` as Extract<
                    keyof StringMap,
                    `storage.category.${StorageCategoryId}`
                  >,
                ),
                size: formatBytes(categoryToDelete.bytes),
              })
            : ''
        }
        confirmLabel={getString('storage.delete')}
        onConfirm={handleDeleteCategory}
        onDismiss={() => setCategoryToDelete(null)}
      />

      {/* Delete novel chapters confirmation */}
      <ConfirmationDialog
        visible={!!novelToDelete}
        title={getString('storage.confirmDeleteTitle')}
        message={
          novelToDelete
            ? getString('storage.confirmDeleteNovel', {
                name: novelToDelete.title,
                size: formatBytes(novelToDelete.bytes),
              })
            : ''
        }
        confirmLabel={getString('storage.delete')}
        onConfirm={handleDeleteNovelChapters}
        onDismiss={() => setNovelToDelete(null)}
      />

      {/* Delete saved translations confirmation */}
      <ConfirmationDialog
        visible={!!translationToDelete}
        title={getString('translationsStorage.deleteTitle')}
        message={
          translationToDelete
            ? `${translationToDelete.name}\n\n${getString(
                'translationsStorage.deleteMessage',
              )}`
            : ''
        }
        confirmLabel={getString('storage.delete')}
        onConfirm={handleDeleteTranslation}
        onDismiss={() => setTranslationToDelete(null)}
      />
    </SafeAreaView>
  );
};

export default SettingsStorageScreen;

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  card: { borderRadius: 16, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: '800', marginBottom: 10 },
  deviceBar: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
  },
  deviceBarSegment: {},
  deviceLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    flexWrap: 'wrap',
    gap: 4,
  },
  appDataLine: { marginTop: 10, fontSize: 13, fontWeight: '700' },
  stackBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    marginTop: 8,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 12,
    gap: 12,
  },
  categoryIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryText: { flex: 1 },
  categoryName: { fontSize: 14, fontWeight: '700' },
  categorySize: { fontSize: 12, marginTop: 2 },
  deleteIcon: { padding: 8 },
  novelsList: { gap: 8, maxHeight: 384 },
  novelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  novelText: { flex: 1 },
  novelTitle: { fontSize: 14, fontWeight: '700' },
  orphanNote: { fontSize: 12, paddingHorizontal: 4 },
  disclaimer: { fontSize: 11, lineHeight: 16, paddingHorizontal: 4 },
});
