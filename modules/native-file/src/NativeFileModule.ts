import { requireNativeModule } from 'expo-modules-core';

export type ReadDirResult = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type DirectorySelection = {
  uri: string;
  name: string;
};

export type FileCopyResult = {
  uri: string;
  size: number;
};

/** Recursive folder measurement (Data & Storage section). */
export type DirectoryStats = {
  path: string;
  bytes: number;
  files: number;
  folders: number;
  exists: boolean;
};

export type StorageCategoryStats = DirectoryStats;

/** One-shot native storage report (all sizes in bytes). */
export type StorageInfo = {
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  containerBytes: number;
  categories: Record<string, StorageCategoryStats>;
};

export type DeleteDirectoryResult = {
  deletedBytes: number;
  errors: string[];
};

type NativeFileModule = {
  DocumentDirectoryPath: string;
  ExternalDirectoryPath: string;
  ExternalCachesDirectoryPath: string;
  /** iOS only: absolute path of the main app bundle. */
  BundlePath: string;
  /** Simulator-only launch fixture, always empty in device builds. */
  E2ESurface?: string;
  startWebViewScrollProbe(): Promise<void>;
  stopWebViewScrollProbe(): void;
  addListener(
    event: 'onWebViewScrollProbe',
    listener: (metrics: { y: number; release: number; coast: number }) => void,
  ): { remove(): void };
  exportFile(sourcePath: string, filename: string): Promise<string>;
  clearWebViewCache(): Promise<void>;
  createDocument(filename: string, mimeType: string): Promise<string>;
  pickDocument(mimeType: string): Promise<string>;
  pickDirectory(): Promise<DirectorySelection>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  copyFile(filepath: string, destPath: string): Promise<void>;
  copyFileToDirectory(
    sourcePath: string,
    directoryUri: string,
    fileName: string,
    mimeType: string,
    replace: boolean,
  ): Promise<FileCopyResult>;
  moveFile(filepath: string, destPath: string): Promise<void>;
  exists(filepath: string): Promise<boolean>;
  mkdir(filepath: string): Promise<void>;
  unlink(filepath: string): Promise<void>;
  readDir(directory: string): Promise<ReadDirResult[]>;
  downloadFile(
    url: string,
    destPath: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<void>;
  getStorageInfo(): Promise<StorageInfo>;
  getDirectoryStats(path: string): Promise<DirectoryStats>;
  deleteDirectoryContents(path: string): Promise<DeleteDirectoryResult>;
};

export default requireNativeModule<NativeFileModule>('NativeFile');
