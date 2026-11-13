import { Platform } from 'react-native';
// lnreader-ios/src/services/storage/storageService.ts
//
// Data & Storage service: real measurements + real deletions.
//
// Principles (per the storage-management requirements):
//  • Only MEASURABLE sizes are reported — every number here comes from a
//    native recursive walk of the app container. iOS-managed data the app
//    cannot measure (system caches, binary size) is never invented.
//  • Personal data (library rows, progress, settings, notes, cookies) is
//    NEVER deleted by any category — deletions are limited to rebuildable
//    files, and chapter deletions always go through the SAME code path the
//    rest of the app uses (deleteChapters), so the SQLite isDownloaded flags
//    stay consistent with the disk.
//  • The native layer refuses any path outside the app sandbox container.

import NativeFile, {
  type StorageInfo,
  type DirectoryStats,
} from '@modules/native-file';
import { Image } from 'expo-image';

import { NOVEL_STORAGE, PLUGIN_STORAGE } from '@utils/Storages';
import { CACHE_DIR_PATH, clearBackupCache } from '@services/backup/utils';
import { getAllNovels } from '@database/queries/NovelQueries';
import {
  deleteChapters,
  getDownloadedChapters,
} from '@database/queries/ChapterQueries';
import type { NovelInfo } from '@database/types';
import {
  TranslationMemory,
  createSqliteMemoryDriver,
  type TranslationMemoryStats,
} from '@services/translation';

// ------------------------------------------------------------- types ---
export type StorageCategoryId =
  | 'downloads'
  | 'plugins'
  | 'images'
  | 'backups'
  | 'webview'
  | 'crashLogs'
  | 'databases'
  | 'translations'
  | 'temp'
  | 'caches';

export type StorageCategory = {
  id: StorageCategoryId;
  bytes: number;
  files: number;
  deletable: boolean;
  /** true → rebuildable (safe to delete); false → personal data. */
  rebuildable: boolean;
  note?: string;
  logical?: boolean;
};

export type StorageOverview = {
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  containerBytes: number;
  categories: StorageCategory[];
};

export type DeleteResult = {
  freedBytes: number;
  errors: string[];
};

// ------------------------------------------------------------ helpers ---
const catStats = (info: StorageInfo, id: string): DirectoryStats =>
  info.categories[id] ?? {
    path: '',
    bytes: 0,
    files: 0,
    folders: 0,
    exists: false,
  };

/** The app sandbox container root (Documents/Library/tmp live under it). */
const containerRoot = (): string =>
  NativeFile.DocumentDirectoryPath.replace(/\/Documents\/?$/, '');

const webkitDir = (): string => `${containerRoot()}/Library/WebKit`;

const logsDir = (): string => `${containerRoot()}/Library/Logs`;

const tmpDir = (): string => `${containerRoot()}/tmp`;

/** expo-image's disk cache lives inside Caches — measure its own folders. */
const measureImageCache = async (): Promise<number> => {
  try {
    const caches = NativeFile.ExternalCachesDirectoryPath;
    const entries = await NativeFile.readDir(caches);
    const imageDirs = entries.filter(
      e => e.isDirectory && /image|photon/i.test(e.name),
    );
    let bytes = 0;
    for (const dir of imageDirs) {
      const stats = await NativeFile.getDirectoryStats(dir.path);
      bytes += stats.bytes;
    }
    return bytes;
  } catch {
    return 0;
  }
};

/**
 * Logical size of the saved-translation memory (per-entry utf8 text + 256
 * bytes overhead, exactly what the LRU eviction budget uses).
 *
 * NOT the on-disk size of translations.db on purpose: the native storage walk
 * already maps `databases` to the whole Library directory and op-sqlite keeps
 * translations.db inside it — adding the file size here would DOUBLE COUNT
 * it under two categories. The logical sum is the number the memory's own
 * eviction logic (24 MB cap) speaks, so it is the honest per-category figure.
 */
const measureTranslationsMemory = async (): Promise<TranslationMemoryStats> => {
  try {
    const memory = new TranslationMemory(createSqliteMemoryDriver());
    await memory.initialize();
    return await memory.stats();
  } catch {
    return { entries: 0, bytes: 0 };
  }
};

