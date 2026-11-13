import NativeFile from '@modules/native-file';
import { validateLocalBackup } from '../validateLocalBackup';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(NativeFile.exists).mockResolvedValue(true);
});

it('rejects future archive formats before any restore can run', async () => {
  jest
    .mocked(NativeFile.readFile)
    .mockResolvedValue(JSON.stringify({ formatVersion: 99 }));
  await expect(validateLocalBackup('/cache')).rejects.toThrow();
});

it('rejects missing nested archives before database restoration', async () => {
  jest.mocked(NativeFile.readFile).mockResolvedValue(
    JSON.stringify({
      formatVersion: 2,
      sections: {
        library: true,
        settings: false,
        plugins: false,
        downloadedFiles: true,
      },
    }),
  );
  jest
    .mocked(NativeFile.exists)
    .mockImplementation(async path => !path.endsWith('novel-files.zip'));
  await expect(validateLocalBackup('/cache')).rejects.toThrow();
});

it('accepts a complete settings-only archive', async () => {
  jest.mocked(NativeFile.readFile).mockImplementation(async path =>
    path.endsWith('Version.json')
      ? JSON.stringify({
          formatVersion: 2,
          sections: {
            library: false,
            settings: true,
            plugins: false,
            downloadedFiles: false,
          },
        })
      : '{}',
  );
  await expect(validateLocalBackup('/cache')).resolves.toBeUndefined();
});

it('accepts a known legacy archive with its downloaded files section', async () => {
  jest
    .mocked(NativeFile.readFile)
    .mockResolvedValue(JSON.stringify({ version: '2.1.0' }));
  await expect(validateLocalBackup('/cache')).resolves.toBeUndefined();
});
