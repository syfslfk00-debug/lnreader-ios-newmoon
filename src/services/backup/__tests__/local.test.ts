import NativeFile from '@modules/native-file';
import NativeZipArchive from '@modules/native-zip-archive';
import { createBackup, restoreBackup } from '../local';
import { finalizeRestoredPlugins } from '../restoreResult';
import { prepareBackupData, restoreData } from '../utils';

jest.mock('../utils', () => ({
  CACHE_DIR_PATH: '/cache/BackupData',
  clearBackupCache: jest.fn(),
  prepareBackupData: jest.fn(),
  restoreData: jest.fn(),
}));

jest.mock('../restoreResult', () => ({
  finalizeRestoredPlugins: jest.fn(),
  getRestoreCompletionText: jest.fn(),
}));

jest.mock('../backupResult', () => ({
  getBackupCompletionText: jest.fn(() => 'Backup created'),
}));

jest.mock('@utils/Storages', () => ({
  NOVEL_STORAGE: '/storage/Novels',
  PLUGIN_STORAGE: '/storage/Plugins',
  ROOT_STORAGE: '/storage',
}));

jest.mock('@utils/sleep', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@i18n/translations', () => ({
  getString: (key: string) => key,
}));

describe('local selective backup', () => {
  it('creates archives only for selected file sections', async () => {
    jest.mocked(prepareBackupData).mockResolvedValue({
      failedNovelCount: 0,
      failedSectionCount: 0,
    });
    jest.mocked(NativeZipArchive.zip).mockResolvedValue(undefined);
    jest.mocked(NativeFile.copyFile).mockResolvedValue(undefined);

    await createBackup({
      destinationUri: 'content://backup.zip',
      options: {
        library: true,
        settings: true,
        plugins: true,
        downloadedFiles: false,
      },
    });

    expect(prepareBackupData).toHaveBeenCalledWith('/cache/BackupData', {
      library: true,
      settings: true,
      plugins: true,
      downloadedFiles: false,
    });
    expect(NativeZipArchive.zip).toHaveBeenCalledWith(
      '/storage/Plugins',
      '/cache/BackupData/plugins.zip',
    );
    expect(NativeZipArchive.zip).not.toHaveBeenCalledWith(
      '/storage/Novels',
      expect.any(String),
    );
    expect(NativeZipArchive.zip).toHaveBeenCalledWith(
      '/cache/BackupData',
      '/cache/BackupData.zip',
    );
  });

  it('exports a completed ZIP on iOS, after the final archive finishes', async () => {
    jest.clearAllMocks();
    jest
      .mocked(prepareBackupData)
      .mockResolvedValue({ failedNovelCount: 0, failedSectionCount: 0 });
    await createBackup({
      exportName: 'backup.zip',
      options: {
        library: true,
        settings: true,
        plugins: false,
        downloadedFiles: false,
      },
    });
    expect(NativeFile.exportFile).toHaveBeenCalledWith(
      '/cache/BackupData.zip',
      'backup.zip',
    );
    expect(
      jest.mocked(NativeFile.exportFile).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      jest.mocked(NativeZipArchive.zip).mock.invocationCallOrder[0],
    );
    expect(NativeFile.copyFile).not.toHaveBeenCalled();
  });

  it('writes automatic backups inside the selected directory', async () => {
    jest.clearAllMocks();
    await createBackup({
      destinationUri: '/selected/backups',
      automatic: true,
      options: {
        library: true,
        settings: true,
        plugins: false,
        downloadedFiles: false,
      },
    });
    expect(NativeFile.copyFileToDirectory).toHaveBeenCalledWith(
      '/cache/BackupData.zip',
      '/selected/backups',
      expect.stringMatching(/^lnreader_backup_.*\.zip$/),
      'application/zip',
      false,
    );
    expect(NativeFile.copyFile).not.toHaveBeenCalled();
  });

  it('loads restored plugins after their archive is extracted', async () => {
    const restoreResult = {
      novelCount: 1,
      failedNovelCount: 0,
      categoryCount: 0,
      failedCategoryCount: 0,
      settingsRestored: true,
      failedSectionCount: 0,
      pluginIds: ['restored'],
      novelMappings: [],
      manifest: {
        appVersion: '2.1.0',
        formatVersion: 2 as const,
        sections: {
          library: true,
          settings: true,
          plugins: true,
          downloadedFiles: false,
        },
      },
    };
    jest
      .mocked(NativeFile.readFile)
      .mockImplementation(async path =>
        path.endsWith('/Version.json')
          ? JSON.stringify(restoreResult.manifest)
          : '[]',
      );
    jest.mocked(restoreData).mockResolvedValueOnce(restoreResult);
    jest.mocked(NativeFile.exists).mockResolvedValue(true);
    jest.mocked(NativeFile.copyFile).mockResolvedValue(undefined);
    jest.mocked(NativeZipArchive.unzip).mockResolvedValue(undefined);
    jest.mocked(finalizeRestoredPlugins).mockResolvedValueOnce([]);

    await restoreBackup({ sourceUri: 'content://backup.zip' });

    expect(NativeZipArchive.unzip).toHaveBeenCalledWith(
      '/cache/BackupData/plugins.zip',
      '/storage/Plugins',
    );
    expect(finalizeRestoredPlugins).toHaveBeenCalledWith(restoreResult);
    expect(
      jest.mocked(finalizeRestoredPlugins).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      jest.mocked(NativeZipArchive.unzip).mock.invocationCallOrder[1],
    );
  });
});
