import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers
import WebKit

/**
 * iOS implementation of the NativeFile module.
 *
 * This file completes the iOS port of the Android module:
 *  - downloadFile: real URLSession-based downloader (method/headers/body/cookies).
 *  - createDocument / pickDocument / pickDirectory: UIDocumentPicker-based
 *    equivalents of the Android SAF flows.
 *  - BundlePath: absolute path of the app bundle (used by the reader WebView).
 *  - Security-scoped bookmark support so picked directories keep working
 *    across launches (mirrors Android's persisted SAF tree URIs).
 */
public class NativeFileModule: Module {
  private let fileManager = FileManager.default
  private var scrollProbe: WebViewScrollObserver?
  /// UserDefaults suite storing security-scoped bookmarks keyed by path.
  private var bookmarksDefaults: UserDefaults? {
    UserDefaults(suiteName: "NativeFileBookmarks")
  }

  public func definition() -> ModuleDefinition {
    Name("NativeFile")
    Events("onWebViewScrollProbe")

    AsyncFunction("startWebViewScrollProbe") { (promise: Promise) in
      #if targetEnvironment(simulator)
      DispatchQueue.main.async {
        func attach(attempt: Int) {
          let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
          func find(_ view: UIView) -> WKWebView? {
            if let web = view as? WKWebView, web.window != nil, !web.isHidden { return web }
            for child in view.subviews { if let web = find(child) { return web } }
            return nil
          }
          if let web = windows.compactMap({ find($0) }).first {
            self.scrollProbe = WebViewScrollObserver(web.scrollView) { [weak self] metrics in
              self?.sendEvent("onWebViewScrollProbe", metrics.mapValues { $0 as Any? })
            }
            promise.resolve(nil)
          } else if attempt < 100 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { attach(attempt: attempt + 1) }
          } else { promise.reject("E2E_WEBVIEW_MISSING", "No visible WKWebView") }
        }
        attach(attempt: 0)
      }
      #else
      promise.reject("E2E_DISABLED", "Scroll probes are simulator-only")
      #endif
    }

    Function("stopWebViewScrollProbe") {
      DispatchQueue.main.async { self.scrollProbe = nil }
    }

    Function("writeFile") { (path: String, content: String) in
      try self.withSecurityScope(path: path) { url in
        try content.write(to: url, atomically: true, encoding: .utf8)
      }
    }

    Function("readFile") { (path: String) in
      try self.withSecurityScope(path: path) { url in
        try String(contentsOf: url, encoding: .utf8)
      }
    }

    AsyncFunction("copyFile") { (sourcePath: String, destPath: String) in
      try self.withSecurityScope(path: sourcePath) { sourceURL in
        try self.withSecurityScope(path: destPath) { destinationURL in
          let coordinator = NSFileCoordinator()
          var coordinationError: NSError?
          var copyError: Error?
          coordinator.coordinate(readingItemAt: sourceURL, options: [], writingItemAt: destinationURL, options: .forReplacing, error: &coordinationError) { source, destination in
            do {
              guard source.standardizedFileURL != destination.standardizedFileURL else { throw CocoaError(.fileWriteInvalidFileName) }
              _ = try self.copyFileToDirectory(sourcePath: source.path, directoryUrl: destination.deletingLastPathComponent(), fileName: destination.lastPathComponent, replace: true)
            } catch { copyError = error }
          }
          if let error = coordinationError { throw error }
          if let error = copyError { throw error }
        }
      }
    }

    AsyncFunction("copyFileToDirectory") { (sourcePath: String, directoryUri: String, fileName: String, mimeType: String, replace: Bool) -> [String: Any] in
      _ = mimeType
      return try self.withSecurityScope(path: directoryUri) { directory in
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var result: [String: Any]?
        var copyError: Error?
        coordinator.coordinate(writingItemAt: directory, options: .forMerging, error: &coordinationError) { target in
          do { result = try self.copyFileToDirectory(sourcePath: sourcePath, directoryUrl: target, fileName: fileName, replace: replace) }
          catch { copyError = error }
        }
        if let error = coordinationError { throw error }
        if let error = copyError { throw error }
        guard let result = result else { throw CocoaError(.fileWriteUnknown) }
        return result
      }
    }

    Function("moveFile") { (sourcePath: String, destPath: String) in
      let fileManager = FileManager.default
      let sourceURL = Self.fileURL(sourcePath)
      let destinationURL = Self.fileURL(destPath)

      if fileManager.fileExists(atPath: destinationURL.path) {
        try fileManager.removeItem(at: destinationURL)
      }
      try fileManager.moveItem(at: sourceURL, to: destinationURL)
    }