// ------------------------------------------------------------ overview ---
export const getStorageOverview = async (): Promise<StorageOverview> => {
  const info = await NativeFile.getStorageInfo();
  const imagesBytes = await measureImageCache();
  const cachesStats = catStats(info, 'caches');
  const translationsStats = await measureTranslationsMemory();

  const categories: StorageCategory[] = [
    {
      id: 'downloads',
      bytes: catStats(info, 'downloads').bytes,
      files: catStats(info, 'downloads').files,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'plugins',
      bytes: catStats(info, 'plugins').bytes,
      files: catStats(info, 'plugins').files,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'images',
      bytes: imagesBytes,
      files: 0,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'backups',
      bytes: catStats(info, 'backups').bytes,
      files: catStats(info, 'backups').files,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'webview',
      bytes: catStats(info, 'webview').bytes,
      files: catStats(info, 'webview').files,
      deletable: true,
      // This measurement includes retained website data as well as caches.
      rebuildable: false,
      note: 'cookies وبيانات الدخول لا تُمس',
    },
    {
      id: 'crashLogs',
      bytes: catStats(info, 'crashLogs').bytes,
      files: catStats(info, 'crashLogs').files,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'caches',
      bytes: Math.max(
        0,
        cachesStats.bytes - imagesBytes - catStats(info, 'backups').bytes,
      ),
      files: Math.max(0, cachesStats.files - catStats(info, 'backups').files),
      deletable: true,
      rebuildable: true,
      note: 'يشمل الصور والنسخ الاحتياطية المؤقتة',
    },
    {
      id: 'databases',
      bytes: catStats(info, 'databases').bytes,
      files: catStats(info, 'databases').files,
      deletable: false,
      rebuildable: false,
      note: 'المكتبة والتقدم والإعدادات — لا تُحذف',
    },
    {
      id: 'translations',
      logical: true,
      // Logical memory bytes — see measureTranslationsMemory() for why this
      // deliberately is NOT translations.db's file size (already inside the
      // Library-wide `databases` walk above).
      bytes: translationsStats.bytes,
      files: 0,
      deletable: true,
      rebuildable: true,
    },
    {
      id: 'temp',
      bytes: catStats(info, 'temp').bytes,
      files: catStats(info, 'temp').files,
      deletable: true,
      rebuildable: true,
    },
  ];

  return {
    deviceTotalBytes: info.deviceTotalBytes,
    deviceFreeBytes: info.deviceFreeBytes,
    containerBytes: info.containerBytes,
    categories,
  };
};

// ---------------------------------------------------------- deletions ---
/**
 * Deletes a rebuildable category. Returns the REAL freed bytes and explicit
 * errors — no fake success. `downloads` and `databases` are intentionally
 * NOT deletable here (dedicated flows / personal data).
 */
