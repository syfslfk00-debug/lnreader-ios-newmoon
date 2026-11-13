import { Platform } from 'react-native';
import NativeFile from '@modules/native-file';
import NativeBackgroundTasks from '@modules/native-background-tasks';
import { askForPostNotificationsPermission } from '@utils/askForPostNoftificationsPermission';
import {
  AUTOMATIC_BACKUP_INTERVALS,
  configureAutomaticBackups,
} from '../automaticBackupSchedule';

jest.mock('@modules/native-background-tasks', () => ({
  __esModule: true,
  default: {
    cancelAutomaticBackups: jest.fn(),
    scheduleAutomaticBackups: jest.fn(),
  },
}));

jest.mock('@utils/askForPostNoftificationsPermission', () => ({
  askForPostNotificationsPermission: jest.fn(),
}));

jest.mock('@i18n/translations', () => ({
  getString: (key: string) => key,
}));

const mockNativeBackgroundTasks = jest.mocked(NativeBackgroundTasks);
const mockAskForPostNotificationsPermission = jest.mocked(
  askForPostNotificationsPermission,
);

describe('automatic backup scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  it('creates an app-owned default destination on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await configureAutomaticBackups(12);
    expect(NativeFile.mkdir).toHaveBeenCalledWith('/mock/documents/Backups');
    expect(
      mockNativeBackgroundTasks.scheduleAutomaticBackups,
    ).toHaveBeenCalledWith(
      12,
      'notifications.LOCAL_BACKUP',
      'common.preparing',
      '/mock/documents/Backups',
    );
  });
  it('exposes the supported fixed intervals', () => {
    expect(AUTOMATIC_BACKUP_INTERVALS).toEqual([0, 6, 12, 24, 48, 168]);
  });

  it('cancels scheduled work when automatic backups are disabled', async () => {
    await configureAutomaticBackups(0);

    expect(
      mockNativeBackgroundTasks.cancelAutomaticBackups,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockNativeBackgroundTasks.scheduleAutomaticBackups,
    ).not.toHaveBeenCalled();
    expect(mockAskForPostNotificationsPermission).not.toHaveBeenCalled();
  });

  it('requests notification permission and schedules the selected interval', async () => {
    await configureAutomaticBackups(12);

    expect(mockAskForPostNotificationsPermission).toHaveBeenCalledTimes(1);
    expect(
      mockNativeBackgroundTasks.scheduleAutomaticBackups,
    ).toHaveBeenCalledWith(
      12,
      'notifications.LOCAL_BACKUP',
      'common.preparing',
      '',
    );
  });

  it('passes the selected backup directory to native scheduling', async () => {
    await configureAutomaticBackups(24, 'content://backup-folder');

    expect(
      mockNativeBackgroundTasks.scheduleAutomaticBackups,
    ).toHaveBeenCalledWith(
      24,
      'notifications.LOCAL_BACKUP',
      'common.preparing',
      'content://backup-folder',
    );
  });
});
