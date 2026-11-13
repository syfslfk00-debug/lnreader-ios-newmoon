// require('react-native-gesture-handler/jestSetup');
// require('react-native-reanimated').setUpTests();

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getApiLevel: jest.fn().mockResolvedValue(35),
    getBrand: jest.fn(() => 'mock-brand'),
    getBuildId: jest.fn().mockResolvedValue('mock-build-id'),
    getBuildNumber: jest.fn(() => '1'),
    getBundleId: jest.fn(() => 'com.lnreader'),
    getDeviceId: jest.fn(() => 'mock-device'),
    getManufacturer: jest.fn().mockResolvedValue('mock-manufacturer'),
    getModel: jest.fn(() => 'mock-model'),
    getSystemName: jest.fn(() => 'Android'),
    getSystemVersion: jest.fn(() => '15'),
    supportedAbis: jest.fn().mockResolvedValue([]),
  },
  getBatteryLevel: jest.fn().mockResolvedValue(1),
  getBatteryLevelSync: jest.fn(() => 1),
  getUserAgentSync: jest.fn(() => 'LNReader test'),
  useBatteryLevel: jest.fn(() => 1),
}));

jest.mock('@modules/native-file', () => ({
  __esModule: true,
  default: {
    DocumentDirectoryPath: '/mock/documents',
    ExternalDirectoryPath: '/mock/external',
    ExternalCachesDirectoryPath: '/mock/caches',
    writeFile: jest.fn(),
    readFile: jest.fn(() => ''),
    copyFile: jest.fn(),
    exportFile: jest.fn().mockResolvedValue('/mock/export.zip'),
    clearWebViewCache: jest.fn().mockResolvedValue(undefined),
    copyFileToDirectory: jest.fn(() =>
      Promise.resolve({ uri: '/mock/export.epub', size: 1 }),
    ),
    pickDirectory: jest.fn(() =>
      Promise.resolve({ uri: '/mock/export', name: 'export' }),
    ),
    moveFile: jest.fn(),
    exists: jest.fn(() => true),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    readDir: jest.fn(() => []),
    downloadFile: jest.fn().mockResolvedValue(),
  },
}));

const mockEpubNovel = {
  name: 'Mock Novel',
  cover: null,
  summary: null,
  author: null,
  artist: null,
  chapters: [],
  cssPaths: [],
  imagePaths: [],
};

global.mockEpubNovel = mockEpubNovel;

jest.mock('@modules/native-volume-button-listener', () => ({
  __esModule: true,
  default: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListeners: jest.fn(),
    setActive: jest.fn(),
  },
}));

jest.mock('@modules/native-share-receiver', () => ({
  __esModule: true,
  default: {
    getInitialSharedText: jest.fn(async () => null),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListeners: jest.fn(),
  },
}));

jest.mock('@modules/native-zip-archive', () => ({
  __esModule: true,
  default: {
    zip: jest.fn().mockResolvedValue(),
    unzip: jest.fn().mockResolvedValue(),
    remoteUnzip: jest.fn().mockResolvedValue(),
    remoteZip: jest.fn().mockResolvedValue(''),
  },
}));

// Translation module natives (Zeus engine port): op-sqlite, secure storage,
// MMKV. The in-memory MMKV keeps reader/translation prefs tests functional.
jest.mock('@op-engineering/op-sqlite', () => ({
  __esModule: true,
  open: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [], rowsAffected: 0 })),
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    executeBatch: jest.fn(async () => ({})),
  })),
}));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
}));

const mockMMKVMemory = new Map();
const mockMMKVInstance = () => ({
  getString: jest.fn(key => mockMMKVMemory.get(key)),
  set: jest.fn((key, value) => mockMMKVMemory.set(key, value)),
  delete: jest.fn(key => mockMMKVMemory.delete(key)),
  remove: jest.fn(key => mockMMKVMemory.delete(key)),
  contains: jest.fn(key => mockMMKVMemory.has(key)),
  getAllKeys: jest.fn(() => Array.from(mockMMKVMemory.keys())),
  clearAll: jest.fn(() => mockMMKVMemory.clear()),
  recrypt: jest.fn(),
  getStringSync: jest.fn(key => mockMMKVMemory.get(key)),
  setSync: jest.fn((key, value) => mockMMKVMemory.set(key, value)),
});
const mockUseMMKV = (key, setter) => {
  const current = mockMMKVMemory.get(key);
  return [
    current === undefined ? setter : JSON.parse(current),
    value => {
      mockMMKVMemory.set(key, JSON.stringify(value));
    },
  ];
};
jest.mock('react-native-mmkv', () => ({
  __esModule: true,
  createMMKV: jest.fn(() => mockMMKVInstance()),
  useMMKVString: (key, setter) => mockUseMMKV(key, setter),
  useMMKVNumber: (key, setter) => mockUseMMKV(key, setter),
  useMMKVBoolean: (key, setter) => mockUseMMKV(key, setter),
  useMMKVObject: (key, setter) => mockUseMMKV(key, setter),
}));