    Function("exists") { (filePath: String) in
      FileManager.default.fileExists(atPath: Self.fileURL(filePath).path)
    }

    Function("mkdir") { (filePath: String) in
      try FileManager.default.createDirectory(atPath: Self.fileURL(filePath).path, withIntermediateDirectories: true, attributes: nil)
    }

    Function("unlink") { (filePath: String) in
      try self.withSecurityScope(path: filePath) { url in
        try FileManager.default.removeItem(at: url)
      }
    }

    Function("readDir") { (dirPath: String) -> [[String: Any]] in
      let contents = try FileManager.default.contentsOfDirectory(atPath: Self.fileURL(dirPath).path)
      return contents.map { fileName in
        let path = (Self.fileURL(dirPath).path as NSString).appendingPathComponent(fileName)
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        return [
          "name": fileName,
          "path": path,
          "isDirectory": isDirectory.boolValue
        ]
      }
    }

    AsyncFunction("downloadFile") { (url: String, destPath: String, method: String, headers: [String: String], body: String?, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try self.downloadToFile(
            url: url,
            destPath: destPath,
            method: method,
            headers: headers,
            body: body
          )
          promise.resolve(nil)
        } catch {
          promise.reject("DOWNLOAD_FAILED", error.localizedDescription)
        }
      }
    }

    /// Creates a new empty document at a user-chosen location (equivalent of
    /// Android's ACTION_CREATE_DOCUMENT). Returns the file path to write into.
    /// NOTE: the modern iOS SDK (26.x) exposes `init(forExporting urls: [URL],
    /// asCopy: Bool)` — the UTType-based export initializer is gone — so we
    /// stage an empty temp file and let the export picker move it into place.
    /// The mimeType parameter is kept for TS API compatibility; the picker no
    /// longer enforces it natively.
    AsyncFunction("createDocument") { (filename: String, mimeType: String, promise: Promise) in
      DispatchQueue.main.async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        FileManager.default.createFile(atPath: tempURL.path, contents: Data())
        // iOS 26 SDK: nameFieldStringValue was removed from the public API.
        // The URL-based export picker suggests the staged file's name
        // automatically (the temp file is named after `filename`).
        let picker = UIDocumentPickerViewController(forExporting: [tempURL], asCopy: false)
        Self.presentPicker(picker, failure: { promise.reject("PICKER_UNAVAILABLE", "Cannot present the Files picker") }) { urls in
          guard let url = urls.first else {
            try? FileManager.default.removeItem(at: tempURL)
            promise.reject("USER_CANCELED", "No document selected")
            return
          }
          self.storeBookmarkIfSecurityScoped(url)
          if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: Data())
          }
          try? FileManager.default.removeItem(at: tempURL)
          promise.resolve(url.path)
        }
      }
    }

    AsyncFunction("exportFile") { (sourcePath: String, filename: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let stagingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
          try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
          let staged = stagingDirectory.appendingPathComponent((filename as NSString).lastPathComponent)
          try FileManager.default.copyItem(at: Self.fileURL(sourcePath), to: staged)
          DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forExporting: [staged], asCopy: true)
            Self.presentPicker(picker, failure: {
              try? FileManager.default.removeItem(at: stagingDirectory)
              promise.reject("PICKER_UNAVAILABLE", "Cannot present the Files picker")
            }) { urls in
              defer { try? FileManager.default.removeItem(at: stagingDirectory) }
              guard let url = urls.first else {
                promise.reject("USER_CANCELED", "Export cancelled")
                return
              }
              promise.resolve(url.path)
            }
          }
        } catch {
          try? FileManager.default.removeItem(at: stagingDirectory)
          promise.reject("EXPORT_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("clearWebViewCache") { (promise: Promise) in
      DispatchQueue.main.async {
        let cacheTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeOfflineWebApplicationCache]
        WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) {
          promise.resolve(nil)
        }
      }
    }

    /// Opens a user-chosen document (equivalent of Android's ACTION_OPEN_DOCUMENT).
    /// Returns a readable file path.
    AsyncFunction("pickDocument") { (mimeType: String, promise: Promise) in
      DispatchQueue.main.async {
        let utType = Self.utType(forMimeType: mimeType) ?? .data
        let types: [UTType] = mimeType == "application/zip" ? [.zip, .archive] : [utType]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        Self.presentPicker(picker, failure: { promise.reject("PICKER_UNAVAILABLE", "Cannot present the Files picker") }) { urls in
          guard let url = urls.first else {
            promise.reject("USER_CANCELED", "No document selected")
            return
          }
          promise.resolve(url.path)
        }
      }
    }

    /// Opens a user-chosen directory (equivalent of Android's OPEN_DOCUMENT_TREE).
    /// Returns {uri, name}; access persists across launches via bookmarks.
    AsyncFunction("pickDirectory") { (promise: Promise) in
      DispatchQueue.main.async {
        let picker = UIDocumentPickerViewController(
          forOpeningContentTypes: [.folder],
          asCopy: false
        )
        Self.presentPicker(picker, failure: { promise.reject("PICKER_UNAVAILABLE", "Cannot present the Files picker") }) { urls in
          guard let url = urls.first else {
            promise.reject("USER_CANCELED", "No directory selected")
            return
          }
          self.storeBookmarkIfSecurityScoped(url)
          promise.resolve(["uri": url.path, "name": url.lastPathComponent])
        }
      }
    }

    Constant("DocumentDirectoryPath") {
      let paths = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
      return paths.first ?? ""
    }

    Constant("ExternalDirectoryPath") {
      let paths = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
      return paths.first ?? ""
    }

    Constant("ExternalCachesDirectoryPath") {
      let paths = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)
      return paths.first ?? ""
    }

    Constant("E2ESurface") {
      #if targetEnvironment(simulator)
      let mode = ProcessInfo.processInfo.environment["MOON_E2E_SURFACE"] ?? ""
      return ["reader", "browser"].contains(mode) ? mode : ""
      #else
      return ""
      #endif
    }

    Constant("BundlePath") {
      Bundle.main.bundlePath
    }

    // MARK: - App storage management (Data & Storage settings section)

    /// Full storage overview in ONE native pass: device capacities plus the
    /// recursive size of every measurable app-container category. Measuring
    /// runs off the JS thread; each category is independent, so one unreadable
    /// folder never fails the whole report (size 0 instead).
    AsyncFunction("getStorageInfo") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(self.collectStorageInfo())
      }
    }

    /// Recursive stats for one folder: bytes, file count, folder count.
    /// Confined to the app container.
    AsyncFunction("getDirectoryStats") { (path: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard Self.isInsideContainer(path) else {
          promise.reject("PATH_OUTSIDE_CONTAINER", "Refusing to measure outside the app container: \(path)")
          return
        }
        let stats = Self.recursiveStats(at: path)
        promise.resolve([
          "path": path,
          "bytes": stats.bytes,
          "files": stats.files,
          "folders": stats.folders,
          "exists": stats.exists,
        ])
      }
    }

    /// Deletes the CONTENTS of a folder (the folder itself survives —
    /// the app expects these paths to exist). Confined to the app container.
    /// Returns { deletedBytes, errors: [String] } so the UI can report real
    /// failures instead of fake success.
    AsyncFunction("deleteDirectoryContents") { (path: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard Self.isInsideContainer(path) else {
          promise.reject("PATH_OUTSIDE_CONTAINER", "Refusing to delete outside the app container: \(path)")
          return
        }
        let fileManager = FileManager.default
        var deletedBytes: Int64 = 0
        var errors: [String] = []
        let statsBefore = Self.recursiveStats(at: path)
        if let children = try? fileManager.contentsOfDirectory(atPath: path) {
          for child in children {
            let childPath = (path as NSString).appendingPathComponent(child)
            let childStats = Self.recursiveStats(at: childPath)
            do {
              try fileManager.removeItem(atPath: childPath)
              deletedBytes += childStats.bytes
            } catch {
              errors.append("\(child): \(error.localizedDescription)")
            }
          }
        }
        // Re-create the (now empty) folder so callers keep a valid path.
        try? fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
        _ = statsBefore
        promise.resolve(["deletedBytes": deletedBytes, "errors": errors])
      }
    }
  }

  // MARK: - Storage helpers

  /// True when `path` is inside THIS app's sandbox container. Every storage
  /// management operation is gated on this — no arbitrary filesystem deletes.
  static func isInsideContainer(_ path: String) -> Bool {
    let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
    return standardized == NSHomeDirectory()
      || standardized.hasPrefix(NSHomeDirectory() + "/")
  }

  private struct DirStats {
    var bytes: Int64 = 0
    var files: Int64 = 0
    var folders: Int64 = 0
    var exists: Bool = false
  }

  /// Iterative deep walk (no recursion on the call stack for 1000+-chapter
  /// novel folders). Returns zero stats for missing paths.
  private static func recursiveStats(at path: String) -> DirStats {
    var result = DirStats()
    let fileManager = FileManager.default
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory) else {
      return result
    }
    result.exists = true
    if !isDirectory.boolValue {
      result.files = 1
      result.bytes = Self.fileSize(at: path)
      return result
    }
    result.folders = 1
    var stack: [String] = [path]
    while let dir = stack.popLast() {
      guard let children = try? fileManager.contentsOfDirectory(atPath: dir) else {
        continue
      }
      for child in children {
        let childPath = (dir as NSString).appendingPathComponent(child)
        var childIsDir: ObjCBool = false
        guard fileManager.fileExists(atPath: childPath, isDirectory: &childIsDir) else {
          continue
        }
        if childIsDir.boolValue {
          result.folders += 1
          stack.append(childPath)
        } else {
          result.files += 1
          result.bytes += Self.fileSize(at: childPath)
        }
      }
    }
    return result
  }

  private static func fileSize(at path: String) -> Int64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: path)
    return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  }

  private func collectStorageInfo() -> [String: Any] {
    let fileManager = FileManager.default
    let home = NSHomeDirectory()

    // Device capacities (whole volume — the app sandbox has no own quota).
    var totalBytes: Int64 = 0
    var freeBytes: Int64 = 0
    if let url = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first {
      let values = try? url.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityKey])
      totalBytes = Int64(values?.volumeTotalCapacity ?? 0)
      freeBytes = Int64(values?.volumeAvailableCapacity ?? 0)
    }

    let documents = (home as NSString).appendingPathComponent("Documents")
    let library = (home as NSString).appendingPathComponent("Library")
    let caches = (library as NSString).appendingPathComponent("Caches")
    let tmp = NSTemporaryDirectory()

    // Category paths (keep in sync with src/services/storage/storageService.ts)
    let categories: [String: String] = [
      "downloads": (documents as NSString).appendingPathComponent("Novels"),
      "plugins": (documents as NSString).appendingPathComponent("Plugins"),
      "caches": caches,
      "backups": (caches as NSString).appendingPathComponent("BackupData"),
      "webview": (library as NSString).appendingPathComponent("WebKit"),
      "crashLogs": (library as NSString).appendingPathComponent("Logs"),
      "databases": library,
      "temp": tmp,
    ]

    var measured: [String: Any] = [:]
    for (key, path) in categories {
      let stats = Self.recursiveStats(at: path)
      measured[key] = [
        "path": path,
        "bytes": stats.bytes,
        "files": stats.files,
        "folders": stats.folders,
        "exists": stats.exists,
      ]
    }

    if var backupStats = measured["backups"] as? [String: Any] {
      let base = (caches as NSString).appendingPathComponent("BackupData")
      let archives = [Self.recursiveStats(at: base + ".zip"), Self.recursiveStats(at: base + "-source.zip")]
      backupStats["bytes"] = (backupStats["bytes"] as? Int64 ?? 0) + archives.reduce(Int64(0)) { $0 + $1.bytes }
      backupStats["files"] = (backupStats["files"] as? Int64 ?? 0) + archives.reduce(Int64(0)) { $0 + $1.files }
      measured["backups"] = backupStats
    }

    // Library contains WebKit, Logs and Caches. Report its remaining personal
    // data separately so the distribution never counts those bytes twice.
    if var personal = measured["databases"] as? [String: Any] {
      let overlapping = ["caches", "webview", "crashLogs"].compactMap { measured[$0] as? [String: Any] }
      personal["bytes"] = max(0, (personal["bytes"] as? Int64 ?? 0) - overlapping.reduce(Int64(0)) { $0 + ($1["bytes"] as? Int64 ?? 0) })
      personal["files"] = max(0, (personal["files"] as? Int64 ?? 0) - overlapping.reduce(Int64(0)) { $0 + ($1["files"] as? Int64 ?? 0) })
      measured["databases"] = personal
    }

    // App container total (Documents + Library + tmp walked once).
    let containerStats = Self.recursiveStats(at: home)

    return [
      "deviceTotalBytes": totalBytes,
      "deviceFreeBytes": freeBytes,
      "containerBytes": containerStats.bytes,
      "categories": measured,
    ]
  }

  // MARK: - Copy to directory

  private func copyFileToDirectory(
    sourcePath: String,
    directoryUrl: URL,
    fileName: String,
    replace: Bool
  ) throws -> [String: Any] {
    guard !fileName.isEmpty,
      fileName != ".",
      fileName != "..",
      !fileName.contains("/"),
      !fileName.contains("\\")
    else {
      throw NSError(
        domain: "NativeFile",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid destination file name"]
      )
    }

    let fileManager = FileManager.default
    let sourceURL = Self.fileURL(sourcePath)
    let destinationURL = directoryUrl.appendingPathComponent(fileName)
    let stagingURL = directoryUrl.appendingPathComponent(".\(fileName).\(UUID().uuidString).tmp")

    guard fileManager.fileExists(atPath: directoryUrl.path) else {
      throw NSError(
        domain: "NativeFile",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Destination directory does not exist"]
      )
    }
    var destinationIsDirectory: ObjCBool = false
    if fileManager.fileExists(atPath: destinationURL.path, isDirectory: &destinationIsDirectory), destinationIsDirectory.boolValue {
      throw CocoaError(.fileWriteInvalidFileName)
    }
    if fileManager.fileExists(atPath: destinationURL.path) && !replace {
      throw CocoaError(.fileWriteFileExists)
    }

    defer { try? fileManager.removeItem(at: stagingURL) }
    try fileManager.copyItem(at: sourceURL, to: stagingURL)
    let attributes = try fileManager.attributesOfItem(atPath: stagingURL.path)
    let copiedSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0

    if fileManager.fileExists(atPath: destinationURL.path) {
      _ = try fileManager.replaceItemAt(destinationURL, withItemAt: stagingURL)
    } else {
      try fileManager.moveItem(at: stagingURL, to: destinationURL)
    }
    return ["uri": destinationURL.absoluteString, "size": copiedSize]
  }

  // MARK: - Download

  private func downloadToFile(
    url: String,
    destPath: String,
    method: String,
    headers: [String: String],
    body: String?
  ) throws {
    guard let requestUrl = URL(string: url) else {
      throw NSError(
        domain: "NativeFile", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Invalid URL: \(url)"]
      )
    }

    var request = URLRequest(url: requestUrl)
    request.httpMethod = method.uppercased()
    request.httpShouldHandleCookies = true
    headers.forEach { key, value in
      request.setValue(value, forHTTPHeaderField: key)
    }
    if let body = body, !body.isEmpty {
      request.httpBody = body.data(using: .utf8)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var resultData: Data?
    var resultError: Error?
    var statusCode = 0

    // .default configuration shares HTTPCookieStorage with RN networking,
    // so cookies collected by the app/webview are reused (mirrors the
    // Android OkHttp cookie jar behaviour).
    let task = URLSession.shared.dataTask(with: request) { data, response, error in
      defer { semaphore.signal() }
      resultError = error
      resultData = data
      if let http = response as? HTTPURLResponse {
        statusCode = http.statusCode
      }
    }
    task.resume()
    semaphore.wait()

    if let error = resultError {
      throw error
    }
    guard let data = resultData, statusCode == 200 else {
      throw NSError(
        domain: "NativeFile", code: 4,
        userInfo: [NSLocalizedDescriptionKey: "Network request failed (HTTP \(statusCode))"]
      )
    }

    let destinationURL = Self.fileURL(destPath)
    let parentDirectory = destinationURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: parentDirectory, withIntermediateDirectories: true)
    try data.write(to: destinationURL, options: .atomic)
  }

  // MARK: - Security-scoped bookmarks

  private func storeBookmarkIfSecurityScoped(_ url: URL) {
    guard !url.standardizedFileURL.path.hasPrefix(NSHomeDirectory() + "/") else { return }
    do {
      let started = url.startAccessingSecurityScopedResource()
      defer { if started { url.stopAccessingSecurityScopedResource() } }
      let bookmark = try url.bookmarkData()
      bookmarksDefaults?.set(bookmark, forKey: url.path)
    } catch {
      // Non-fatal: some locations remain accessible without a bookmark.
    }
  }

  private func resolveSecurityScopedURL(for path: String) -> (scope: URL, target: URL)? {
    let url = Self.fileURL(path)
    var candidate = url
    while candidate.path.count > 1 {
      if let bookmark = bookmarksDefaults?.data(forKey: candidate.path),
         let resolved = resolveBookmark(bookmark, forKey: candidate.path) {
        let suffix = String(url.path.dropFirst(candidate.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return (resolved, suffix.isEmpty ? resolved : resolved.appendingPathComponent(suffix))
      }
      let parent = candidate.deletingLastPathComponent()
      if parent.path == candidate.path { break }
      candidate = parent
    }
    return nil
  }

  private func resolveBookmark(_ bookmark: Data, forKey key: String) -> URL? {
    var isStale = false
    do {
      let resolved = try URL(
        resolvingBookmarkData: bookmark,
        options: [],
        relativeTo: nil,
        bookmarkDataIsStale: &isStale
      )
      if isStale {
        if let refreshed = try? resolved.bookmarkData() {
          bookmarksDefaults?.set(refreshed, forKey: key)
        }
      }
      return resolved
    } catch {
      return nil
    }
  }

  /// Runs `body` with security scope started when the path belongs to a
  /// user-picked (sandboxed) location. Plain container paths run untouched.
  private func withSecurityScope<T>(path: String, body: (URL) throws -> T) throws -> T {
    let url = Self.fileURL(path)
    let scoped = resolveSecurityScopedURL(for: url.path)
    let started = scoped?.scope.startAccessingSecurityScopedResource() ?? false
    defer { if started { scoped?.scope.stopAccessingSecurityScopedResource() } }
    return try body(scoped?.target ?? url)
  }

  private static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    return URL(fileURLWithPath: path)
  }

  // MARK: - Picker presentation

  private static func utType(forMimeType mimeType: String) -> UTType? {
    if mimeType.isEmpty || mimeType == "*/*" {
      return .data
    }
    return UTType(mimeType: mimeType)
      ?? UTType(filenameExtension: (mimeType as NSString).pathExtension)
  }

  private static func presentPicker(
    _ picker: UIDocumentPickerViewController,
    failure: @escaping () -> Void,
    completion: @escaping ([URL]) -> Void
  ) {
    let delegate = PickerDelegateHolder(completion: completion)
    picker.delegate = delegate
    objc_setAssociatedObject(
      picker,
      &PickerDelegateHolder.associationKey,
      delegate,
      .OBJC_ASSOCIATION_RETAIN
    )
    picker.allowsMultipleSelection = false

    func present(attempt: Int) {
      let root = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .filter { $0.activationState == .foregroundActive }
        .flatMap { $0.windows }
        .first(where: { $0.isKeyWindow })?.rootViewController
      guard var presenter = root else { failure(); return }
      while let next = presenter.presentedViewController { presenter = next }
      if presenter.isBeingDismissed || presenter.isBeingPresented || presenter.view.window == nil {
        guard attempt < 20 else { failure(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { present(attempt: attempt + 1) }
        return
      }
      presenter.present(picker, animated: true)
      picker.presentationController?.delegate = delegate
    }
    present(attempt: 0)
  }
}

/// Retains itself on the picker via associated objects and forwards the result.
final class PickerDelegateHolder: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  static var associationKey = "NativeFilePickerDelegate"

  private var completed = false
  private let completion: ([URL]) -> Void

  init(completion: @escaping ([URL]) -> Void) {
    self.completion = completion
    super.init()
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls)
  }

  private func finish(_ urls: [URL]) {
    guard !completed else { return }
    completed = true
    completion(urls)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish([]) }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish([])
  }
}

