import NativeFile from '@modules/native-file';
import { getString } from '@i18n/translations';
import { BackupEntryName, ZipBackupName } from './types';
import { getSelectedBackupFileSections } from './fileSections';
import type { BackupOptions } from './options';

/** Preflight before restoreData can mutate the user's database or settings. */
export const validateLocalBackup = async (directory: string): Promise<void> => {
  const invalid = () =>
    new Error(getString('backupScreen.invalidBackupFolder'));
  let manifest: {
    formatVersion?: number;
    version?: string;
    sections?: BackupOptions;
  };
  try {
    manifest = JSON.parse(
      await NativeFile.readFile(`${directory}/${BackupEntryName.VERSION}`),
    );
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
  if (manifest.formatVersion !== 2) {
    if (
      (manifest.formatVersion !== undefined && manifest.formatVersion !== 1) ||
      typeof manifest.version !== 'string'
    ) {
      throw invalid();
    }
    if (!(await NativeFile.exists(`${directory}/${ZipBackupName.DOWNLOAD}`))) {
      throw invalid();
    }
    return;
  }
  const sections = manifest.sections;
  const keys = ['library', 'settings', 'plugins', 'downloadedFiles'] as const;
  if (
    !sections ||
    !keys.every(key => typeof sections[key] === 'boolean') ||
    !keys.some(key => sections[key]) ||
    (sections.downloadedFiles && !sections.library)
  ) {
    throw invalid();
  }
  const required: string[] = [];
  if (sections.library) {
    required.push(BackupEntryName.NOVEL_AND_CHAPTERS, BackupEntryName.CATEGORY);
  }
  if (sections.settings) required.push(BackupEntryName.SETTING);
  if (sections.plugins) required.push(BackupEntryName.PLUGIN_METADATA);
  required.push(
    ...getSelectedBackupFileSections(sections).map(
      section => section.archiveName,
    ),
  );
  for (const name of required) {
    if (!(await NativeFile.exists(`${directory}/${name}`))) throw invalid();
  }
  // Parse top-level JSON sections before any database writes. Novel rows are
  // validated individually by the existing restore pipeline.
  for (const name of required.filter(entry => entry.endsWith('.json'))) {
    try {
      JSON.parse(await NativeFile.readFile(`${directory}/${name}`));
    } catch {
      throw invalid();
    }
  }
};