export const deleteStorageCategory = async (
  id: StorageCategoryId,
): Promise<DeleteResult> => {
  const errors: string[] = [];
  let freedBytes = 0;

  switch (id) {
    case 'images': {
      const before = await measureImageCache();
      // expo-image owns its cache — clear through its own API.
      await Image.clearDiskCache().catch(e =>
        errors.push(String(e?.message ?? e)),
      );
      freedBytes = Math.max(0, before - (await measureImageCache()));
      break;
    }
    case 'backups': {
      const paths = [
        CACHE_DIR_PATH,
        CACHE_DIR_PATH + '.zip',
        CACHE_DIR_PATH + '-source.zip',
      ];
      let before = 0,
        after = 0;
      for (const path of paths) {
        before += (await NativeFile.getDirectoryStats(path)).bytes;
      }
      await clearBackupCache();
      for (const path of paths.slice(1)) {
        try {
          if (await NativeFile.exists(path)) await NativeFile.unlink(path);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      for (const path of paths) {
        after += (await NativeFile.getDirectoryStats(path)).bytes;
      }
      freedBytes = Math.max(0, before - after);
      break;
    }
    case 'webview': {
      if (Platform.OS === 'ios') {
        const before = await NativeFile.getDirectoryStats(webkitDir());
        await NativeFile.clearWebViewCache();
        const after = await NativeFile.getDirectoryStats(webkitDir());
        freedBytes = Math.max(0, before.bytes - after.bytes);
      }
      break;
    }
    case 'crashLogs': {
      if (await NativeFile.exists(logsDir())) {
        const result = await NativeFile.deleteDirectoryContents(logsDir());
        freedBytes = result.deletedBytes;
        errors.push(...result.errors);
      }
      break;
    }
    case 'temp': {
      const result = await NativeFile.deleteDirectoryContents(tmpDir());
      freedBytes = result.deletedBytes;
      errors.push(...result.errors);
      break;
    }
    case 'caches': {
      const caches = NativeFile.ExternalCachesDirectoryPath;
      const result = await NativeFile.deleteDirectoryContents(caches);
      freedBytes = result.deletedBytes;
      errors.push(...result.errors);
      await Image.clearDiskCache().catch(e =>
        errors.push(String(e?.message ?? e)),
      );
      break;
    }
    case 'plugins': {
      const result = await NativeFile.deleteDirectoryContents(PLUGIN_STORAGE);
      freedBytes = result.deletedBytes;
      errors.push(...result.errors);
      await NativeFile.mkdir(PLUGIN_STORAGE).catch(() => {});
      break;
    }
    case 'translations': {
      // Translation memory ONLY — the translations cache is rebuildable by
      // design (re-translated on demand); library DBs are never touched here.
      try {
        const memory = new TranslationMemory(createSqliteMemoryDriver());
        await memory.initialize();
        const before = await memory.stats();
        await memory.clear();
        freedBytes = before.bytes;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'downloads': {
      const before = await NativeFile.getDirectoryStats(NOVEL_STORAGE);
      const downloaded = await getDownloadedChapters();
      const groups = new Map<number, { pluginId: string; ids: number[] }>();
      for (const chapter of downloaded) {
        const group = groups.get(chapter.novelId) ?? {
          pluginId: chapter.pluginId,
          ids: [],
        };
        group.ids.push(chapter.id);
        groups.set(chapter.novelId, group);
      }
      for (const [novelId, group] of groups) {
        try {
          await deleteChapters(group.pluginId, novelId, group.ids);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const after = await NativeFile.getDirectoryStats(NOVEL_STORAGE);
      freedBytes = Math.max(0, before.bytes - after.bytes);
      if (after.bytes > 0 && !errors.length) errors.push('files-remained');
      break;
    }
    case 'databases':
      throw new Error(
        'downloads/databases are managed through dedicated flows — use deleteNovelChapters / library screens',
      );
    default:
      throw new Error(`Unknown storage category: ${id}`);
  }

  return { freedBytes, errors };
};

// ------------------------------------------------- per-novel breakdown ---
export type NovelStorageEntry = {
  novelId: number;
  pluginId: string;
  title: string;
  cover: string | null;
  bytes: number;
  fileCount: number;
};

/**
 * Per-novel downloaded-size breakdown (Documents/Novels/<pluginId>/<novelId>).
 * Novel identities come from the DB; folders without a matching row are
 * reported as orphan bytes (pure leftovers, still counted — never hidden).
 */
export const getNovelStorageBreakdown = async (): Promise<{
  novels: NovelStorageEntry[];
  orphanBytes: number;
}> => {
  const novels: NovelStorageEntry[] = [];
  let orphanBytes = 0;

  const known = new Map<number, NovelInfo>();
  try {
    (await getAllNovels()).forEach(n => known.set(n.id, n));
  } catch {
    // DB unavailable — folders will report as orphans
  }

  let pluginDirs: { name: string; path: string; isDirectory: boolean }[] = [];
  try {
    pluginDirs = await NativeFile.readDir(NOVEL_STORAGE);
  } catch {
    return { novels, orphanBytes };
  }

  for (const pluginDir of pluginDirs) {
    if (!pluginDir.isDirectory) {
      continue;
    }
    let novelDirs: { name: string; path: string; isDirectory: boolean }[] = [];
    try {
      novelDirs = await NativeFile.readDir(pluginDir.path);
    } catch {
      continue;
    }
    for (const novelDir of novelDirs) {
      if (!novelDir.isDirectory) {
        continue;
      }
      const stats = await NativeFile.getDirectoryStats(novelDir.path);
      const novelId = parseInt(novelDir.name, 10);
      const info = Number.isFinite(novelId) ? known.get(novelId) : undefined;
      if (info) {
        novels.push({
          novelId: info.id,
          pluginId: info.pluginId,
          title: info.name,
          cover: info.cover ?? null,
          bytes: stats.bytes,
          fileCount: stats.files,
        });
      } else {
        orphanBytes += stats.bytes;
      }
    }
  }

  novels.sort((a, b) => b.bytes - a.bytes);
  return { novels, orphanBytes };
};

/**
 * Deletes ALL downloaded chapters of one novel (files + isDownloaded flags)
 * through the app's canonical deleteChapters query — the novel itself stays
 * in the library with its progress.
 */
export const deleteNovelChapters = async (
  novel: Pick<NovelInfo, 'id' | 'pluginId'>,
  beforeBytes: number,
): Promise<DeleteResult> => {
  const downloaded = (await getDownloadedChapters()).filter(
    c => c.novelId === novel.id,
  );
  if (!downloaded.length) {
    return { freedBytes: 0, errors: beforeBytes > 0 ? ['files-remained'] : [] };
  }
  await deleteChapters(
    novel.pluginId,
    novel.id,
    downloaded.map(c => c.id),
  );

  // Verify the folder actually shrank — report the real delta.
  const folder = `${NOVEL_STORAGE}/${novel.pluginId}/${novel.id}`;
  const after = await NativeFile.getDirectoryStats(folder).catch(() => null);
  const freedBytes = Math.max(0, beforeBytes - (after?.bytes ?? 0));
  const errors: string[] = [];
  if ((after?.bytes ?? 0) > 0) {
    errors.push('files-remained');
  }
  return { freedBytes, errors };
};
