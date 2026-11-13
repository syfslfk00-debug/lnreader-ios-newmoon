import XCTest

/**
 * Real-interaction end-to-end suite for LNReader iOS.
 *
 * The suite drives the *installed* LNReader app (matched by bundle id) inside
 * the CI simulator: it completes onboarding, walks the tabs, switches the app
 * language from English to Arabic (RTL rebuild via the React-runtime reload),
 * opens the reader settings preview, proves tap-to-toggle reader chrome with
 * accessibility probes, and exercises the interactive color picker. A further
 * regression locks the RTL top-tab indicator to the tapped tab in Browse.
 *
 * Screenshots are written to /tmp/lnreader-e2e (allowed for simulator
 * processes) and attached to the test report; the CI workflow uploads both.
 */
final class LNReaderUITests: XCTestCase {
  private static let bundleId = "com.rajarsheechatterjee.LNReader"
  private static let shotsDir = "/tmp/lnreader-e2e"

  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication(bundleIdentifier: Self.bundleId)
    try? FileManager.default.createDirectory(
      atPath: Self.shotsDir, withIntermediateDirectories: true)
  }

  // MARK: helpers

  private func screenshot(_ name: String) {
    let shot = XCUIScreen.main.screenshot()
    let url = URL(fileURLWithPath: "\(Self.shotsDir)/\(name).png")
    try? shot.pngRepresentation.write(to: url)
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitExists(
    _ element: XCUIElement, _ timeout: TimeInterval = 20, _ message: String
  ) {
    XCTAssertTrue(
      element.waitForExistence(timeout: timeout), "UI gate failed: \(message)")
  }

  private func waitVanishes(
    _ element: XCUIElement, _ timeout: TimeInterval = 10, _ message: String
  ) {
    let gone = NSPredicate(format: "exists == 0")
    expectation(for: gone, evaluatedWith: element)
    waitForExpectations(timeout: timeout) { _ in
      // fall-through: the final assert below is the real gate
    }
    XCTAssertFalse(element.exists, "UI gate failed: \(message)")
  }

  /// Finds the first tappable element matching any of the labels
  /// (English / Arabic pairs keep the suite resilient across restarts).
  private func tappable(_ labels: [String]) -> XCUIElement? {
    for label in labels {
      let button = app.buttons[label].firstMatch
      if button.exists && button.isHittable { return button }
    }
    for label in labels {
      let any = app.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@", label)).firstMatch
      if any.exists { return any }
    }
    return nil
  }

  private func tapWhenReady(_ labels: [String], _ timeout: TimeInterval = 20,
                            _ message: String) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let element = tappable(labels) {
        element.tap()
        return
      }
      sleep(1)
    }
    XCTFail("UI gate failed: \(message)")
  }

  private func waitTappable(_ labels: [String], _ timeout: TimeInterval = 20,
                            _ message: String) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if tappable(labels) != nil {
        return
      }
      sleep(1)
    }
    XCTFail("UI gate failed: \(message)")
  }

  private func element(withIdentifier identifier: String) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(identifier: identifier).firstMatch
  }

  // MARK: tests

  func testOnboardingLanguageRTLReaderToolsAndColorPicker() {
    app.launch()
    sleep(6)
    screenshot("01-launch")

    // 1) Onboarding gate on first run ("Complete" / "إكمال").
    if let complete = tappable(["Complete", "إكمال"]), complete.exists {
      complete.tap()
      sleep(3)
    }

    // 2) Bottom tabs render.
    waitTappable(["More", "المزيد"], 120,
                 "bottom tabs did not render after launch")
    screenshot("02-library")

    // 3) More -> Settings.
    tapWhenReady(["More", "المزيد"], 15, "More tab missing")
    tapWhenReady(["Settings", "الإعدادات"], 20, "Settings row missing")
    screenshot("03-settings")

    // 4) Appearance -> App language -> العربية -> Apply now (runtime reload).
    tapWhenReady(["Appearance", "مظهر"], 20, "Appearance row missing")
    tapWhenReady(["App language", "لغة التطبيق"], 20, "language row missing")
    tapWhenReady(["العربية"], 15, "Arabic option missing")
    tapWhenReady(["Apply now", "تطبيق الآن"], 15, "apply-now dialog missing")
    waitExists(
      app.buttons["المكتبة"].firstMatch, 60,
      "Arabic (RTL) UI did not appear after language switch")
    screenshot("04-rtl-arabic")

    // 5) More -> Settings -> Reader (Arabic UI): live preview WebView.
    tapWhenReady(["المزيد", "More"], 20, "More tab (AR) missing")
    tapWhenReady(["الإعدادات", "Settings"], 20, "Settings row (AR) missing")
    tapWhenReady(["القارئ", "Reader"], 20, "Reader settings row missing")
    waitExists(element(withIdentifier: "reader-preview"), 40,
               "reader preview did not load")
    sleep(3)
    screenshot("05-reader-preview")

    // 6) Tap preview -> reader chrome (appbar/footer) toggles.
    let appbar = element(withIdentifier: "reader-appbar")
    let footer = element(withIdentifier: "reader-footer")
    XCTAssertFalse(
      appbar.exists && footer.exists,
      "reader chrome should start hidden in the preview")
    let preview = element(withIdentifier: "reader-preview")
    preview.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
    waitExists(appbar, 12, "reader appbar did not appear after tap")
    waitExists(footer, 5, "reader footer did not appear after tap")
    screenshot("06-reader-tools-visible")
    preview.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
    waitVanishes(appbar, 12, "reader appbar did not hide after second tap")
    screenshot("07-reader-tools-hidden")

    // 7) Theme tab -> interactive color picker: preset + save.
    tapWhenReady(["السمة", "Theme"], 15, "Theme tab missing")
    sleep(1)
    tapWhenReady(
      ["لون الخلفية", "Background color"], 15,
      "background color row missing")
    let preset = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == '#292832'")).firstMatch
    waitExists(preset, 15, "preset swatch missing")
    preset.tap()
    sleep(1)
    screenshot("08-color-picker")
    tapWhenReady(["حفظ", "Save"], 10, "Save button missing")
    sleep(1)
    screenshot("09-after-color-change")
  }

  func testAppSurvivesRepeatedNavigation() {
    app.launch()
    sleep(6)
    if let complete = tappable(["Complete", "إكمال"]), complete.exists {
      complete.tap()
      sleep(3)
    }
    waitTappable(["More", "المزيد"], 120, "tabs did not render")

    // Rapid tab cycling + settings push/pop must not crash the app.
    for _ in 0..<3 {
      tapWhenReady(["Browse", "تصفح"], 15, "Browse tab missing")
      tapWhenReady(["History", "السجل"], 15, "History tab missing")
      tapWhenReady(["More", "المزيد"], 15, "More tab missing")
    }
    tapWhenReady(["Settings", "الإعدادات"], 20, "Settings row missing")
    app.swipeUp()
    app.swipeDown()
    screenshot("10-stress-navigation")

    // App still responsive: the settings header is still reachable.
    waitTappable(
      ["Settings", "الإعدادات"], 15,
      "app unresponsive after navigation stress")
  }

  /// Regression for the RTL top-tab indicator desync (iOS pager-view emits
  /// negative offsets in RTL, which dragged the old position-driven indicator
  /// under the wrong tab). The indicator is now rendered inside each tab and
  /// driven by navigation state: exactly one "tab-indicator-<route.key>"
  /// element is exposed to the accessibility tree — the focused tab's.
  ///
  /// Library category tabs would deserve the same assertion, but a fresh
  /// install has no categories, so that tab bar never renders here.
  func testBrowseTabIndicatorMatchesTappedTabInRTL() {
    app.launch()
    sleep(6)
    if let complete = tappable(["Complete", "إكمال"]), complete.exists {
      complete.tap()
      sleep(3)
    }
    waitTappable(["More", "المزيد"], 120, "bottom tabs did not render")

    // Ensure the Arabic (RTL) UI, reusing the language-switch flow only when
    // a previous test has not already applied it.
    if tappable(["المكتبة"]) == nil {
      tapWhenReady(["More", "المزيد"], 15, "More tab missing")
      tapWhenReady(["Settings", "الإعدادات"], 20, "Settings row missing")
      tapWhenReady(["Appearance", "مظهر"], 20, "Appearance row missing")
      tapWhenReady(["App language", "لغة التطبيق"], 20, "language row missing")
      tapWhenReady(["العربية"], 15, "Arabic option missing")
      tapWhenReady(["Apply now", "تطبيق الآن"], 15, "apply-now dialog missing")
      waitExists(
        app.buttons["المكتبة"].firstMatch, 60,
        "Arabic (RTL) UI did not appear after language switch")
    }
    waitTappable(["المكتبة", "Library"], 20, "library tab missing in RTL")
    screenshot("11-rtl-ready")

    // Browse screen: Sources ("المصادر") is the initial top tab.
    tapWhenReady(["تصفح", "Browse"], 15, "Browse tab missing")
    let sourcesIndicator = element(withIdentifier: "tab-indicator-sources")
    let pluginsIndicator = element(withIdentifier: "tab-indicator-plugins")
    let sourcesTab = app.buttons["المصادر"].firstMatch.exists
      ? app.buttons["المصادر"].firstMatch
      : element(withIdentifier: "browse-tab-sources")
    let pluginsTab = app.buttons["الإضافات"].firstMatch.exists
      ? app.buttons["الإضافات"].firstMatch
      : element(withIdentifier: "browse-tab-plugins")

    waitExists(
      sourcesIndicator, 30, "sources tab indicator missing in RTL")
    XCTAssertTrue(
      sourcesIndicator.isHittable, "sources indicator not hittable in RTL")
    waitVanishes(
      pluginsIndicator, 10,
      "plugins tab indicator active while sources is selected")
    screenshot("12-browse-rtl-indicator-sources")

    // Tap Plugins ("الإضافات"): the indicator must follow the tapped tab.
    tapWhenReady(["الإضافات", "Plugins"], 15, "plugins top tab missing")
    waitExists(
      pluginsIndicator, 15, "plugins tab indicator missing after tap in RTL")
    XCTAssertTrue(
      pluginsIndicator.isHittable, "plugins indicator not hittable in RTL")
    waitVanishes(
      sourcesIndicator, 10,
      "sources tab indicator still active after switching to plugins")
    screenshot("13-browse-rtl-indicator-plugins")

    // Back to Sources, then RAPID alternation — the indicator must never lag
    // onto the neighbouring tab (P0 acceptance case #4).
    tapWhenReady(["المصادر", "Sources"], 15, "sources top tab missing")
    waitSelectedState(sourcesIndicator, sourcesIndicator, pluginsIndicator)
    screenshot("14-browse-rtl-indicator-sources-again")
    for _ in 0..<3 {
      pluginsTab.tap()
      sourcesTab.tap()
    }
    waitSelectedState(sourcesIndicator, sourcesIndicator, pluginsIndicator)
    screenshot("15-browse-rtl-after-rapid-taps")

    // Library category tabs ("افتراضي" / "محلي") — P0 acceptance case #3.
    tapWhenReady(["المكتبة", "Library"], 15, "Library tab missing")
    let defaultIndicator = element(withIdentifier: "tab-indicator-1")
    let localIndicator = element(withIdentifier: "tab-indicator-2")
    waitExists(defaultIndicator, 30, "Default category indicator missing")
    XCTAssertTrue(
      defaultIndicator.isHittable,
      "Default category indicator not active under RTL")
    screenshot("16-library-rtl-indicator-default")
    if localIndicator.waitForExistence(timeout: 10) {
      tapWhenReady(["محلي", "Local"], 15, "Local category tab missing")
      waitExists(localIndicator, 15,
                 "Local category indicator missing after tap")
      XCTAssertTrue(
        localIndicator.isHittable,
        "Local category indicator not hittable after tap")
      waitVanishes(defaultIndicator, 10,
                   "Default indicator still active after selecting Local")
      screenshot("17-library-rtl-indicator-local")
    }
  }

  /// Asserts exactly one of the two indicators is in the accessibility tree
  /// and it is the expected one (state-truth, RTL-agnostic).
  private func waitSelectedState(
    _ expected: XCUIElement, _ a: XCUIElement, _ b: XCUIElement
  ) {
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      if expected.exists && expected.isHittable && !(a.exists && b.exists) {
        return
      }
      sleep(1)
    }
    XCTAssertTrue(
      expected.exists && expected.isHittable && !(a.exists && b.exists),
      "expected exactly one active indicator and it must be the tapped tab")
  }

  /// Runs the REAL reader and browser screens on offline fixtures. The
  /// telemetry is native WKWebView contentOffset, not JS timer estimates.
  private func verifyWebViewMomentum(_ surface: String) {
    app.launchEnvironment["MOON_E2E_SURFACE"] = surface
    app.launch()
    let probe = app.descendants(matching: .any).matching(identifier: "moon-scroll-probe").firstMatch
    waitExists(probe, 60, "actual \(surface) screen did not render")
    sleep(3)
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
    let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30))
    start.press(forDuration: 0.05, thenDragTo: end,
      withVelocity: XCUIGestureVelocity.fast, thenHoldForDuration: 0.0)
    let data = probe.label.data(using: .utf8) ?? Data()
    let metrics = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    let releaseOffset = (metrics["release"] as? NSNumber)?.doubleValue ?? -1
    let momentumOffset = (metrics["y"] as? NSNumber)?.doubleValue ?? -1
    let coast = (metrics["coast"] as? NSNumber)?.doubleValue ?? -1
    XCTAssertGreaterThan(momentumOffset, 50, "drag did not move \(surface)")
    XCTAssertGreaterThan(coast, 10,
      "\(surface) has no native motion after pan release; metrics=\(probe.label)")
    screenshot("\(surface)-momentum")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    Thread.sleep(forTimeInterval: 0.15)
    let stoppedData = probe.label.data(using: .utf8) ?? Data()
    let stopped = (((try? JSONSerialization.jsonObject(with: stoppedData)) as? [String: Any])?["y"] as? NSNumber)?.doubleValue ?? -1
    Thread.sleep(forTimeInterval: 0.25)
    let finalData = probe.label.data(using: .utf8) ?? Data()
    let finalOffset = (((try? JSONSerialization.jsonObject(with: finalData)) as? [String: Any])?["y"] as? NSNumber)?.doubleValue ?? -1
    XCTAssertLessThan(abs(finalOffset - stopped), 5,
      "\(surface) did not stop on touch")
    let attachment = XCTAttachment(string: "surface=\(surface), release=\(releaseOffset), momentum=\(momentumOffset), stopped=\(stopped)")
    attachment.name = "\(surface)-native-scroll-offsets"
    attachment.lifetime = .keepAlways
    add(attachment)
    app.terminate()
  }

  func testReaderHasNativeScrollMomentum() { verifyWebViewMomentum("reader") }
  func testInternalBrowserHasNativeScrollMomentum() { verifyWebViewMomentum("browser") }

}