/// UI-test instrumentation. A pan's actual .ended transition defines release;
/// XCTest may wait for scrolling to settle before returning from a swipe.
private final class WebViewScrollObserver: NSObject {
  private weak var scrollView: UIScrollView?
  private var observation: NSKeyValueObservation?
  private var release: CGFloat?
  private var coast: CGFloat = 0
  private let publish: ([String: Double]) -> Void

  init(_ scrollView: UIScrollView, publish: @escaping ([String: Double]) -> Void) {
    self.scrollView = scrollView
    self.publish = publish
    super.init()
    scrollView.panGestureRecognizer.addTarget(self, action: #selector(panChanged(_:)))
    observation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in self?.report() }
    report()
  }

  @objc private func panChanged(_ pan: UIPanGestureRecognizer) {
    if pan.state == .began { release = nil; coast = 0 }
    else if pan.state == .ended { release = scrollView?.contentOffset.y }
    else if pan.state == .cancelled || pan.state == .failed { release = nil }
    report()
  }

  private func report() {
    guard let scrollView = scrollView else { return }
    let y = scrollView.contentOffset.y
    if let release = release, !scrollView.isDragging { coast = max(coast, y - release) }
    publish(["y": Double(y), "release": Double(release ?? -1), "coast": Double(coast)])
  }

  deinit {
    scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged(_:)))
    observation?.invalidate()
  }
}
