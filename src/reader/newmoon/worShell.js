// web/src/reader/worShell.js  →  lnreader-ios/src/reader/newmoon/worShell.js
// Builds the complete Galaxy Novels ("wor-reader") reader interface as a single
// self-contained HTML document, rendered inside the ReaderScreen WebView.
//
// PORT EDITS (New-moon-2 → LNReader iOS, everything else is VERBATIM):
//   (a) Google-Fonts <style> @import + lazy <link> loader removed — the 29
//       picker fonts now resolve to locally bundled TTFs via @font-face rules
//       generated in buildWorShell({ fontsBase }) (see worFonts.js).
//   (b) The report tab + panel + modal and the comments trigger markup were
//       surgically removed (no comment/report backend in LNReader). Their
//       defensive handlers are no-ops and dead CSS selectors were left in the
//       untouched bundles where removal would have required larger edits.
//   (c) Admin tools card stays hidden: the parent passes userRole: ''.
//   (d) No localStorage/sessionStorage is used inside the shell (audited).
//
// The DOM structure, class names and interactions mirror the original
// galaxynovels.com reader (wor-reader theme) one-to-one:
//   - wor-drawer side menu, wor-search overlay
//   - wor-reading-page (novel link + h1 + text surface)
//   - wor-reader-chapter-progress (thin colored progress bar)
//   - wor-reader-dock with 6 panels (book / text / font / background / settings / color)
//   - wor-reader-chapters-sheet + wor-reader-words-sheet
//   - floating dock toggle
//   (report tab/panel/modal + comments trigger: removed in this port)
//
// RN <=> WebView bridge:
//   web -> rn : window.__wor.send(obj)  => postMessage(JSON)
//   rn -> web : injectJavaScript('window.__wor.receive(<json>)')

import WOR_CSS from './worCSS';
import { LINE_FORMATTER_SOURCE } from './formatterSource';
import { WOR_FONTS, WOR_FONT_FACES } from './worFonts';

// ---------------------------------------------------------------------------
// App-specific CSS layered on top of the original bundle (chapter sections,
// dialogue/markdown/bracket highlighting, separators, publisher card, ...).
// ---------------------------------------------------------------------------
export const WOR_APP_CSS = `
  /* ---- hidden attribute must always win ---- */
  [hidden] { display: none !important; }

  /* ---- reading page typography (driven by --wor-reader-* vars) ---- */
  .wor-reader-text-surface { padding-bottom: 8px; }
  .wor-reader-text-surface p { margin: 0 0 1.45em; }
  /* PORT ADDITION: images kept from LNReader's sanitized chapter HTML are
     embedded by sections.ts as <p class="wor-image-p"><img …/></p>. */
  .wor-image-p { text-align: center; margin: 0 0 1.45em; }
  .wor-image-p img { max-width: 100%; height: auto; border-radius: 10px; }
  /* Scrolling smoothness (round 2): in continuous mode the reader accumulates
     many chapters in ONE document. iOS then has to lay out and paint ALL of
     them every frame, so after a few appended chapters scrolling turns heavy
     and sticky ("بصعوبة حتى أمرر لأسفل"). content-visibility lets the engine
     SKIP offscreen chapters entirely (no layout, no paint) while the
     contain-intrinsic-size keeps their scroll height and offsets stable; the
     "auto" keyword remembers each chapter's real size once it has been shown. */
  .wor-chapter-sec {
    display: block;
    content-visibility: auto;
    contain-intrinsic-size: auto 6000px;
  }
  .wor-chapter-title-block {
    font-size: calc(var(--wor-reader-font-size, 18px) + 7px);
    font-weight: 900; color: var(--wor-reader-effective-fg, var(--wor-text));
    line-height: 1.55; margin: 4px 0 6px;
  }
  .wor-chapter-title-block--sub { margin-top: 54px; }
  .wor-custom-sep {
    text-align: center; color: var(--wor-reader-page-muted, var(--wor-muted));
    font-size: .92em; padding: 10px 0; margin: 4px 0 18px; letter-spacing: 2px;
    user-select: none; white-space: pre-wrap;
  }
  .wor-chapter-sep { text-align: center; margin: 46px 0 12px; user-select: none; }
  .wor-chapter-sep .sep-orn {
    display: inline-block; color: var(--wor-reader-page-muted, var(--wor-muted));
    font-size: 14px; padding: 0 18px; position: relative; letter-spacing: 4px; opacity: .8;
  }
  .wor-chapter-sep .sep-orn::before, .wor-chapter-sep .sep-orn::after {
    content: ''; position: absolute; top: 50%; width: 44px; height: 1px;
    background: linear-gradient(to right, transparent, color-mix(in srgb, var(--wor-text) 38%, transparent));
  }
  .wor-chapter-sep .sep-orn::before { right: 100%; }
  .wor-chapter-sep .sep-orn::after { left: 100%; transform: scaleX(-1); }
  .wor-end-mark {
    text-align: center; color: var(--wor-reader-page-muted, var(--wor-muted));
    font-size: 13px; letter-spacing: 8px; margin: 34px 0 6px; user-select: none; opacity: .75;
  }
  .wor-app-copyright { line-height: 1.6; padding: 14px 0; margin: 8px 0; }
  .wor-chapter-divider { border: 0; height: 1px; background: color-mix(in srgb, var(--wor-text) 22%, transparent); margin: 10px 0 26px; }

  /* Keep native text selection and copy available on the reading surface. */
  #worTextSurface, #worTextSurface *, .wor-chapter-title-block, .wor-chapter-sec {
    -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important;
  }
  .moon-copyright-notice { pointer-events: none; }

  /* ---- advanced formatting (dialogue / markdown / brackets / custom) ---- */
  .cm-dialogue-text   { color: var(--wor-fmt-dialogue-color, inherit); font-size: var(--wor-fmt-dialogue-size, 100%); font-weight: var(--wor-fmt-dialogue-weight, inherit); transition: color .3s ease, font-size .3s ease; }
  .cm-markdown-bold   { font-weight: 700; color: var(--wor-fmt-markdown-color, inherit); font-size: var(--wor-fmt-markdown-size, 100%); transition: color .3s ease, font-size .3s ease; }
  .bracket-formatted  { color: var(--wor-fmt-bracket-color, inherit); font-size: var(--wor-fmt-bracket-size, 100%); font-weight: var(--wor-fmt-bracket-weight, inherit); transition: color .3s ease, font-size .3s ease; }
  .custom-formatted   { color: var(--wor-fmt-custom-color, inherit); font-size: var(--wor-fmt-custom-size, 100%); font-weight: var(--wor-fmt-custom-weight, inherit); transition: color .3s ease, font-size .3s ease; }
  .qmark, .mmark, .bmark, .cmark { opacity: 1; transition: opacity .3s ease; }
  body.wor-fmt-hide-quotes   .qmark, body.wor-fmt-hide-quotes   .mq-style { opacity: 0; font-size: 0; }
  body.wor-fmt-hide-markdown .mmark { opacity: 0; font-size: 0; }
  body.wor-fmt-hide-brackets .bmark, body.wor-fmt-hide-brackets .bq-style { opacity: 0; font-size: 0; }
  body.wor-fmt-hide-custom   .cmark { opacity: 0; font-size: 0; }

  /* ---- hide chapter title toggle ---- */
  body.wor-hide-chapter-title .wor-reading-page__header h1 { display: none; }

  /* ---- publisher (author) card ---- */
  .wor-author-section-wrapper { margin-top: 46px; margin-bottom: 18px; border-top: 1px solid color-mix(in srgb, var(--wor-text) 16%, transparent); padding-top: 20px; }
  .wor-author-section-title { color: var(--wor-text); font-size: 16px; font-weight: 800; margin-bottom: 12px; text-align: right; }
  .wor-author-card { border-radius: 18px; overflow: hidden; margin-top: 10px; border: 1px solid color-mix(in srgb, var(--wor-text) 22%, transparent); position: relative; height: 148px; width: 100%; cursor: pointer; }
  .wor-author-banner { position: absolute; width: 100%; height: 100%; background-size: cover; background-position: center; }
  .wor-author-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,.2), rgba(0,0,0,.82)); z-index: 1; }
  .wor-author-content { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 2; width: 100%; }
  .wor-author-avatar-wrapper { width: 76px; height: 76px; border-radius: 38px; border: 3px solid #fff; background-color: #333; margin-bottom: 8px; overflow: hidden; }
  .wor-author-avatar-img { width: 100%; height: 100%; object-fit: cover; }
  .wor-author-name { color: #fff; font-size: 20px; font-weight: 700; text-shadow: 0 1px 6px rgba(0,0,0,.9); text-align: center; }

  /* ---- continuous-scroll footer ---- */ (PORT EDIT: comments-trigger CSS removed)
  .wor-continuous-footer { text-align: center; color: var(--wor-muted); font-size: .85rem; font-weight: 700; padding: 14px 0 6px; user-select: none; }

  /* ---- reading-area padding above the dock (no fixed topbar) ---- */
  :root { --wor-topbar-h: 0px; }
  .wor-reader-main { padding-top: calc(var(--wor-topbar-h, 0px) + var(--wor-safe-top, 0px) + 14px); padding-bottom: calc(var(--wor-reader-dock-height, 242px) + var(--wor-safe-bottom, 0px) + 30px); }
  body.wor-reader-dock-collapsed .wor-reader-main { padding-bottom: calc(96px + var(--wor-safe-bottom, 0px)); }

  /* ---- toast ---- */
  .wor-mini-toast { position: fixed; inset-inline: 0; bottom: calc(var(--wor-safe-bottom, 0px) + 84px); display: flex; justify-content: center; z-index: 3000; pointer-events: none; }
  .wor-mini-toast span { background: color-mix(in srgb, var(--wor-surface-solid) 92%, transparent); border: 1px solid var(--wor-border); color: var(--wor-text); border-radius: 999px; padding: 9px 18px; font-size: .8rem; font-weight: 800; box-shadow: var(--wor-shadow); opacity: 0; transform: translateY(6px); transition: opacity .25s ease, transform .25s ease; }
  .wor-mini-toast.is-visible span { opacity: 1; transform: translateY(0); }

  /* ---- boot loader ---- */
  .wor-boot-loading { position: fixed; inset: 0; display: grid; place-items: center; z-index: 4000; background: var(--wor-bg, #000); transition: opacity .3s ease, visibility 0s linear .35s; }
  .wor-boot-loading.is-done { opacity: 0; pointer-events: none; visibility: hidden; }
  .wor-boot-spinner { width: 42px; height: 42px; border-radius: 50%; border: 3px solid color-mix(in srgb, var(--wor-text, #fff) 18%, transparent); border-top-color: var(--wor-accent, #808080); animation: wor-boot-spin 1s linear infinite; }
  @keyframes wor-boot-spin { to { transform: rotate(360deg); } }

  /* ---- search results reuse chapter items ---- */
  .wor-search__results { display: grid; gap: 7px; max-height: 46dvh; overflow: auto; padding: 4px 2px; }

  /* ---- drawer user card ---- */
  .wor-drawer-user { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--wor-border); border-radius: 16px; background: var(--wor-surface-soft); margin: 0 0 14px; }
  .wor-drawer-user__avatar { flex: 0 0 44px; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--wor-accent-soft); color: var(--wor-accent); font-weight: 900; font-size: 1.05rem; }
  .wor-drawer-user__meta { min-width: 0; display: grid; gap: 2px; }
  .wor-drawer-user__meta strong { color: var(--wor-text); font-size: .92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wor-drawer-user__meta small { color: var(--wor-muted); font-size: .74rem; font-weight: 700; }

  /* ---- color picker canvases ---- */ (PORT EDIT: report-type CSS removed)
  .wor-reader-background-picker__canvas, .wor-reader-chapter-progress-color-picker__canvas { position: relative; overflow: hidden; }
  .wor-reader-background-picker__canvas canvas, .wor-reader-chapter-progress-color-picker__canvas canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .wor-reader-background-picker__handle, .wor-reader-chapter-progress-color-picker__canvas .wor-picker-handle { z-index: 2; }

  /* ---- words sheet (Galaxy "تغيير الكلمات") additions ---- */
  .wor-reader-words-color-control[aria-hidden="true"] { display: none; }
  .wor-reader-words-check.is-on { border-color: color-mix(in srgb, var(--wor-accent) 48%, var(--wor-border)); background: linear-gradient(180deg, color-mix(in srgb, var(--wor-accent-soft) 56%, var(--wor-surface-soft)), color-mix(in srgb, var(--wor-accent-soft) 86%, var(--wor-surface))); }
  .wor-reader-words-check input[type="radio"] { accent-color: var(--wor-accent); }
  .wor-reader-words-item.is-editing { border-color: var(--wor-accent); }
  .wor-reader-words-item__color { flex: 0 0 auto; }
  .wor-reader-words-color-dot { cursor: pointer; }
  .wor-reader-words-library__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-block-end: 8px; }
  .wor-reader-words-library__head strong { font-size: .92rem; font-weight: 950; }
  .wor-reader-words-library__head span { min-inline-size: 30px; text-align: center; padding: 3px 9px; border: 1px solid var(--wor-border); border-radius: 999px; background: var(--wor-accent-soft); color: var(--wor-accent); font-size: .76rem; font-weight: 950; }

  /* ---- active states for background presets ---- */
  .wor-reader-background-preset.is-active { border-color: color-mix(in srgb, var(--wor-accent) 60%, var(--wor-border)); background: var(--wor-accent-soft); }

  /* ---- misc ---- */
  .wor-icon-btn[disabled], .wor-reader-dock__nav[disabled] { opacity: .35; pointer-events: none; }
  #worTextSurface { min-height: 40dvh; }

  /* ==========================================================================
     18e fixes & polish
     ========================================================================== */

  /* The panel UI must always use the modern UI font — never the reading font.
     (The shell body was also missing the "wor-body" class, which left the whole
     chrome on the browser default serif.) */
  :root { --wor-ui-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Arabic", system-ui, "Segoe UI", Tahoma, Arial, sans-serif; }
  .wor-reader-dock, .wor-reader-dock button, .wor-reader-dock input, .wor-reader-dock output,
  .wor-reader-chapters-sheet, .wor-reader-words-sheet, .wor-search, .wor-drawer,
  .wor-mini-toast, .wor-boot-loading {
    font-family: var(--wor-ui-font);
  }

  /* Dock grid: [nav][panel -> the ONE flexible/scrollable row][tabs fixed].
     The bundled stylesheet assumed an in-dock toggle as a 4th row, so with our
     DOM the panel sat on an "auto" row (growing with its content and pushing /
     squeezing the tab bar). Pinning the rows fixes tabs that moved or vanished. */
  .wor-reader-dock:is([data-wor-reader-active-panel="book"],[data-wor-reader-active-panel="text"],[data-wor-reader-active-panel="font"],[data-wor-reader-active-panel="background"],[data-wor-reader-active-panel="color"],[data-wor-reader-active-panel="settings"],[data-wor-reader-active-panel="report"]) {
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
  .wor-reader-dock__panel { min-block-size: 0; }
  /* The bundled scroll rule (overflow:auto + overscroll-behavior:contain) only
     covers text/font/background/settings/report — Galaxy never shipped the
     coloring panel, so its content could NOT scroll at all: every drag fell
     through to the chapter behind the dock. The book panel had the same hole. */
  .wor-reader-dock:is([data-wor-reader-active-panel="color"],[data-wor-reader-active-panel="book"]) > .wor-reader-dock__panel {
    min-block-size: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    padding-inline-end: 2px;
  }
  .wor-reader-dock__tabs { grid-template-columns: repeat(7, minmax(0, 1fr)); }

  /* Text brightness (سطوع الخط) is implemented by computing the effective text
     color in JS (applyTheme) instead of a CSS "filter: brightness()". A filter on
     the huge text surface forces iOS to re-composite the ENTIRE chapter every
     scroll frame — that was the main cause of the stuttering scroll.
     The variable is kept only for backwards compatibility. */
  :root { --wor-reader-text-brightness: 1; }

  /* Scrolling smoothness: no CSS smooth-scroll fighting the finger, and no
     permanent backdrop blur repaint over the whole dock while the page moves.
     The dock background must be FULLY OPAQUE — translucent layers over moving
     text cost an extra blend pass on every frame. */
  html { scroll-behavior: auto !important; }
  .wor-reader-dock {
    -webkit-backdrop-filter: none; backdrop-filter: none;
    background: var(--wor-surface-solid);
  }
  .wor-reader-dock__panel, .wor-reader-dock__tabs { background: transparent; }

  /* Panel switch animation (keyframes ship with the bundle) */
  .wor-reader-dock__panel.is-entering { animation: worReaderPanelIn 150ms ease-out both; }

  /* ---- coloring panel (التلوين) ---- */
  .wor-color-wrap { display: grid; gap: 9px; align-content: start; padding-block-end: 4px; }
  .wor-color-hint { margin: 0 2px; color: var(--wor-muted); font-size: .74rem; font-weight: 700; line-height: 1.6; }
  .wor-fmt-card { display: grid; gap: 10px; padding: 12px; border: 1px solid color-mix(in srgb, var(--wor-border) 88%, transparent); border-radius: 15px; background: color-mix(in srgb, var(--wor-surface) 89%, transparent); transition: opacity .25s ease; }
  .wor-fmt-card.is-off { opacity: .62; }
  .wor-fmt-card__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .wor-fmt-card__head h3 { margin: 0; color: var(--wor-text); font-size: .82rem; font-weight: 950; }
  .wor-fmt-card__sub { margin: 0; color: var(--wor-muted); font-size: .7rem; font-weight: 850; }
  .wor-fmt-card__label { color: var(--wor-muted); font-size: .72rem; font-weight: 900; margin-inline: 2px; }
  .wor-color-grid { display: flex; flex-wrap: wrap; gap: 7px; }
  .wor-color-dot { inline-size: 30px; block-size: 30px; padding: 0; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--wor-border) 90%, transparent); cursor: pointer; transition: transform 90ms ease, border-color 150ms ease, box-shadow 150ms ease; }
  .wor-color-dot:active { transform: scale(.9); }
  .wor-color-dot.is-active { border-color: var(--wor-text); box-shadow: 0 0 0 2px color-mix(in srgb, var(--wor-accent) 55%, transparent), 0 2px 10px rgba(0,0,0,.28); }
  .wor-style-row { display: flex; flex-wrap: wrap; gap: 7px; }
  .wor-style-chip { min-block-size: 40px; padding: 8px 12px; border: 1px solid var(--wor-border); border-radius: 12px; background: var(--wor-surface-soft); color: var(--wor-text); font: inherit; font-size: .78rem; font-weight: 900; cursor: pointer; transition: transform 90ms ease, border-color 150ms ease, color 150ms ease, background-color 150ms ease; }
  .wor-style-chip:active { transform: scale(.97); }
  .wor-style-chip.is-active { border-color: var(--wor-accent); background: var(--wor-accent-soft); color: var(--wor-accent); }
  .wor-custom-marks { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
  .wor-custom-marks input { min-block-size: 42px; padding: 8px 10px; border: 1px solid var(--wor-border); border-radius: 12px; background: var(--wor-surface-soft); color: var(--wor-text); font: inherit; font-size: .95rem; font-weight: 800; text-align: center; outline: none; }
  .wor-custom-marks input:focus { border-color: color-mix(in srgb, var(--wor-accent) 55%, var(--wor-border)); }
  .wor-custom-marks__arrow { color: var(--wor-muted); font-weight: 900; }

  /* ==========================================================================
     Zeus chapter translation (tr*) — pill + status/offer cards.
     The layer is pointer-events:none so it can never block reading/scroll;
     only the pill/cards themselves opt back in. z-index sits BELOW the shell's
     sheets (chapters 1200 / search 1300 / toast 3000) but above the dock.
     ========================================================================== */
  .wor-tr-layer {
    position: fixed; left: 0; right: 0;
    top: calc(var(--wor-safe-top, 0px) + var(--wor-topbar-h, 0px) + 12px);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    z-index: 1100; pointer-events: none; font-family: var(--wor-ui-font);
  }
  .wor-tr-pill {
    pointer-events: auto; -webkit-appearance: none; appearance: none; cursor: pointer;
    max-width: 86vw; padding: 8px 16px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--wor-accent) 45%, var(--wor-border));
    background: var(--wor-surface-solid); color: var(--wor-accent);
    font: inherit; font-family: var(--wor-ui-font); font-size: 14px; font-weight: 800;
    box-shadow: var(--wor-shadow); transition: transform 90ms ease;
  }
  .wor-tr-pill:active { transform: scale(.97); }
  .wor-tr-card {
    pointer-events: auto; display: flex; align-items: center; gap: 8px;
    max-width: min(92vw, 430px); padding: 9px 10px 9px 12px; border-radius: 16px;
    border: 1px solid var(--wor-border); background: var(--wor-surface-solid);
    color: var(--wor-text); box-shadow: var(--wor-shadow); font-size: 13px;
  }
  .wor-tr-card__body { display: grid; gap: 1px; min-width: 0; }
  .wor-tr-card__body strong {
    font-size: .84rem; font-weight: 900; color: var(--wor-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wor-tr-card__body span { color: var(--wor-muted); font-size: .72rem; font-weight: 800; }
  .wor-tr-card__body small {
    color: var(--wor-warning); font-size: .7rem; font-weight: 700; max-width: 58vw;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wor-tr-card--error .wor-tr-card__body small { color: var(--wor-danger); }
  .wor-tr-card__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-inline-start: auto; }
  .wor-tr-btn {
    -webkit-appearance: none; appearance: none; cursor: pointer; min-height: 34px;
    padding: 6px 14px; border-radius: 999px; font-family: var(--wor-ui-font);
    border: 1px solid color-mix(in srgb, var(--wor-accent) 45%, var(--wor-border));
    background: var(--wor-accent-soft); color: var(--wor-accent);
    font-size: .76rem; font-weight: 900; transition: transform 90ms ease;
  }
  .wor-tr-btn:active { transform: scale(.97); }
  .wor-tr-icon {
    -webkit-appearance: none; appearance: none; cursor: pointer; flex: 0 0 auto;
    inline-size: 34px; block-size: 34px; display: grid; place-items: center;
    border-radius: 50%; border: 1px solid var(--wor-border); padding: 0;
    background: transparent; color: var(--wor-muted); transition: transform 90ms ease;
  }
  .wor-tr-icon svg { width: 16px; height: 16px; }
  .wor-tr-icon:active { transform: scale(.94); }
`;

// ---------------------------------------------------------------------------
// Background presets offered by the "الخلفية" panel (labels + order identical
// to the original reader; values chosen to match the original dark family).
// ---------------------------------------------------------------------------
export const WOR_BG_PRESETS = [
  { value: 'black', name: 'أسود', bg: '#000000', text: '#ffffff' },
  { value: 'soft', name: 'داكن مريح', bg: '#16181d', text: '#eef1f6' },
  { value: 'charcoal', name: 'فحمي', bg: '#232323', text: '#f3f3f3' },
  { value: 'gray', name: 'رمادي', bg: '#2e2e2e', text: '#f5f5f5' },
  { value: 'darker', name: 'داكن جداً', bg: '#0b0b0b', text: '#ededed' },
];

// Palette offered by the coloring panel (same swatches as the classic reader)
export const WOR_FORMAT_COLORS = [
  '#ffffff',
  '#f97316',
  '#ec4899',
  '#a855f7',
  '#fbbf24',
  '#ef4444',
  '#3b82f6',
  '#4ade80',
  '#06b6d4',
  '#8b5cf6',
  '#f472b6',
  '#34d399',
  '#f87171',
  '#facc15',
  '#818cf8',
  '#888888',
  '#000000',
];

// ---------------------------------------------------------------------------
// The bridge script (runs inside the WebView). Placeholders wrapped in single
// quotes ('__WOR_*__') are replaced with real JSON in buildWorShell below.
// (PORT EDIT: REPORT_TYPES removed with the report UI.)
// ---------------------------------------------------------------------------
function bridgeScript() {
  return `
(function () {
  'use strict';
  // ============================ state ============================
  var S = '__WOR_SETTINGS__';
  var formatLine = '__WOR_FORMATTER__';
  var USER = '__WOR_USER__';
  var FONTS = '__WOR_FONTS__';
  var BG_PRESETS = '__WOR_BG_PRESETS__';
  var CH = null;
  var CHAPTERS = [];
  // 🔥 lazy chapters: الإجمالي الحقيقي من الأب + نتائج بحث الخادم
  // (0 = غير معروف = التطبيق يرسل القائمة كاملة كما هو — توافق تام رجعياً)
  var CHAPTERS_TOTAL = 0;
  var serverSearchResults = null; // { q, results, total }
  var lastServerSearchQ = null;
  // (words state lives in the words sheet section below)
  var CHAPTERS_PAGE = 100;
  var chaptersPageCount = 1;
  var chaptersSortDesc = false;
  var chaptersSearch = '';
  var searchQ = '';
  var dockOpen = true;
  var dockEl = null;
  var autoScrollRaf = null;
  var lastTouchAt = 0;
  var userTouched = false;
  var touchStartScrollY = 0;
  var favOn = false;
  var customColors = false;
  var pickers = {};
  var pendingScroll = 0;
  var restoreEpoch = 0;

  // ============================ helpers ============================
  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $all(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
  function send(o) { try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o)); else if (window.parent) window.parent.postMessage(JSON.stringify(o), '*'); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function hexToRgb(hex) {
    hex = String(hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var n = parseInt(hex, 16);
    if (isNaN(n)) n = 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) { var c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  function mix(hexA, hexB, t) {
    var a = hexToRgb(hexA), b = hexToRgb(hexB);
    function m(x, y) { return Math.round(x * (1 - t) + y * t); }
    function h(v) { var s = v.toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(m(a.r, b.r)) + h(m(a.g, b.g)) + h(m(a.b, b.b));
  }
  function isLight(hex) { var c = hexToRgb(hex); return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) > 150; }

  var toastTimer = null;
  function toast(text) {
    var el = $('#worMiniToast'); if (!el) return;
    $('span', el).textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 1800);
  }

  // ============================ fonts ============================
  // PORT EDIT: every WOR font resolves to a locally bundled TTF that is
  // declared with @font-face in <head> at build time (see buildWorShell), so
  // the old Google-Fonts lazy <link> loader is gone. @font-face files load
  // on demand the first time a family is used — no network, no <link>.
  var loadedFonts = {};
  function fontByValue(value) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].value === value) return FONTS[i];
    return FONTS[0];
  }
  function ensureFont(value) {
    // Kept for call-site compatibility (applyTypography/boot). All faces are
    // local now; nothing to inject. A late local-font swap still reflows the
    // document, so section-top caches are invalidated once fonts settle.
    var f = fontByValue(value);
    if (!f || !f.local || loadedFonts[f.value]) return;
    loadedFonts[f.value] = true;
    invalidateSectionTops();
  }
  function preloadFonts() {
    if (S.fontValue && S.fontValue !== 'default') ensureFont(S.fontValue);
  }

  // ============================ theme ============================
  function brightnessAdjusted(hex, b) {
    // brightness < 1 → darker text, > 1 → brighter text (same visual result the
    // old CSS filter produced, but with ZERO per-frame compositing cost).
    var f = parseFloat(b);
    if (isNaN(f)) f = 1;
    if (f < 1) return mix(hex, '#000000', Math.min(1 - f, 0.92));
    if (f > 1) return mix(hex, '#ffffff', Math.min((f - 1) * 0.85, 0.85));
    return hex;
  }

  function applyTheme() {
    var root = document.documentElement;
    var bg = S.bgColor || '#000000';
    var text = S.textColor || '#ffffff';
    var accent = S.accent || '#808080';
    var effText = brightnessAdjusted(text, S.brightness);
    var dark = !isLight(bg);
    var soft = mix(bg, dark ? '#ffffff' : '#000000', 0.055);
    root.setAttribute('data-wor-theme', 'custom');
    root.setAttribute('style', ''
      + '--wor-bg:' + bg + ';'
      + '--wor-surface:' + rgba(bg, dark ? 0.9 : 0.96) + ';'
      + '--wor-surface-solid:' + mix(bg, dark ? '#0a0a0a' : '#ffffff', 0.35) + ';'
      + '--wor-surface-soft:' + soft + ';'
      + '--wor-text:' + text + ';'
      + '--wor-muted:' + rgba(text, 0.66) + ';'
      + '--wor-accent:' + accent + ';'
      + '--wor-accent-soft:' + rgba(accent, 0.16) + ';'
      + '--wor-border:' + rgba(text, 0.15) + ';'
      + '--wor-danger:#fb7185;--wor-success:#4ade80;--wor-warning:#fbbf24;'
      + '--wor-shadow:0 18px 50px rgba(0,0,0,' + (dark ? 0.4 : 0.18) + ');'
      + '--wor-reader-page-bg:' + bg + ';'
      + '--wor-reader-page-fg:' + effText + ';'
      + '--wor-reader-effective-fg:' + effText + ';'
      + '--wor-reader-page-muted:' + rgba(effText, 0.68) + ';'
      + '--wor-reader-font-family-active:inherit;'
      + '--wor-reader-chapter-progress-color:' + (S.progressBarColor || '#00ffff') + ';'
      + 'color-scheme:' + (dark ? 'dark' : 'light') + ';'
      + '--wor-safe-top:' + (S.safeTop || 0) + 'px;'
      + '--wor-safe-bottom:' + (S.safeBottom || 0) + 'px;'
    );
    document.body.style.background = bg;
    document.body.style.color = text;
  }

  function applyTypography() {
    var root = document.documentElement;
    var fam = 'inherit';
    var f = fontByValue(S.fontValue || 'default');
    if (f) fam = f.family;
    if (S.fontValue && S.fontValue !== 'default') ensureFont(S.fontValue);
    var dir = S.direction === 'ltr' ? 'ltr' : 'rtl';
    var align = S.direction === 'center' ? 'center' : (S.direction === 'ltr' ? 'left' : 'right');
    root.style.setProperty('--wor-reader-font-size', (S.fontSize || 18) + 'px');
    root.style.setProperty('--wor-reader-line-height', String(S.lineHeight || 2.3));
    root.style.setProperty('--wor-reader-word-spacing', (S.wordSpacing || 0) + 'px');
    root.style.setProperty('--wor-reader-text-brightness', String(S.brightness || 1));
    root.style.setProperty('--wor-reader-font-weight', String(S.fontWeight || 400));
    root.style.setProperty('--wor-reader-text-direction', dir);
    root.style.setProperty('--wor-reader-text-align', align);
    root.style.setProperty('--wor-reader-font-family', fam);
    invalidateSectionTops(); // font metrics changed → every section top moved
    var fmt = [
      ['--wor-fmt-dialogue-color', S.enableDialogue ? S.dialogueColor : null],
      ['--wor-fmt-dialogue-size', S.enableDialogue ? (S.dialogueSize + '%') : null],
      ['--wor-fmt-dialogue-weight', S.enableDialogue ? '700' : null],
      ['--wor-fmt-markdown-color', S.enableMarkdown ? S.markdownColor : null],
      ['--wor-fmt-markdown-size', S.enableMarkdown ? (S.markdownSize + '%') : null],
      ['--wor-fmt-bracket-color', S.enableBracket ? S.bracketColor : null],
      ['--wor-fmt-bracket-size', S.enableBracket ? (S.bracketSize + '%') : null],
      ['--wor-fmt-bracket-weight', S.enableBracket ? '700' : null],
      ['--wor-fmt-custom-color', S.enableCustom ? S.customColor : null],
      ['--wor-fmt-custom-size', S.enableCustom ? (S.customSize + '%') : null],
      ['--wor-fmt-custom-weight', S.enableCustom ? '700' : null]
    ];
    fmt.forEach(function (p) { if (p[1] != null) root.style.setProperty(p[0], p[1]); else root.style.removeProperty(p[0]); });
    document.body.classList.toggle('wor-fmt-hide-quotes', !!S.hideQuotes);
    document.body.classList.toggle('wor-fmt-hide-markdown', !!S.hideMarkdownMarks);
    document.body.classList.toggle('wor-fmt-hide-brackets', !!S.hideBracketMarks);
    document.body.classList.toggle('wor-fmt-hide-custom', !!S.hideCustomMarks);
    document.body.classList.toggle('wor-hide-chapter-title', !!S.hideTitle);
  }

  function applyProgressBar() {
    var bar = $('.wor-reader-chapter-progress');
    if (bar) {
      if (S.showProgressBar === false) { bar.setAttribute('aria-hidden', 'true'); bar.style.display = 'none'; }
      else { bar.removeAttribute('aria-hidden'); bar.style.display = ''; }
    }
    document.documentElement.style.setProperty('--wor-reader-chapter-progress-color', S.progressBarColor || '#00ffff');
  }

  function setRangeValue(id, value, suffix) {
    var el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    var out = el.parentElement.querySelector('output');
    if (out) out.textContent = value + suffix;
  }
  function setActiveChoice(scopeSel, value) {
    $all(scopeSel + ' [data-value]').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-value') === String(value));
    });
  }
  function setSwitch(sel, on) {
    var el = $(sel);
    if (!el) return;
    el.classList.toggle('is-active', !!on);
    el.textContent = on ? 'مفعّل' : 'مغلق';
  }

  function updateColorDots(key, val) {
    $all('[data-wor-color-for="' + key + '"] .wor-color-dot').forEach(function (d) {
      d.classList.toggle('is-active', String(d.getAttribute('data-value') || '').toLowerCase() === String(val || '').toLowerCase());
    });
  }
  function updateFmtCards() {
    [['dialogue', 'enableDialogue'], ['markdown', 'enableMarkdown'], ['bracket', 'enableBracket'], ['custom', 'enableCustom']].forEach(function (p) {
      var card = $('.wor-fmt-card[data-wor-fmt-card="' + p[0] + '"]');
      if (card) card.classList.toggle('is-off', !S[p[1]]);
    });
  }

  function applySettingsUI() {
    applyTheme();
    applyTypography();
    applyProgressBar();
    setRangeValue('worRangeFontSize', S.fontSize || 18, 'px');
    setRangeValue('worRangeLineHeight', S.lineHeight || 2.3, '');
    setRangeValue('worRangeWordSpacing', S.wordSpacing || 0, 'px');
    setRangeValue('worRangeBrightness', S.brightness || 1, '');
    setActiveChoice('#wor-reader-panel-text [data-wor-weight]', S.fontWeight || 400);
    setActiveChoice('#wor-reader-panel-text [data-wor-direction]', S.direction || 'rtl');
    setActiveChoice('[data-wor-font-choice]', S.fontValue || 'default');
    setActiveChoice('[data-wor-bg-preset]', customColors ? '__none__' : (S.bgPreset || '__none__'));
    setSwitch('[data-wor-chapter-progress-toggle]', S.showProgressBar !== false);
    setSwitch('[data-wor-switch="continuous"]', !!S.continuousMode);
    setSwitch('[data-wor-switch="autoscroll"]', !!S.autoScroll);
    setSwitch('[data-wor-switch="keepawake"]', !!S.keepAwake);
    setSwitch('[data-wor-switch="hidetitle"]', !!S.hideTitle);
    setSwitch('[data-wor-switch="taptoggle"]', S.tapToToggle !== false);
    // coloring panel (التلوين)
    setSwitch('[data-wor-switch="dialogue"]', !!S.enableDialogue);
    setSwitch('[data-wor-switch="markdown"]', !!S.enableMarkdown);
    setSwitch('[data-wor-switch="bracket"]', !!S.enableBracket);
    setSwitch('[data-wor-switch="custom"]', !!S.enableCustom);
    setSwitch('[data-wor-switch="hidequotes"]', !!S.hideQuotes);
    setSwitch('[data-wor-switch="hidemarkdown"]', !!S.hideMarkdownMarks);
    setSwitch('[data-wor-switch="hidebrackets"]', !!S.hideBracketMarks);
    setSwitch('[data-wor-switch="hidecustom"]', !!S.hideCustomMarks);
    setRangeValue('worRangeDialogueSize', S.dialogueSize || 100, '%');
    setRangeValue('worRangeMarkdownSize', S.markdownSize || 100, '%');
    setRangeValue('worRangeBracketSize', S.bracketSize || 110, '%');
    setRangeValue('worRangeCustomSize', S.customSize || 105, '%');
    setActiveChoice('[data-wor-fmt-style="quote"]', S.selectedQuoteStyle || 'all');
    setActiveChoice('[data-wor-fmt-style="markdown"]', S.selectedMarkdownStyle || 'all');
    setActiveChoice('[data-wor-fmt-style="bracket"]', S.selectedBracketStyle || 'all');
    updateColorDots('dialogueColor', S.dialogueColor);
    updateColorDots('markdownColor', S.markdownColor);
    updateColorDots('bracketColor', S.bracketColor);
    updateColorDots('customColor', S.customColor);
    var coIn = $('#worCustomOpenMark'), ccIn = $('#worCustomCloseMark');
    if (coIn && document.activeElement !== coIn) coIn.value = S.customOpenMark || '';
    if (ccIn && document.activeElement !== ccIn) ccIn.value = S.customCloseMark || '';
    updateFmtCards();
    var ct = $('[data-wor-background-custom-toggle]');
    if (ct) {
      ct.classList.toggle('is-active', !!customColors);
      ct.classList.toggle('is-inactive', !customColors);
      var lab = $('[data-wor-background-custom-toggle-label]', ct);
      if (lab) lab.textContent = customColors ? 'مفعّل' : 'غير مفعّل';
      var pal = $('#wor-reader-panel-background .wor-reader-background-palette');
      if (pal) pal.style.display = customColors ? '' : 'none';
    }
    if (pickers.bg) pickers.bg.set(S.bgColor || '#000000');
    if (pickers.text) pickers.text.set(S.textColor || '#ffffff');
    if (pickers.progress) pickers.progress.set(S.progressBarColor || '#00ffff');
    updateFavUI();
    updateAutoScroll();
  }

  // ============================ dock ============================
  function setDock(open) {
    dockOpen = !!open;
    if (!dockEl) return;
    dockEl.setAttribute('data-wor-reader-dock-state', dockOpen ? 'open' : 'closed');
    document.body.classList.toggle('wor-reader-dock-collapsed', !dockOpen);
    // Tell React so the NATIVE system status bar follows the dock:
    // dock hidden → immersive reading (status bar hidden), dock open → visible.
    send({ t: 'dock', open: dockOpen });
    if (dockOpen) {
      dockEl.style.transform = '';
      dockEl.style.opacity = '';
      dockEl.style.pointerEvents = '';
      dockEl.style.visibility = '';
      var h = dockEl.offsetHeight || 242;
      document.documentElement.style.setProperty('--wor-reader-dock-height', h + 'px');
      document.documentElement.style.setProperty('--wor-reader-dock-toggle-bottom', (h + 16) + 'px');
    } else {
      dockEl.style.transform = 'translate3d(0,120%,0)';
      dockEl.style.opacity = '0';
      dockEl.style.pointerEvents = 'none';
      dockEl.style.visibility = 'hidden';
      document.documentElement.style.setProperty('--wor-reader-dock-height', '0px');
      document.documentElement.style.setProperty('--wor-reader-dock-toggle-bottom', '12px');
    }
    var tog = $('.wor-reader-dock__toggle--floating');
    if (tog) tog.setAttribute('aria-expanded', dockOpen ? 'true' : 'false');
  }

  // ============================ autoscroll ============================
  function updateAutoScroll() {
    if (S.autoScroll && !autoScrollRaf) {
      var step = function () {
        autoScrollRaf = null;
        if (!S.autoScroll) return;
        if (!document.hidden && Date.now() - lastTouchAt > 2200) window.scrollBy(0, 0.55);
        autoScrollRaf = requestAnimationFrame(step);
      };
      autoScrollRaf = requestAnimationFrame(step);
    } else if (!S.autoScroll && autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  }

  // ============================ scroll / progress ============================
  var lastSent = 0;
  var scrollRaf = 0;
  var lastDockNum = 0;
  // Cache of [num, offsetTop] per section. Reading offsetTop for EVERY section
  // on every scroll tick forces a synchronous layout of a potentially huge
  // document (chapter sections + appended chapters) — a classic jank source.
  // The cache is rebuilt only when chapters are appended/removed or the page
  // size changes.
  var sectionTopsCache = [];
  function invalidateSectionTops() { sectionTopsCache = []; }
  function getSectionTops() {
    if (!sectionTopsCache.length) {
      var secs = $all('.wor-chapter-sec[data-ch]');
      sectionTopsCache = secs.map(function (s) {
        return { num: parseInt(s.getAttribute('data-ch'), 10) || 0, top: s.offsetTop };
      });
    }
    return sectionTopsCache;
  }
  function activeSectionAt(y) {
    // Returns the section the reader is currently in + its absolute top, so the
    // saved offset can be stored PER CHAPTER (offset inside that chapter) —
    // this is what makes resume land exactly where the user stopped.
    var tops = getSectionTops();
    var cur = tops.length ? { num: tops[0].num, top: tops[0].top } : { num: 0, top: 0 };
    for (var i = 0; i < tops.length; i++) {
      if (tops[i].top - 90 <= y) cur = { num: tops[i].num, top: tops[i].top };
      else break;
    }
    return cur;
  }
  // ==================== DOM windowing (scroll round 3) ====================
  // content-visibility:auto only skips offscreen layout/paint on iOS 18+. On
  // older iOS the ever-growing continuous-mode document is still laid out in
  // full every frame, so scrolling degrades chapter after chapter ("بصعوبة
  // حتى أمرر لأسفل"). We keep only a WINDOW of chapters as real DOM: sections
  // far above (already read) and far below (not yet reached) are unloaded into
  // a string stash while their measured height is preserved via min-height —
  // scroll geometry, the dock progress and the v2 resume protocol all stay
  // stable. Sections entering the keep-window are restored one per frame, and
  // a re-anchor scroll corrects any height delta for restores above the
  // viewport. Works on every iOS version; on iOS 18+ it simply adds DOM-node
  // savings on top of content-visibility.
  var WOR_KEEP_ABOVE = 2, WOR_KEEP_BELOW = 3;
  var WOR_UNLOAD_ABOVE = 5, WOR_UNLOAD_BELOW = 6;
  var chapterHtmlStash = {};
  function resetChapterStash() { chapterHtmlStash = {}; }
  function sectionNum(s) { return parseInt(s.getAttribute('data-ch'), 10) || 0; }
  function unloadSection(s) {
    var num = sectionNum(s);
    if (chapterHtmlStash[num]) return;
    var prevMin = parseFloat(s.style.minHeight) || 0;
    chapterHtmlStash[num] = s.innerHTML;
    var h = s.offsetHeight;
    if (!h || h < 200) h = prevMin || 6000; // never-rendered section → placeholder
    s.style.minHeight = h + 'px';
    // v3 scroll fix: sync the content-visibility placeholder with the REAL
    // measured height. A mismatched 'auto 6000px' placeholder forces WebKit
    // scroll-anchoring corrections mid-gesture (jumps + dropped momentum).
    s.style.containIntrinsicSize = 'auto ' + h + 'px';
    s.setAttribute('data-wor-unloaded', '1');
    s.innerHTML = '';
  }
  function restoreSection(s) {
    var num = sectionNum(s);
    var html = chapterHtmlStash[num];
    if (!html) return 0;
    var mh = parseFloat(s.style.minHeight) || 0;
    s.innerHTML = html;
    s.style.minHeight = '';
    s.style.containIntrinsicSize = '';
    s.removeAttribute('data-wor-unloaded');
    delete chapterHtmlStash[num];
    return s.offsetHeight - mh; // height delta for scroll re-anchoring
  }
  // v3 scroll fix: NEVER re-anchor (window.scrollTo) while the user is still
  // dragging or momentum-scrolling — a programmatic scrollTo during an active
  // WKWebView pan CANCELS the native gesture and its inertia (the reported
  // "drag moves a bit then stops"). Anchoring happens only once scrolling has
  // truly been idle, and at most twice per second.
  var lastAnchorAt = 0;
  function touchIdleForAnchoring() {
    return !touchActive && (Date.now() - lastTouchEndAt > 350) && (Date.now() - lastScrollAt > 180);
  }
  function enforceWindow(y) {
    var secs = $all('.wor-chapter-sec[data-ch]');
    if (secs.length <= WOR_UNLOAD_ABOVE + WOR_UNLOAD_BELOW + 2) return;
    var tops = getSectionTops();
    var activeIdx = 0;
    for (var i = 0; i < tops.length; i++) { if (tops[i].top - 90 <= y) activeIdx = i; else break; }
    var changed = false;
    // 1) unload everything outside the keep-window (heights preserved)
    for (var j = 0; j < secs.length; j++) {
      var rel = j - activeIdx;
      if ((rel < -WOR_UNLOAD_ABOVE || rel > WOR_UNLOAD_BELOW) && !secs[j].getAttribute('data-wor-unloaded')) {
        unloadSection(secs[j]);
        changed = true;
      }
    }
    // 2) restore the nearest unloaded section that entered the keep-window
    //    (ONE per frame to keep the frame budget; hysteresis vs the unload
    //    window means restores never thrash)
    var best = -1, bestAbs = 1e9;
    for (var k = 0; k < secs.length; k++) {
      if (!secs[k].getAttribute('data-wor-unloaded')) continue;
      var rel2 = k - activeIdx;
      if (rel2 >= -WOR_KEEP_ABOVE && rel2 <= WOR_KEEP_BELOW) {
        var d = Math.abs(rel2);
        if (d < bestAbs) { bestAbs = d; best = k; }
      }
    }
    if (best !== -1) {
      var delta = restoreSection(secs[best]);
      changed = true;
      // section above the viewport grew/shrank → keep the reading view pinned
      // (ONLY when no finger/momentum is in flight — see touchIdleForAnchoring)
      var nowMs = Date.now();
      if (tops[best].top <= y && Math.abs(delta) > 2 && touchIdleForAnchoring() && nowMs - lastAnchorAt > 500) {
        lastAnchorAt = nowMs;
        window.scrollTo(0, y + delta);
      }
    }
    if (changed) invalidateSectionTops();
  }

  function updateDockProgress(num) {
    // Mirror the live chapter into the dock progress while the user scrolls
    // through appended chapters (continuous mode) — the dock used to stay on
    // the chapter the reader was OPENED with.
    if (!num || num === lastDockNum) return;
    lastDockNum = num;
    var total = (CHAPTERS && CHAPTERS.length) ? CHAPTERS.length : ((CH && CH.total) || 0);
    var pos = num;
    if (CHAPTERS && CHAPTERS.length) {
      for (var i = 0; i < CHAPTERS.length; i++) {
        if (parseInt(CHAPTERS[i].number, 10) === num) { pos = i + 1; break; }
      }
    }
    var percent = total > 0 ? Math.min(100, Math.round((pos / total) * 100)) : 0;
    var strong = $('.wor-reader-dock__progress-copy strong');
    var pct = $('.wor-reader-dock__progress-copy span');
    if (strong) strong.textContent = pos + '/' + (total || '—');
    if (pct) pct.textContent = percent + '%';
    var prog = $('.wor-reader-dock__progress');
    if (prog) prog.style.setProperty('--wor-reader-progress-value', percent + '%');
  }
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function (ts) {
      scrollRaf = 0;
      // v3 metrics: frame pacing while scrolling (real numbers, no invention)
      if (scrollMetrics && !scrollMetrics.sent) {
        if (scrollMetrics.lastTs) {
          var fd = ts - scrollMetrics.lastTs;
          scrollMetrics.frames += 1;
          scrollMetrics.total += fd;
          if (fd > scrollMetrics.maxFrame) scrollMetrics.maxFrame = fd;
          if (fd > 34) scrollMetrics.longFrames += 1;
        }
        scrollMetrics.lastTs = ts;
      }
      // READ phase first (one layout), then WRITE phase — interleaving reads
      // and writes here forces the engine to re-layout the document on every
      // frame, which was another scroll-stutter source.
      var y = window.scrollY || window.pageYOffset || 0;
      var doc = document.documentElement;
      // v3 scroll fix: scrollHeight is layout-dirtying to read every frame;
      // refresh it at most every 250 ms (progress granularity is 220 ms anyway).
      var now = Date.now();
      lastScrollAt = now; // momentum marker: gates windowing/re-anchoring
      idleScrollWork();   // runs 420 ms after scrolling fully settles
      if (!docMaxCache || now - docMaxAt > 250) {
        docMaxCache = doc.scrollHeight - window.innerHeight;
        docMaxAt = now;
      }
      var max = docMaxCache;
      var act = null;
      var needProgress = now - lastSent > 220;
      if (needProgress) act = activeSectionAt(y);
      var ratio = max > 0 ? clamp(y / max, 0, 1) : 0;
      var nearEnd = S.continuousMode && !window.__worEnd && !window.__worNeedLock
        && (y >= max - 1400);
      // DOM windowing: unload far chapters / restore entering ones.
      // v3: NEVER mid-gesture — innerHTML restores + re-anchor scrollTo during
      // an active pan cancel the iOS momentum. Deferred to idle instead.
      if (S.continuousMode && touchIdleForAnchoring()) enforceWindow(y);

      // WRITE phase — compositor-only: transform instead of width keeps the
      // progress bar off the main-thread layout path entirely.
      var fill = $('[data-wor-reader-chapter-progress-fill]');
      if (fill) {
        if (!fill.__worFillInit) {
          fill.style.width = '100%';
          fill.style.transformOrigin = '0 50%';
          fill.__worFillInit = 1;
        }
        var tf = 'scaleX(' + ratio.toFixed(4) + ')';
        if (fill.style.transform !== tf) fill.style.transform = tf;
      }
      if (needProgress && act) {
        lastSent = now;
        var inOffset = Math.max(0, Math.round(y - act.top));
        send({ t: 'scroll', offset: Math.round(y), inOffset: inOffset, chapter: act.num, ratio: ratio });
        updateDockProgress(act.num);
      }
      if (nearEnd) {
        window.__worNeedLock = true;
        send({ t: 'needNext' });
      }
    });
  }

  // ---- v3 scroll responsiveness -------------------------------------------
  // touchActive/lastTouchEndAt/lastScrollAt gate windowing + re-anchoring.
  // idleScrollWork runs once scrolling + momentum have fully settled: it
  // finishes deferred windowing and reports the collected frame metrics.
  var touchActive = false;
  var lastTouchEndAt = 0;
  var lastScrollAt = 0;
  var docMaxCache = 0;
  var docMaxAt = 0;
  var scrollMetrics = null;
  function beginScrollGesture() {
    touchActive = true;
    if (!scrollMetrics || scrollMetrics.sent) {
      scrollMetrics = { frames: 0, longFrames: 0, maxFrame: 0, total: 0, start: Date.now(), lastTs: 0, sent: false };
    }
  }
  function endScrollGesture() {
    touchActive = false;
    lastTouchEndAt = Date.now();
    idleScrollWork();
  }
  var idleScrollWork = debounce(function () {
    lastScrollAt = 0;
    if (S.continuousMode && touchIdleForAnchoring()) onScroll(); // finish deferred windowing
    var m = scrollMetrics;
    if (m && !m.sent && m.frames > 5) {
      m.sent = true;
      send({
        t: 'scrollMetrics',
        frames: m.frames,
        longFrames: m.longFrames,
        maxFrame: Math.round(m.maxFrame),
        avgFrame: Math.round(m.total / Math.max(1, m.frames)),
        durationMs: Date.now() - m.start
      });
    }
  }, 420);

  // ============================ chapters sheet ============================
  function requestServerSearch(q) {
    q = (q || '').trim();
    if (!q || CHAPTERS_TOTAL <= 0 || CHAPTERS.length >= CHAPTERS_TOTAL) return;
    if (q === lastServerSearchQ) return;
    lastServerSearchQ = q;
    send({ t: 'chaptersSearch', q: q });
  }
  var debouncedServerSearch = debounce(requestServerSearch, 350);

  function renderChapters() {
    var listEl = $('#worChaptersList');
    if (!listEl) return;
    var q = (chaptersSearch || '').trim().toLowerCase();
    var searchingServer = false;
    var list;
    if (q && serverSearchResults && serverSearchResults.q && serverSearchResults.q.toLowerCase() === q) {
      // نتائج البحث الشامل من الخادم (كل الفصول)
      list = (serverSearchResults.results || []).slice();
      list.sort(function (a, b) { return chaptersSortDesc ? b.number - a.number : a.number - b.number; });
    } else {
      list = CHAPTERS.filter(function (c) {
        if (!q) return true;
        return String(c.number).indexOf(q) !== -1 || String(c.title || '').toLowerCase().indexOf(q) !== -1;
      });
      list.sort(function (a, b) { return chaptersSortDesc ? b.number - a.number : a.number - b.number; });
      // لا نتائج محلية والقائمة جزئية → اطلب البحث الشامل من الخادم
      if (q && !list.length && CHAPTERS_TOTAL > 0 && CHAPTERS.length < CHAPTERS_TOTAL) {
        searchingServer = true;
        debouncedServerSearch(q);
      }
    }
    var total = list.length;
    if (!(q && serverSearchResults && serverSearchResults.q && serverSearchResults.q.toLowerCase() === q)) {
      list = list.slice(0, chaptersPageCount * CHAPTERS_PAGE);
    }
    var html = list.map(function (c) {
      var isCurrent = CH && parseInt(CH.number, 10) === parseInt(c.number, 10);
      return '<button class="wor-reader-chapters-item' + (isCurrent ? ' is-current' : '') + '" type="button" data-wor-goto="' + esc(c.number) + '">'
        + '<span class="wor-reader-chapters-item__num">' + esc(c.number) + '</span>'
        + '<span class="wor-reader-chapters-item__body">'
        + '<span class="wor-reader-chapters-item__text">' + esc(c.title || ('فصل ' + c.number)) + '</span>'
        + (isCurrent ? '<small>تقرأ الآن</small>' : '')
        + '</span>'
        + '</button>';
    }).join('');
    if (searchingServer) html = '<div class="wor-reader-chapters-sheet__state">جاري البحث في جميع الفصول…</div>';
    else if (!list.length) html = '<div class="wor-reader-chapters-sheet__state">لا توجد نتائج مطابقة</div>';
    listEl.innerHTML = html;
    var foot = $('.wor-reader-chapters-sheet__footer');
    var moreLocal = total > list.length;
    var moreServer = CHAPTERS_TOTAL > 0 && CHAPTERS.length < CHAPTERS_TOTAL && !q;
    if (foot) {
      foot.style.display = (moreLocal || moreServer) ? '' : 'none';
      var moreBtn = $('#worChaptersMore');
      if (moreBtn) moreBtn.textContent = moreServer && !moreLocal
        ? ('تحميل المزيد من الخادم (' + CHAPTERS.length + ' / ' + CHAPTERS_TOTAL + ')')
        : 'المزيد';
    }
    var cur = $('.wor-reader-chapters-item.is-current', listEl);
    if (cur && !chaptersSearch) setTimeout(function () { try { cur.scrollIntoView({ block: 'center' }); } catch (e) {} }, 60);
  }
  function openChaptersSheet() {
    var sh = $('#wor-reader-chapters-sheet');
    if (!sh) return;
    chaptersPageCount = 1;
    sh.hidden = false;
    sh.setAttribute('aria-hidden', 'false');
    renderChapters();
  }
  function closeChaptersSheet() {
    var sh = $('#wor-reader-chapters-sheet');
    if (!sh) return;
    sh.hidden = true;
    sh.setAttribute('aria-hidden', 'true');
  }

  // ==================== words sheet (Galaxy "تغيير الكلمات") ====================
  var WORDS = {
    scope: 'novel',                     // 'novel' = هذه الرواية | 'global' = كل الروايات
    items: { novel: [], global: [] },   // filled from React
    editing: null                       // { id } while editing a saved term
  };
  var WORDS_DEFAULT_COLOR = '#0ea5e9';
  var WORDS_PALETTE = ['#0ea5e9', '#38bdf8', '#06b6d4', '#14b8a6', '#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#f43f5e', '#fb7185', '#ffffff', '#cbd5e1', '#94a3b8', '#64748b', '#334155', '#0f172a'];

  // ---- color picker state (HSV) ----
  var wcHue = 198, wcSat = 1, wcVal = .93;

  function wcHsvToHex(h, s, v) {
    function f(n) {
      var k = (n + h / 60) % 6;
      var c = v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
      return ('0' + Math.round(255 * c).toString(16)).slice(-2);
    }
    return '#' + f(5) + f(3) + f(1);
  }
  function wcHexToHsv(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h: h, s: mx ? d / mx : 0, v: mx };
  }

  function wcApplyColor(hex, src) {
    hex = String(hex || WORDS_DEFAULT_COLOR).toUpperCase();
    var hidden = $('[data-wor-words-color]');
    var swatch = $('[data-wor-words-color-preview]');
    var large = $('[data-wor-words-color-preview-large]');
    var hexLabel = $('[data-wor-words-color-hex]');
    var hexInput = $('[data-wor-words-color-hex-input]');
    if (hidden) hidden.value = hex;
    if (swatch) swatch.style.background = hex;
    if (large) large.style.background = hex;
    if (hexLabel) hexLabel.textContent = hex;
    if (hexInput && src !== 'input') hexInput.value = hex;
    var canvas = $('[data-wor-words-color-canvas]');
    if (canvas) {
      canvas.style.backgroundColor = 'hsl(' + wcHue + ', 100%, 50%)';
      canvas.style.backgroundImage = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' + wcHue + ', 100%, 50%))';
    }
    if (src !== 'canvas') {
      var handle = $('[data-wor-words-color-handle]');
      if (handle) { handle.style.left = (wcSat * 100) + '%'; handle.style.top = ((1 - wcVal) * 100) + '%'; }
    }
    if (src !== 'hue') {
      var hue = $('[data-wor-words-color-hue]');
      if (hue) hue.value = String(Math.round(wcHue));
    }
    $all('[data-wor-words-color-dot]').forEach(function (d) {
      d.classList.toggle('is-active', d.getAttribute('data-wor-words-color-dot').toUpperCase() === hex);
    });
  }

  function wcSetColorHex(hex, src) {
    var clean = String(hex || '').trim();
    if (/^#[0-9a-f]{3}$/i.test(clean)) clean = '#' + clean[1] + clean[1] + clean[2] + clean[2] + clean[3] + clean[3];
    var hsv = wcHexToHsv(clean);
    if (!hsv) return false;
    wcHue = Math.round(hsv.h); wcSat = hsv.s; wcVal = hsv.v;
    wcApplyColor(clean.toUpperCase(), src);
    return true;
  }

  function wcBindPicker() {
    var canvas = $('[data-wor-words-color-canvas]');
    if (canvas) {
      var dragging = false;
      var pick = function (e) {
        var r = canvas.getBoundingClientRect();
        var x = Math.min(Math.max((e.clientX - r.left) / Math.max(r.width, 1), 0), 1);
        var y = Math.min(Math.max((e.clientY - r.top) / Math.max(r.height, 1), 0), 1);
        wcSat = x; wcVal = 1 - y;
        wcApplyColor(wcHsvToHex(wcHue, wcSat, wcVal), 'canvas');
      };
      canvas.addEventListener('pointerdown', function (e) { dragging = true; try { canvas.setPointerCapture(e.pointerId); } catch (err) { } pick(e); });
      canvas.addEventListener('pointermove', function (e) { if (dragging) pick(e); });
      ['pointerup', 'pointercancel'].forEach(function (ev) { canvas.addEventListener(ev, function () { dragging = false; }); });
    }
    var hue = $('[data-wor-words-color-hue]');
    hue && hue.addEventListener('input', function () {
      wcHue = parseInt(hue.value, 10) || 0;
      wcApplyColor(wcHsvToHex(wcHue, wcSat, wcVal), 'hue');
    });
    var hexInput = $('[data-wor-words-color-hex-input]');
    hexInput && hexInput.addEventListener('input', function () {
      var v = hexInput.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v) || /^#[0-9a-f]{3}$/i.test(v)) wcSetColorHex(v, 'input');
    });
    var reset = $('[data-wor-words-color-reset]');
    reset && reset.addEventListener('click', function () { wcSetColorHex(WORDS_DEFAULT_COLOR); });
  }

  function wcRenderPalette() {
    var grid = $('[data-wor-words-color-grid]');
    if (!grid) return;
    grid.innerHTML = WORDS_PALETTE.map(function (c) {
      return '<button type="button" class="wor-reader-words-color-dot" data-wor-words-color-dot="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
    }).join('');
  }

  function wordsCurrent() { return WORDS.scope === 'global' ? WORDS.items.global : WORDS.items.novel; }

  function wordsEndEdit() {
    WORDS.editing = null;
    var from = $('[data-wor-words-from]'), to = $('[data-wor-words-to]');
    var submit = $('[data-wor-words-submit]'), cancel = $('[data-wor-words-cancel]');
    if (from) from.value = '';
    if (to) to.value = '';
    if (submit) submit.textContent = 'إضافة';
    if (cancel) cancel.hidden = true;
    $all('input[name="worWordsMode"]').forEach(function (r) { r.checked = r.getAttribute('data-wor-words-mode') === 'smart'; });
    var colorOn = $('[data-wor-words-color-on]');
    if (colorOn) colorOn.checked = false;
    var ctl = $('[data-wor-words-color-control]');
    if (ctl) ctl.setAttribute('aria-hidden', 'true');
    wcSetColorHex(WORDS_DEFAULT_COLOR);
    $all('.wor-reader-words-check').forEach(function (lbl) {
      var input = lbl.querySelector('input');
      if (input) lbl.classList.toggle('is-on', !!input.checked);
    });
    renderWords();
  }

  function wordsBeginEdit(item) {
    if (!item) return;
    WORDS.editing = { id: item.id };
    var from = $('[data-wor-words-from]'), to = $('[data-wor-words-to]');
    var submit = $('[data-wor-words-submit]'), cancel = $('[data-wor-words-cancel]');
    if (from) from.value = item.original || '';
    if (to) to.value = item.replacement || '';
    if (submit) submit.textContent = 'تحديث';
    if (cancel) cancel.hidden = false;
    $all('input[name="worWordsMode"]').forEach(function (r) { r.checked = (r.getAttribute('data-wor-words-mode') === 'exact') === !!item.exact; });
    var colorOn = $('[data-wor-words-color-on]');
    if (colorOn) colorOn.checked = !!item.color;
    var ctl = $('[data-wor-words-color-control]');
    if (ctl) ctl.setAttribute('aria-hidden', item.color ? 'false' : 'true');
    if (item.color) wcSetColorHex(item.color);
    $all('.wor-reader-words-check').forEach(function (lbl) {
      var input = lbl.querySelector('input');
      if (input) lbl.classList.toggle('is-on', !!input.checked);
    });
    renderWords();
    var form = $('[data-wor-words-form]');
    form && form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderWords() {
    $all('[data-wor-words-scope]').forEach(function (b) {
      var on = b.getAttribute('data-wor-words-scope') === WORDS.scope;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var listEl = $('[data-wor-words-list]');
    var countEl = $('[data-wor-words-count]');
    var clearBtn = $('[data-wor-words-clear]');
    var items = wordsCurrent().slice().sort(function (a, b) {
      return String(a.original || '').localeCompare(String(b.original || ''), 'ar');
    });
    if (countEl) countEl.textContent = String(items.length);
    if (clearBtn) clearBtn.hidden = items.length === 0;
    var html = items.map(function (r) {
      var editing = WORDS.editing != null && WORDS.editing.id === r.id;
      var meta = [];
      meta.push(r.replacement ? ('← ' + r.replacement) : '← حذف الكلمة');
      if (r.exact) meta.push('كلمة مستقلة');
      if (r.color) meta.push(String(r.color).toUpperCase());
      return '<div class="wor-reader-words-item' + (editing ? ' is-editing' : '') + '">'
        + '<div class="wor-reader-words-item__body">'
        + '<strong>' + esc(r.original) + '</strong>'
        + '<span>' + esc(meta.join(' · ')) + '</span>'
        + (r.color ? '<i class="wor-reader-words-item__color" style="background:' + esc(r.color) + '"></i>' : '')
        + '</div>'
        + '<div class="wor-reader-words-item__actions">'
        + '<button type="button" data-wor-words-edit="' + esc(r.id) + '">' + (editing ? 'إلغاء التعديل' : 'تعديل') + '</button>'
        + '<button type="button" data-wor-words-del="' + esc(r.id) + '">حذف</button>'
        + '</div></div>';
    }).join('');
    if (listEl) listEl.innerHTML = html || '<div class="wor-reader-words-empty">لا توجد كلمات محفوظة في هذا النطاق.</div>';
  }

  function openWordsSheet() { var sh = $('#wor-reader-words-sheet'); if (!sh) return; sh.hidden = false; sh.setAttribute('aria-hidden', 'false'); wcRenderPalette(); wcSetColorHex(WORDS_DEFAULT_COLOR); renderWords(); send({ t: 'wordsOpen' }); }
  function closeWordsSheet() { var sh = $('#wor-reader-words-sheet'); if (!sh) return; sh.hidden = true; sh.setAttribute('aria-hidden', 'true'); wordsEndEdit(); }

  // ============================ search overlay ============================
  function renderSearch() {
    var res = $('#worSearchResults');
    var status = $('[data-wor-search-status]');
    if (!res || !status) return;
    var q = (searchQ || '').trim().toLowerCase();
    if (!q) { res.innerHTML = ''; status.textContent = 'ابحث عن فصل بالرقم أو العنوان…'; return; }
    var serverMatch = serverSearchResults && serverSearchResults.q && serverSearchResults.q === q;
    var list = serverMatch ? (serverSearchResults.results || []).slice(0, 12) : CHAPTERS.filter(function (c) {
      return String(c.number).indexOf(q) !== -1 || String(c.title || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 12);
    // لا نتائج محلية والقائمة جزئية → ابحث في الخادم (كل الفصول)
    if (!serverMatch && !list.length && CHAPTERS_TOTAL > 0 && CHAPTERS.length < CHAPTERS_TOTAL) {
      status.textContent = 'جاري البحث في جميع الفصول…';
      debouncedServerSearch(q);
      res.innerHTML = '';
      return;
    }
    var suffix = serverMatch && (serverSearchResults.total || 0) > 12 ? ' — من الخادم' : '';
    status.textContent = list.length ? ('نتائج (' + list.length + ')' + suffix) : 'لا توجد نتائج';
    res.innerHTML = list.map(function (c) {
      var isCurrent = CH && parseInt(CH.number, 10) === parseInt(c.number, 10);
      return '<button class="wor-reader-chapters-item' + (isCurrent ? ' is-current' : '') + '" type="button" data-wor-goto="' + esc(c.number) + '">'
        + '<span class="wor-reader-chapters-item__num">' + esc(c.number) + '</span>'
        + '<span class="wor-reader-chapters-item__body"><span class="wor-reader-chapters-item__text">' + esc(c.title || ('فصل ' + c.number)) + '</span></span>'
        + '</button>';
    }).join('');
  }
  function openSearch() { var box = $('#wor-search'); if (!box) return; box.hidden = false; box.setAttribute('aria-hidden', 'false'); setTimeout(function () { try { var i = $('#wor-search-input'); i && i.focus(); } catch (e) {} }, 120); }
  function closeSearch() { var box = $('#wor-search'); if (!box) return; box.hidden = true; box.setAttribute('aria-hidden', 'true'); }

  // ============================ drawer ============================
  function openDrawer() {
    var d = $('#wor-drawer'), b = $('[data-wor-drawer-backdrop]');
    if (d) { d.removeAttribute('inert'); d.setAttribute('aria-hidden', 'false'); d.classList.add('is-open'); }
    if (b) { b.hidden = false; requestAnimationFrame(function () { b.classList.add('is-visible'); }); }
  }
  function closeDrawer() {
    var d = $('#wor-drawer'), b = $('[data-wor-drawer-backdrop]');
    if (d) { d.setAttribute('aria-hidden', 'true'); d.classList.remove('is-open'); d.setAttribute('inert', ''); }
    if (b) { b.classList.remove('is-visible'); setTimeout(function () { b.hidden = true; }, 220); }
  }

  // ============================ color pickers ============================ (PORT EDIT: report modal JS removed)
  function makePicker(id, onApply, initialHex) {
    var root = document.getElementById(id);
    if (!root) return null;
    var canvas = $('canvas', root);
    var handle = $('.wor-picker-handle', root) || $('.wor-reader-background-picker__handle', root);
    var hue = $('input[type=range]', root);
    var hexIn = $('input[type=text]', root);
    var st = { h: 0, s: 0, v: 0 };
    function hsvFromHex(hex) {
      var c = hexToRgb(hex); var r = c.r / 255, g = c.g / 255, b = c.b / 255;
      var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0, s = 0, v = max;
      if (d) {
        s = d / max;
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return { h: h, s: s, v: v };
    }
    function hex() {
      var h = st.h, s = st.s, v = st.v;
      var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m2 = v - c, rgb2;
      if (h < 60) rgb2 = [c, x, 0]; else if (h < 120) rgb2 = [x, c, 0]; else if (h < 180) rgb2 = [0, c, x];
      else if (h < 240) rgb2 = [0, x, c]; else if (h < 300) rgb2 = [x, 0, c]; else rgb2 = [c, 0, x];
      function hh(v2) { var s2 = Math.round(v2 * 255).toString(16); return s2.length < 2 ? '0' + s2 : s2; }
      return '#' + hh(rgb2[0] + m2) + hh(rgb2[1] + m2) + hh(rgb2[2] + m2);
    }
    function draw() {
      if (!canvas) return;
      var w = canvas.width = canvas.offsetWidth || 220;
      var ht = canvas.height = canvas.offsetHeight || 140;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = 'hsl(' + st.h + ',100%,50%)'; ctx.fillRect(0, 0, w, ht);
      var g1 = ctx.createLinearGradient(0, 0, w, 0);
      g1.addColorStop(0, '#ffffff'); g1.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g1; ctx.fillRect(0, 0, w, ht);
      var g2 = ctx.createLinearGradient(0, 0, 0, ht);
      g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000000');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, w, ht);
      if (handle) {
        handle.style.left = (st.s * 100) + '%';
        handle.style.top = ((1 - st.v) * 100) + '%';
      }
    }
    function emit() {
      var hx = hex();
      var meta = $('[data-wor-picker-hex]', root);
      if (meta) meta.textContent = hx.toUpperCase();
      var sw = $('[data-wor-picker-swatch]', root);
      if (sw) sw.style.background = hx;
      if (hexIn && document.activeElement !== hexIn) hexIn.value = hx.toUpperCase();
      onApply(hx);
    }
    function fromEvent(e) {
      if (!canvas) return;
      var r = canvas.getBoundingClientRect();
      var cx = e.touches ? e.touches[0].clientX : e.clientX;
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      var x = clamp(cx - r.left, 0, r.width);
      var y = clamp(cy - r.top, 0, r.height);
      st.s = r.width ? x / r.width : 0;
      st.v = r.height ? 1 - y / r.height : 0;
      draw(); emit();
      if (e.preventDefault) e.preventDefault();
    }
    if (canvas) {
      canvas.addEventListener('touchstart', fromEvent, { passive: false });
      canvas.addEventListener('touchmove', fromEvent, { passive: false });
      canvas.addEventListener('mousedown', fromEvent);
      canvas.addEventListener('mousemove', function (e) { if (e.buttons) fromEvent(e); });
    }
    if (hue) hue.addEventListener('input', function () { st.h = parseFloat(hue.value) || 0; draw(); emit(); });
    if (hexIn) hexIn.addEventListener('change', function () {
      var v = String(hexIn.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { st = hsvFromHex(v); if (hue) hue.value = st.h; draw(); emit(); }
    });
    st = hsvFromHex(initialHex || '#000000');
    if (hue) hue.value = st.h;
    setTimeout(draw, 80);
    setTimeout(draw, 400);
    return {
      set: function (hx) {
        if (!/^#[0-9a-fA-F]{6}$/.test(String(hx || ''))) return;
        st = hsvFromHex(hx);
        if (hue && document.activeElement !== hue) hue.value = st.h;
        draw();
        if (hexIn && document.activeElement !== hexIn) hexIn.value = String(hx).toUpperCase();
        var meta = $('[data-wor-picker-hex]', root);
        if (meta) meta.textContent = String(hx).toUpperCase();
        var sw = $('[data-wor-picker-swatch]', root);
        if (sw) sw.style.background = hx;
      }
    };
  }

  // ============================ favorite ============================
  function updateFavUI() {
    var btn = $('[data-wor-favorite-toggle]');
    if (!btn) return;
    btn.setAttribute('aria-pressed', favOn ? 'true' : 'false');
    btn.classList.toggle('is-active', favOn);
    var fill = $('.wor-reader-heart-icon__fill', btn);
    if (fill) fill.setAttribute('opacity', favOn ? '1' : '0');
    var lab = $('[data-wor-favorite-label]', btn);
    if (lab) lab.textContent = favOn ? 'في المفضلة' : 'المفضلة';
  }

  // ============================ wiring ============================
  var sendDebouncedBg = debounce(function (hx) { send({ t: 'settings', patch: { bgColor: hx, customColors: true } }); }, 320);
  var sendDebouncedText = debounce(function (hx) { send({ t: 'settings', patch: { textColor: hx, customColors: true } }); }, 320);
  var sendDebouncedProgress = debounce(function (hx) { send({ t: 'settings', patch: { progressBarColor: hx } }); }, 320);

  function wire() {
    dockEl = $('[data-wor-reader-dock]');
    // topbar
    var drawerBtn = $('[data-wor-drawer-toggle]');
    drawerBtn && drawerBtn.addEventListener('click', openDrawer);
    var searchBtn = $('[data-wor-search-toggle]');
    searchBtn && searchBtn.addEventListener('click', openSearch);
    var themeBtn = $('[data-wor-theme-toggle]');
    themeBtn && themeBtn.addEventListener('click', function () { send({ t: 'themeCycle' }); });
    // PORT EDIT: [data-wor-comments-btn] wiring removed with the trigger markup.
    // drawer
    var backdrop = $('[data-wor-drawer-backdrop]');
    backdrop && backdrop.addEventListener('click', closeDrawer);
    var drawerClose = $('[data-wor-drawer-close]');
    drawerClose && drawerClose.addEventListener('click', closeDrawer);
    $all('[data-wor-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeDrawer();
        send({ t: 'nav', to: a.getAttribute('data-wor-nav') });
      });
    });
    // search
    var searchClose = $('[data-wor-search-close]');
    searchClose && searchClose.addEventListener('click', closeSearch);
    var searchInput = $('#wor-search-input');
    searchInput && searchInput.addEventListener('input', function () { searchQ = searchInput.value; renderSearch(); });
    document.addEventListener('click', function (e) {
      var g = e.target.closest && e.target.closest('[data-wor-goto]');
      if (g) {
        closeSearch();
        send({ t: 'goto', number: parseInt(g.getAttribute('data-wor-goto'), 10) });
      }
    });
    // dock tabs
    $all('.wor-reader-dock__tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var panel = tab.getAttribute('data-wor-tab');
        $all('.wor-reader-dock__tab').forEach(function (x) { x.classList.toggle('is-active', x === tab); });
        $all('.wor-reader-dock__panel').forEach(function (p) {
          var on = p.getAttribute('data-wor-reader-panel') === panel;
          p.style.display = on ? '' : 'none';
          if (on) { p.classList.remove('is-entering'); void p.offsetWidth; p.classList.add('is-entering'); }
        });
        dockEl && dockEl.setAttribute('data-wor-reader-active-panel', panel);
        setTimeout(function () { if (dockOpen) setDock(true); }, 30);
      });
    });
    // dock actions
    var chOpen = $('[data-wor-reader-chapters-open]');
    chOpen && chOpen.addEventListener('click', openChaptersSheet);
    var wordsOpen = $('[data-wor-reader-words-open]');
    wordsOpen && wordsOpen.addEventListener('click', openWordsSheet);
    var favBtn = $('[data-wor-favorite-toggle]');
    favBtn && favBtn.addEventListener('click', function () { send({ t: 'fav' }); });
    var novelBtn = $('[data-wor-reader-dock-novel]');
    novelBtn && novelBtn.addEventListener('click', function (e) { e.preventDefault(); send({ t: 'novelPage' }); });
    var navNext = $('[data-wor-reader-nav-next]');
    navNext && navNext.addEventListener('click', function (e) { e.preventDefault(); send({ t: 'nav', dir: 'next' }); });
    var navPrev = $('[data-wor-reader-nav-prev]');
    navPrev && navPrev.addEventListener('click', function (e) { e.preventDefault(); send({ t: 'nav', dir: 'prev' }); });
    // PORT EDIT: report-open wiring removed with the report panel.
    // dock toggle
    var tog = $('.wor-reader-dock__toggle--floating');
    tog && tog.addEventListener('click', function () { setDock(!dockOpen); });
    // tap on content toggles dock
    var main = $('.wor-reader-main');
    main && main.addEventListener('click', function (e) {
      if (window.getSelection && String(window.getSelection()).length > 1) return;
      if (e.target.closest && e.target.closest('a, button, input, textarea, .wor-author-card, .wor-comments-trigger, [data-wor-goto]')) return;
      if (S.tapToToggle === false) return;
      // Ignore taps that were actually (small) scroll gestures: scrolling moved
      // the page between touchstart and the synthetic click. Toggling the dock
      // mid-gesture changes the page height and instantly kills the scroll.
      if (!userTouched || Date.now() - lastTouchAt > 700) return;
      if (Math.abs((window.scrollY || 0) - touchStartScrollY) > 8) return;
      setDock(!dockOpen);
    });
    // chapters sheet
    var chClose = $('[data-wor-chapters-close]');
    chClose && chClose.addEventListener('click', closeChaptersSheet);
    var chSearch = $('#worChaptersSearch');
    chSearch && chSearch.addEventListener('input', function () { chaptersSearch = chSearch.value; chaptersPageCount = 1; renderChapters(); });
    var chSort = $('[data-wor-chapters-sort]');
    chSort && chSort.addEventListener('click', function () { chaptersSortDesc = !chaptersSortDesc; renderChapters(); });
    var chMore = $('#worChaptersMore');
    chMore && chMore.addEventListener('click', function () {
      var localExhausted = CHAPTERS.length === 0 || renderChaptersLocalExhausted();
      if (!localExhausted) { chaptersPageCount += 1; renderChapters(); return; }
      // انتهت المحمّلة محلياً وتبقى فصول في الخادم → اسحب صفحة جديدة من الأب
      if (CHAPTERS_TOTAL > 0 && CHAPTERS.length < CHAPTERS_TOTAL) {
        chMore.textContent = 'جاري التحميل…';
        send({ t: 'chaptersLoadMore' });
      }
    });
    function renderChaptersLocalExhausted() {
      var q = (chaptersSearch || '').trim().toLowerCase();
      var filtered = CHAPTERS.filter(function (c) {
        if (!q) return true;
        return String(c.number).indexOf(q) !== -1 || String(c.title || '').toLowerCase().indexOf(q) !== -1;
      });
      return filtered.length <= chaptersPageCount * CHAPTERS_PAGE;
    }
    // words sheet (Galaxy)
    var wordsClose = $('[data-wor-words-close]');
    wordsClose && wordsClose.addEventListener('click', closeWordsSheet);
    $all('[data-wor-words-scope]').forEach(function (b) {
      b.addEventListener('click', function () {
        var scope = b.getAttribute('data-wor-words-scope') || 'novel';
        if (scope === WORDS.scope) return;
        WORDS.scope = scope;
        wordsEndEdit();
      });
    });
    $all('.wor-reader-words-check').forEach(function (lbl) {
      var input = lbl.querySelector('input');
      if (!input) return;
      var sync = function () { lbl.classList.toggle('is-on', !!input.checked); };
      input.addEventListener('change', sync);
      sync();
    });
    var colorOnEl = $('[data-wor-words-color-on]');
    colorOnEl && colorOnEl.addEventListener('change', function () {
      var ctl = $('[data-wor-words-color-control]');
      if (ctl) ctl.setAttribute('aria-hidden', colorOnEl.checked ? 'false' : 'true');
    });
    wcBindPicker();
    var wordsForm = $('[data-wor-words-form]');
    wordsForm && wordsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var from = $('[data-wor-words-from]'), to = $('[data-wor-words-to]');
      var original = ((from || {}).value || '').trim();
      if (!original) { toast('اكتب الكلمة الأصلية أولاً'); return; }
      var modeEl = $('input[name="worWordsMode"]:checked');
      var exact = !!modeEl && modeEl.getAttribute('data-wor-words-mode') === 'exact';
      var colorOn = !!$('[data-wor-words-color-on]') && $('[data-wor-words-color-on]').checked;
      var color = colorOn ? ((($('[data-wor-words-color]') || {}).value || WORDS_DEFAULT_COLOR)) : null;
      send({
        t: 'words',
        action: WORDS.editing != null ? 'updateRep' : 'addRep',
        scope: WORDS.scope,
        id: WORDS.editing != null ? WORDS.editing.id : null,
        original: original,
        replacement: ((to || {}).value || '').trim(),
        exact: exact,
        color: color
      });
    });
    var wordsCancelBtn = $('[data-wor-words-cancel]');
    wordsCancelBtn && wordsCancelBtn.addEventListener('click', function () { wordsEndEdit(); });
    var clearArmed = 0;
    document.addEventListener('click', function (e) {
      var el;
      if ((el = e.target.closest('[data-wor-words-edit]'))) {
        var id = el.getAttribute('data-wor-words-edit');
        if (WORDS.editing && WORDS.editing.id === id) { wordsEndEdit(); return; }
        var item = null;
        var cur = wordsCurrent();
        for (var i = 0; i < cur.length; i++) if (cur[i].id === id) item = cur[i];
        item ? wordsBeginEdit(item) : wordsEndEdit();
      } else if ((el = e.target.closest('[data-wor-words-del]'))) {
        send({ t: 'words', action: 'deleteRep', scope: WORDS.scope, id: el.getAttribute('data-wor-words-del') });
      } else if ((el = e.target.closest('[data-wor-words-color-dot]'))) {
        wcSetColorHex(el.getAttribute('data-wor-words-color-dot'));
      } else if ((el = e.target.closest('[data-wor-words-clear]'))) {
        var now = Date.now();
        if (now - clearArmed > 3000) {
          clearArmed = now;
          el.textContent = 'اضغط مجدداً للمسح';
          setTimeout(function () { el.textContent = 'مسح الكل'; }, 3000);
        } else {
          clearArmed = 0;
          el.textContent = 'مسح الكل';
          send({ t: 'words', action: 'clearScope', scope: WORDS.scope });
        }
      }
    });
    // PORT EDIT: report-modal event handlers removed with the modal.
    // text panel ranges (± buttons + drag) — also the coloring panel size ranges
    [['worRangeFontSize', 'fontSize', 0, 'px'], ['worRangeLineHeight', 'lineHeight', 2, ''], ['worRangeWordSpacing', 'wordSpacing', 0, 'px'], ['worRangeBrightness', 'brightness', 2, ''],
     ['worRangeDialogueSize', 'dialogueSize', 0, '%'], ['worRangeMarkdownSize', 'markdownSize', 0, '%'], ['worRangeBracketSize', 'bracketSize', 0, '%'], ['worRangeCustomSize', 'customSize', 0, '%']].forEach(function (cfg) {
      var el = document.getElementById(cfg[0]);
      if (!el) return;
      var push = debounce(function (v) { var p = {}; p[cfg[1]] = v; send({ t: 'settings', patch: p }); }, 260);
      function applyVal(v) {
        v = cfg[2] ? Math.round(v * 100) / 100 : Math.round(v);
        S[cfg[1]] = v;
        el.value = v;
        var out = el.parentElement.querySelector('output');
        if (out) out.textContent = v + (cfg[3] || '');
        applyTypography();
        push(v);
      }
      el.addEventListener('input', function () { applyVal(cfg[2] ? parseFloat(el.value) : parseInt(el.value, 10)); });
      $all('[data-wor-range-step]', el.parentElement.parentElement).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var parts = btn.getAttribute('data-wor-range-step').split(':');
          if (parts[0] !== cfg[0]) return;
          var delta = parseFloat(parts[1]) || 1;
          var min = parseFloat(el.min), max = parseFloat(el.max), step = parseFloat(el.step) || 1;
          var v = clamp((parseFloat(el.value) || 0) + delta, min, max);
          v = Math.round(v / step) * step;
          applyVal(v);
        });
      });
    });
    // text panel choices
    $all('#wor-reader-panel-text [data-wor-weight] button').forEach(function (b) {
      b.addEventListener('click', function () {
        S.fontWeight = b.getAttribute('data-value');
        setActiveChoice('#wor-reader-panel-text [data-wor-weight]', S.fontWeight);
        applyTypography();
        send({ t: 'settings', patch: { fontWeight: S.fontWeight } });
      });
    });
    $all('#wor-reader-panel-text [data-wor-direction] button').forEach(function (b) {
      b.addEventListener('click', function () {
        S.direction = b.getAttribute('data-value');
        setActiveChoice('#wor-reader-panel-text [data-wor-direction]', S.direction);
        applyTypography();
        send({ t: 'settings', patch: { direction: S.direction } });
      });
    });
    // font panel
    var fontSearch = $('#worFontSearch');
    fontSearch && fontSearch.addEventListener('input', function () {
      var q = fontSearch.value.trim().toLowerCase();
      $all('[data-wor-font-choice]').forEach(function (b) {
        var name = (b.getAttribute('data-name') || '').toLowerCase();
        b.style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
      });
    });
    $all('[data-wor-font-choice]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.fontValue = b.getAttribute('data-value');
        setActiveChoice('[data-wor-font-choice]', S.fontValue);
        applyTypography();
        send({ t: 'settings', patch: { fontValue: S.fontValue } });
      });
    });
    // background presets + custom
    $all('[data-wor-bg-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-value');
        S.bgPreset = v; customColors = false;
        for (var i = 0; i < BG_PRESETS.length; i++) {
          if (BG_PRESETS[i].value === v) { S.bgColor = BG_PRESETS[i].bg; S.textColor = BG_PRESETS[i].text; }
        }
        applySettingsUI();
        send({ t: 'settings', patch: { bgColor: S.bgColor, textColor: S.textColor, bgPreset: S.bgPreset, customColors: false } });
      });
    });
    var customToggle = $('[data-wor-background-custom-toggle]');
    customToggle && customToggle.addEventListener('click', function () {
      customColors = !customColors;
      applySettingsUI();
      send({ t: 'settings', patch: { bgColor: S.bgColor, textColor: S.textColor, customColors: customColors } });
    });
    pickers.bg = makePicker('wor-picker-bg', function (hx) { S.bgColor = hx; customColors = true; applyTheme(); sendDebouncedBg(hx); }, S.bgColor || '#000000');
    pickers.text = makePicker('wor-picker-text', function (hx) { S.textColor = hx; customColors = true; applyTheme(); sendDebouncedText(hx); }, S.textColor || '#ffffff');
    pickers.progress = makePicker('wor-reader-chapter-progress-color-picker', function (hx) { S.progressBarColor = hx; applyProgressBar(); sendDebouncedProgress(hx); }, S.progressBarColor || '#00ffff');
    var progColorOpen = $('[data-wor-chapter-progress-color-open]');
    progColorOpen && progColorOpen.addEventListener('click', function () {
      var p = $('#wor-reader-chapter-progress-color-picker');
      if (p) p.hidden = !p.hidden;
      setTimeout(function () { pickers.progress && pickers.progress.set(S.progressBarColor || '#00ffff'); }, 60);
    });
    // switches
    $all('[data-wor-switch]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var key = sw.getAttribute('data-wor-switch');
        var map = {
          continuous: 'continuousMode', autoscroll: 'autoScroll', keepawake: 'keepAwake', hidetitle: 'hideTitle', taptoggle: 'tapToToggle',
          dialogue: 'enableDialogue', markdown: 'enableMarkdown', bracket: 'enableBracket', custom: 'enableCustom',
          hidequotes: 'hideQuotes', hidemarkdown: 'hideMarkdownMarks', hidebrackets: 'hideBracketMarks', hidecustom: 'hideCustomMarks'
        };
        var prop = map[key];
        if (!prop) return;
        S[prop] = !S[prop];
        setSwitch('[data-wor-switch="' + key + '"]', S[prop]);
        if (prop === 'autoScroll') updateAutoScroll();
        if (prop === 'hideTitle') document.body.classList.toggle('wor-hide-chapter-title', !!S.hideTitle);
        if (['enableDialogue', 'enableMarkdown', 'enableBracket', 'enableCustom'].indexOf(prop) !== -1) updateFmtCards();
        var p = {}; p[prop] = S[prop];
        send({ t: 'settings', patch: p });
      });
    });
    // coloring panel: delimiter style chips (quote / markdown / bracket)
    var FMT_STYLE_KEYS = { quote: 'selectedQuoteStyle', markdown: 'selectedMarkdownStyle', bracket: 'selectedBracketStyle' };
    $all('[data-wor-fmt-style]').forEach(function (wrap) {
      var group = wrap.getAttribute('data-wor-fmt-style');
      var key = FMT_STYLE_KEYS[group];
      if (!key) return;
      $all('.wor-style-chip', wrap).forEach(function (b) {
        b.addEventListener('click', function () {
          S[key] = b.getAttribute('data-value');
          setActiveChoice('[data-wor-fmt-style="' + group + '"]', S[key]);
          var p = {}; p[key] = S[key];
          send({ t: 'settings', patch: p });
        });
      });
    });
    // coloring panel: color swatches
    document.addEventListener('click', function (e) {
      var d = e.target.closest && e.target.closest('[data-wor-color-dot]');
      if (!d) return;
      var key = d.getAttribute('data-key');
      var val = d.getAttribute('data-value');
      if (!key || !val) return;
      S[key] = val;
      updateColorDots(key, val);
      var p = {}; p[key] = val;
      send({ t: 'settings', patch: p });
    });
    // coloring panel: custom delimiter marks
    var coInput = $('#worCustomOpenMark'), ccInput = $('#worCustomCloseMark');
    var pushCustomMarks = debounce(function () {
      send({ t: 'settings', patch: { customOpenMark: (coInput && coInput.value) || '', customCloseMark: (ccInput && ccInput.value) || '' } });
    }, 600);
    coInput && coInput.addEventListener('input', pushCustomMarks);
    ccInput && ccInput.addEventListener('input', pushCustomMarks);
    var progToggle = $('[data-wor-chapter-progress-toggle]');
    progToggle && progToggle.addEventListener('click', function () {
      S.showProgressBar = S.showProgressBar === false;
      setSwitch('[data-wor-chapter-progress-toggle]', S.showProgressBar !== false);
      applyProgressBar();
      send({ t: 'settings', patch: { showProgressBar: S.showProgressBar !== false } });
    });
    // admin tools
    $all('[data-wor-tool]').forEach(function (b) {
      b.addEventListener('click', function () { send({ t: 'tool', tool: b.getAttribute('data-wor-tool') }); });
    });
    // scroll / touch
    window.addEventListener('scroll', onScroll, { passive: true });
    // Size changes (rotation, font loading, toolbars) move every section top —
    // drop the cache so progress tracking stays accurate.
    window.addEventListener('resize', function () {
      invalidateSectionTops();
      docMaxCache = 0;
    }, { passive: true });
    document.addEventListener('touchstart', function () {
      lastTouchAt = Date.now();
      userTouched = true;
      touchStartScrollY = window.scrollY || 0;
      beginScrollGesture();
    }, { passive: true });
    // v3: track the FULL gesture lifecycle so windowing/re-anchoring never
    // fight the reader's finger, and momentum keeps its native inertia.
    document.addEventListener('touchend', endScrollGesture, { passive: true });
    document.addEventListener('touchcancel', endScrollGesture, { passive: true });
    // author card click
    var authorCard = $('[data-wor-author-card]');
    authorCard && authorCard.addEventListener('click', function () { send({ t: 'profile' }); });
  }

  // ==================== Zeus chapter translation (tr*) ====================
  // In-shell side of the Zeus translation engine. RN owns providers, the
  // SQLite/memory cache and orchestration (ReaderTranslationCoordinator); the
  // shell only registers paragraphs, collects them with viewport-priority
  // tiers, applies/restores text safely and mirrors progress into the small
  // card UI. HARD RULE: the WebView HTML is never rebuilt — every state change
  // flows through __wor.receive / send().
  var TR = {
    enabled: false,        // trConfig.enabled → pill visible
    target: '',            // target language (code or name) from RN
    rtl: true,             // target is RTL → applied <p dir="rtl">
    active: false,         // a translation round is running
    savedLang: null,       // original <html lang>, saved once per page
    serial: 0,             // stable-id serial (never reused)
    origLimit: 4000,       // originals Map cap (oldest evicted)
    caps: null             // v3 engine-aware collect caps {maxCharacters,maxSegments}
  };
  var trById = new Map();      // id → <p> (live elements only, pruned lazily)
  var trElIds = new WeakMap(); // <p> → id (stable across re-collects)
  var trOrig = new Map();      // id → original innerHTML (applied paragraphs)
  var trProgress = { status: 'idle', completed: 0, total: 0, reused: 0, error: null, requests: 0 };
  var trObserver = null;
  var TR_HAS_LETTER = /\\p{L}/u; // paragraph must contain at least one letter
  var TR_RTL_CODES = ['ar', 'fa', 'ur', 'he', 'ps', 'yi'];
  var TR_LANG_NAMES = {
    ar: 'العربية', en: 'الإنجليزية', fr: 'الفرنسية', es: 'الإسبانية',
    de: 'الألمانية', tr: 'التركية', it: 'الإيطالية', pt: 'البرتغالية',
    ru: 'الروسية', fa: 'الفارسية', ur: 'الأردية', he: 'العبرية',
    ps: 'البشتوية', yi: 'اليديشية', zh: 'الصينية', ja: 'اليابانية',
    ko: 'الكورية', id: 'الإندونيسية', hi: 'الهندية', th: 'التايلاندية'
  };

  function trEl(id) { return document.getElementById(id); }
  function trTargetName() {
    var t = String(TR.target || '').trim();
    if (!t) return 'العربية';
    return TR_LANG_NAMES[String(t).toLowerCase().split(/[-_]/)[0]] || t;
  }
  function trIsRtlTarget() {
    var t = String(TR.target || '').trim().toLowerCase().split(/[-_]/)[0];
    if (t && TR_RTL_CODES.indexOf(t) !== -1) return true;
    return !!TR.rtl;
  }

  // ---- registration -------------------------------------------------------
  // Paragraphs are section.wor-chapter-sec[data-ch] > div > p (see sections.ts).
  // Image paragraphs, empty text and letter-less text never get an id.
  function trRegisterP(p, ch) {
    var known = trElIds.get(p);
    if (known) { trById.set(known, p); return known; }
    if (p.classList.contains('wor-image-p')) return null;
    var text = String(p.textContent || '');
    if (!text.trim() || !TR_HAS_LETTER.test(text)) return null;
    var id = 'tr' + ch + ':' + (++TR.serial);
    trElIds.set(p, id);
    trById.set(id, p);
    return id;
  }
  // Exact direct structure: the paragraph wrapper is a direct <div> child of
  // the section (title/sep/copyright blocks are siblings, never nested).
  function trSectionParagraphs(sec) {
    var out = [];
    for (var i = 0; i < sec.children.length; i++) {
      var div = sec.children[i];
      if (div.tagName !== 'DIV') continue;
      for (var j = 0; j < div.children.length; j++) {
        if (div.children[j].tagName === 'P') out.push(div.children[j]);
      }
    }
    return out;
  }
  // Drop registrations whose element left the DOM (stashed by the windowing
  // window or removed). Elements restored from the stash re-register under
  // fresh ids; RN's memory cache answers them from its store without network.
  function trPruneIds() {
    trById.forEach(function (el, id) { if (!el.isConnected) trById.delete(id); });
  }

  // ---- tiers --------------------------------------------------------------
  function trViewport() {
    var vv = window.visualViewport;
    var vh = (vv && vv.height) || window.innerHeight || document.documentElement.clientHeight || 600;
    var vt = window.scrollY || window.pageYOffset || 0;
    if (vv) vt = vv.pageTop != null ? vv.pageTop : vt + (vv.offsetTop || 0);
    return { top: vt, height: vh };
  }
  // Zeus formula: 0 = intersects the viewport, 1 = within 2 viewport heights,
  // 2 = far. Distance is measured past the viewport edges, never negative.
  function trTierOf(rect, vt, vh) {
    if (rect.bottom > vt && rect.top < vt + vh) return { tier: 0, distance: 0 };
    var distance = Math.max(rect.top - (vt + vh), vt - rect.bottom, 0);
    return { tier: distance < vh * 2 ? 1 : 2, distance: distance };
  }

  // ---- collection ---------------------------------------------------------
  // Gather live, never-translated candidates with their tier/distance.
  function trCandidates() {
    var surface = $('#worTextSurface');
    if (!surface) return [];
    var secs = $all('section.wor-chapter-sec[data-ch]', surface);
    var vp = trViewport();
    var activeChapter = TR.caps ? activeSectionAt(window.scrollY || 0).num : 0;
    var out = [];
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      if (sec.getAttribute('data-wor-unloaded')) continue; // stashed shell
      var ch = parseInt(sec.getAttribute('data-ch'), 10) || 0;
      if (activeChapter && ch !== activeChapter) continue;
      var ps = trSectionParagraphs(sec);
      for (var j = 0; j < ps.length; j++) {
        var p = ps[j];
        if (p.getAttribute('data-wor-tr')) continue; // already translated
        var id = trRegisterP(p, ch);
        if (!id) continue;
        var t = trTierOf(p.getBoundingClientRect(), 0, vp.height);
        out.push({
          id: id,
          text: String(p.textContent || ''),
          sec: ch,
          tier: t.tier,
          distance: Math.round(t.distance)
        });
      }
    }
    return out;
  }
  // Build ONE batch. prioritize → only the lowest tier (Zeus: never mix tiers
  // in a visible round), caps 24000 chars / 256 segments; background → mixed
  // tiers by (tier, distance), caps 10000 / 64 — unless RN sent engine-aware
  // caps (v3 AI policy: the whole chapter per background round, so the
  // coordinator's batch policy — not the shell — decides the request split).
  // A batch never spans two sections, so RN's chapter gate (expected) can
  // trust the batch chapter.
  function trCollectBatch(prioritize) {
    trPruneIds();
    var cands = trCandidates();
    var empty = { chapter: 0, segments: [], tier: 2, more: false };
    if (!cands.length) return empty;
    if (!TR.caps) cands.sort(function (a, b) { return a.tier - b.tier || a.distance - b.distance; });
    var pool = prioritize && !TR.caps
      ? cands.filter(function (c) { return c.tier === cands[0].tier; })
      : cands;
    var maxChars = TR.caps ? Infinity : (prioritize ? 24000 : 10000);
    var maxSegs = TR.caps ? Infinity : (prioritize ? 256 : 64);
    var segments = [];
    var chars = 0;
    var firstSec = pool[0].sec;
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      if (c.sec !== firstSec) break;
      if (segments.length >= maxSegs || chars >= maxChars) break;
      segments.push({
        id: c.id,
        text: c.text,
        chapter: c.sec,
        tier: c.tier,
        distance: c.distance
      });
      chars += c.text.length;
    }
    if (!segments.length) return empty;
    return {
      chapter: firstSec,
      segments: segments,
      tier: segments[0].tier,
      more: segments.length < cands.length
    };
  }
  // Single code path shared by trStart / trCollect / debounced re-collections.
  // force=true (explicit RN requests) always answers, even with an empty
  // batch, so the coordinator never waits on a silent shell; internal
  // debounces stay quiet when there is nothing new.
  function collectAndPost(prioritize, force) {
    if (!TR.active) return;
    var res = trCollectBatch(prioritize !== false);
    if (!res.segments.length && !force) return;
    send({ t: 'trCollect', chapter: res.chapter, segments: res.segments, tier: res.tier, more: res.more });
  }

  // ---- apply / restore ----------------------------------------------------
  function trEvictOrig() {
    while (trOrig.size > TR.origLimit) {
      var oldest = trOrig.keys().next();
      if (!oldest || oldest.done) break;
      trOrig.delete(oldest.value);
    }
  }
  // Apply translated items. expected = chapter gate (the Zeus documentID
  // equivalent): items whose section data-ch differs are skipped. Original
  // markup is stashed once per paragraph in trOrig (module-level Map keyed by
  // id); translated text goes in via textContent — NEVER innerHTML.
  var trPendingApply = new Map();
  var trApplyTimer = 0;
  function trApplyItems(items, expected) {
    for (var i = 0; i < items.length; i++) trPendingApply.set(items[i].id, { item: items[i], expected: expected });
    if (trApplyTimer) return;
    trApplyTimer = setTimeout(function flushApply() {
      if (!touchIdleForAnchoring()) { trApplyTimer = setTimeout(flushApply, 120); return; }
      trApplyTimer = 0;
      var groups = new Map();
      trPendingApply.forEach(function (row) {
        var group = groups.get(row.expected) || [];
        group.push(row.item);
        groups.set(row.expected, group);
      });
      trPendingApply.clear();
      groups.forEach(function (group, chapter) { trApplyNow(group, chapter); });
    }, 80);
  }
  function trApplyNow(items, expected) {
    var applied = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var el = trById.get(it.id);
      if (!el || !el.isConnected) continue;
      var sec = el.closest ? el.closest('section.wor-chapter-sec[data-ch]') : null;
      if (!sec || (parseInt(sec.getAttribute('data-ch'), 10) || 0) !== expected) continue;
      if (!el.getAttribute('data-wor-tr')) {
        trOrig.set(it.id, el.innerHTML);
        trEvictOrig();
        el.setAttribute('data-wor-tr', '1');
      }
      el.setAttribute('data-wor-tr-text', it.text == null ? '' : String(it.text));
      el.innerHTML = formatLine(it.text == null ? '' : String(it.text), S);
      if (trIsRtlTarget()) el.setAttribute('dir', 'rtl');
      applied++;
    }
    if (applied) invalidateSectionTops();
    send({ t: 'trApplied', chapter: expected, applied: applied });
  }
  // Full restore: the saved originals are the app's own previously rendered
  // markup, so putting them back via innerHTML is safe. Paragraphs whose
  // element disappeared just drop their saved original.
  function trRestoreAll() {
    clearTimeout(trApplyTimer);
    trApplyTimer = 0;
    trPendingApply.clear();
    trOrig.forEach(function (html, id) {
      var el = trById.get(id);
      if (el && el.isConnected) {
        el.innerHTML = el.hasAttribute('data-wor-source') ? formatLine(el.getAttribute('data-wor-source'), S) : html;
        el.removeAttribute('dir');
        el.removeAttribute('data-wor-tr');
        el.removeAttribute('data-wor-tr-text');
      }
      trOrig.delete(id);
    });
    if (TR.savedLang !== null) {
      document.documentElement.setAttribute('lang', TR.savedLang);
      TR.savedLang = null;
    }
    TR.active = false;
    trProgress = { status: 'idle', completed: 0, total: 0, reused: 0, error: null, requests: 0 };
    trRenderUI();
    send({ t: 'trRestored' });
  }

  // ---- chapter change + detection ----------------------------------------
  // Chapter swap: every old element is gone, so drop all registration state
  // and stop any running round (RN decides whether to offer again).
  function trResetForChapter() {
    clearTimeout(trApplyTimer);
    trApplyTimer = 0;
    trPendingApply.clear();
    trById.clear();
    trElIds = new WeakMap();
    trOrig.clear();
    TR.active = false;
    TR.savedLang = null;
    trProgress = { status: 'idle', completed: 0, total: 0, reused: 0, error: null, requests: 0 };
    trRenderUI();
  }
  // trDetect: ~3500 chars of the first live section + the <html lang> hint.
  function trDetectNow() {
    var sample = '';
    var secs = $all('#worTextSurface section.wor-chapter-sec[data-ch]');
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      if (sec.getAttribute('data-wor-unloaded')) continue;
      var ps = trSectionParagraphs(sec);
      var buf = [];
      for (var j = 0; j < ps.length; j++) {
        buf.push(String(ps[j].textContent || ''));
        if (buf.join('\\n').length >= 3500) break;
      }
      sample = buf.join('\\n').slice(0, 3500);
      if (sample.trim()) break;
    }
    send({
      t: 'trDetect',
      lang: document.documentElement.getAttribute('lang') || '',
      sample: sample
    });
  }
  // Once per chapter render — debounced so re-render bursts send one sample.
  var trDetectDebounced = debounce(trDetectNow, 500);
  function trOnChapterChanged() {
    trResetForChapter();
    setTimeout(function () { trDetectDebounced(); }, 300);
  }

  // ---- auto re-collect (mutation + scroll) --------------------------------
  // The shell stashes far sections (innerHTML='') in continuous mode; when a
  // section re-renders, fresh elements appear → observer fires → new ids →
  // RN's memory cache answers instantly. Intended behavior, not a loop.
  var trDebouncedMutation = debounce(function () { if (TR.active) collectAndPost(true); }, 800);
  var trDebouncedScroll = debounce(function () { if (TR.active) collectAndPost(true); }, 120);
  function trEnsureObservers() {
    if (trObserver) return;
    var surface = $('#worTextSurface');
    if (surface && window.MutationObserver) {
      trObserver = new MutationObserver(trDebouncedMutation);
      trObserver.observe(surface, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener('scroll', trDebouncedScroll, { passive: true });
  }

  // ---- card / pill UI -----------------------------------------------------
  function trShowPill(show) {
    var pill = trEl('worTrPill');
    if (!pill) return;
    pill.textContent = 'ترجمة إلى ' + trTargetName();
    pill.hidden = !show;
  }
  // Pill shows only when the feature is on and no card is on screen.
  function trRenderUI() {
    var card = trEl('worTrStatus');
    var offer = trEl('worTrOffer');
    var st = trProgress.status;
    var cardVisible = TR.enabled && st !== 'idle';
    var offerVisible = !!(offer && !offer.hidden);
    trShowPill(TR.enabled && !cardVisible && !offerVisible);
    if (!card) return;
    card.hidden = !cardVisible;
    card.classList.toggle('wor-tr-card--error', st === 'error');
    if (!cardVisible) return;
    var title = trEl('worTrStatusText');
    var meta = trEl('worTrStatusMeta');
    var err = trEl('worTrStatusErr');
    var acts = trEl('worTrStatusActions');
    var text = 'جارٍ ترجمة الفصل…';
    if (st === 'paused') text = 'تم إيقاف الترجمة مؤقتاً';
    else if (st === 'error') text = 'تعذّرت الترجمة';
    else if (st === 'completed') text = 'اكتملت الترجمة';
    if (title) title.textContent = text;
    var metaTxt = trProgress.total > 0 ? (trProgress.completed + ' / ' + trProgress.total) : '';
    if (trProgress.reused > 0) metaTxt += (metaTxt ? ' · ' : '') + 'من الذاكرة: ' + trProgress.reused;
    if (trProgress.requests > 0) metaTxt += (metaTxt ? ' · ' : '') + 'طلبات النموذج: ' + trProgress.requests;
    if (meta) meta.textContent = metaTxt;
    if (err) {
      var showErr = !!trProgress.error && (st === 'error' || st === 'paused');
      err.textContent = showErr ? String(trProgress.error) : '';
      err.hidden = !showErr;
    }
    if (acts) {
      var btns = [];
      if (st === 'running') btns.push(['pause', 'إيقاف']);
      else if (st === 'paused' || st === 'error') btns.push(['resume', 'متابعة']);
      else if (st === 'completed') {
        btns.push(['restore', 'إظهار الأصل']);
        btns.push(['retranslate', 'إعادة الترجمة']);
      }
      acts.innerHTML = btns.map(function (b) {
        return '<button type="button" class="wor-tr-btn" data-wor-tr-action="' + b[0] + '">' + b[1] + '</button>';
      }).join('');
    }
  }
  function trSetProgress(msg) {
    trProgress = {
      status: msg.status || 'idle',
      completed: parseInt(msg.completed, 10) || 0,
      total: parseInt(msg.total, 10) || 0,
      reused: parseInt(msg.reused, 10) || 0,
      error: msg.error == null ? null : String(msg.error),
      requests: parseInt(msg.requests, 10) || 0
    };
    trRenderUI();
  }
  function trSetOffer(visible) {
    var offer = trEl('worTrOffer');
    if (offer) offer.hidden = !visible;
    trRenderUI();
  }
  // Every card/pill interaction is forwarded to RN as a trButton event — the
  // shell never starts/stops rounds on its own, RN posts back the commands.
  function trBindUI() {
    var pill = trEl('worTrPill');
    pill && pill.addEventListener('click', function () { send({ t: 'trButton', action: 'start' }); });
    var offer = trEl('worTrOffer');
    offer && offer.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-wor-tr-offer-start]')) send({ t: 'trButton', action: 'start' });
      else if (e.target.closest && e.target.closest('[data-wor-tr-offer-dismiss]')) send({ t: 'trButton', action: 'dismissOffer' });
    });
    var card = trEl('worTrStatus');
    card && card.addEventListener('click', function (e) {
      var act = e.target.closest && e.target.closest('[data-wor-tr-action]');
      if (act) { send({ t: 'trButton', action: act.getAttribute('data-wor-tr-action') }); return; }
      if (e.target.closest && e.target.closest('[data-wor-tr-settings]')) send({ t: 'trButton', action: 'settings' });
      else if (e.target.closest && e.target.closest('[data-wor-tr-dismiss]')) send({ t: 'trButton', action: 'dismiss' });
    });
  }
  function trInit() {
    trBindUI();
    trEnsureObservers();
    trRenderUI();
  }

  // ============================ receive (RN -> web) ============================
  function receive(msg) {
    try {
      var kind = msg.kind;
      if (kind === 'settings') {
        for (var k in msg.settings) if (Object.prototype.hasOwnProperty.call(msg.settings, k)) S[k] = msg.settings[k];
        if (msg.settings.customColors !== undefined) customColors = !!msg.settings.customColors;
        applySettingsUI();
        $all('p[data-wor-source]').forEach(function (el) {
          var text = el.hasAttribute('data-wor-tr-text') ? el.getAttribute('data-wor-tr-text') : el.getAttribute('data-wor-source');
          el.innerHTML = formatLine(text, S);
        });
      }
      else if (kind === 'chapter') {
        restoreEpoch++;
        userTouched = false;
        CH = msg;
        favOn = !!msg.isFavorite;
        // when the chapter is re-rendered in place (formatting change), keep the
        // reader at the exact position they were reading instead of resetting
        var keepY = msg.keepScroll ? (window.scrollY || window.pageYOffset || 0) : 0;
        var link = $('#worNovelLink');
        if (link) link.textContent = msg.novelTitle || '';
        var h1 = $('#worChapterTitle');
        if (h1) h1.textContent = msg.title || ('فصل ' + msg.number);
        var surface = $('#worTextSurface');
        if (surface) surface.innerHTML = msg.html || '';
        resetChapterStash(); // full chapter swap — old stashed html is obsolete
        invalidateSectionTops();
        var strong = $('.wor-reader-dock__progress-copy strong');
        var pct = $('.wor-reader-dock__progress-copy span');
        if (strong) strong.textContent = msg.number + '/' + (msg.total || '—');
        if (pct) pct.textContent = msg.percent || '';
        lastDockNum = msg.number;
        var prog = $('.wor-reader-dock__progress');
        if (prog) prog.style.setProperty('--wor-reader-progress-value', (msg.percentValue || 0) + '%');
        var prev = $('[data-wor-reader-nav-prev]');
        var next = $('[data-wor-reader-nav-next]');
        prev && (msg.hasPrev ? prev.removeAttribute('disabled') : prev.setAttribute('disabled', ''));
        next && (msg.hasNext ? next.removeAttribute('disabled') : next.setAttribute('disabled', ''));
        // PORT EDIT: comments badge/trigger updates removed with the
        // comments trigger markup (showCommentsButton is always false here).
        var authorWrap = $('#worAuthorCardWrap');
        if (authorWrap) authorWrap.style.display = msg.authorCard ? '' : 'none';
        if (msg.authorCard) {
          var an = $('#worAuthorName');
          if (an) an.textContent = msg.authorCard.name || '';
          var av = $('#worAuthorAvatar');
          if (av) av.src = msg.authorCard.avatar || '';
          var bn = $('#worAuthorBanner');
          if (bn) bn.style.backgroundImage = msg.authorCard.banner ? ('url(' + msg.authorCard.banner + ')') : 'none';
        }
        // PORT EDIT: #worReportChapterLabel removed with the report panel.
        var foot = $('#worContinuousFooter');
        if (foot) foot.textContent = '';
        window.__worEnd = false; window.__worNeedLock = false;
        if (msg.keepScroll) {
          pendingScroll = 0;
          window.scrollTo(0, keepY);
        } else {
          pendingScroll = msg.scrollOffset || 0;
          restoreScroll();
        }
        updateFavUI();
        renderChapters();
        renderSearch();
        // Zeus translation: old paragraphs are gone — reset state and send a
        // fresh trDetect sample once the new section settled into the DOM.
        trOnChapterChanged();
      }
      else if (kind === 'appendChapter') {
        var surface2 = $('#worTextSurface');
        if (surface2) surface2.insertAdjacentHTML('beforeend', msg.html || '');
        invalidateSectionTops();
        window.__worNeedLock = false;
        // newly appended chapters push the doc size up — trim the far tail
        if (S.continuousMode) enforceWindow(window.scrollY || 0);
      }
      else if (kind === 'scrollToChapter') {
        // smooth-scroll to a chapter section inside continuous mode
        // (replaces the old parent-side eval hack — CSP-safe)
        var n = 0;
        var num = msg.number;
        (function go() {
          var el = document.querySelector('section[data-ch="' + num + '"]');
          if (!el) return;
          window.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
          if (++n < 3) requestAnimationFrame(go);
        })();
      }
      else if (kind === 'endReached') {
        window.__worEnd = true;
        var foot2 = $('#worContinuousFooter');
        if (foot2) foot2.textContent = '— وصلت إلى آخر فصل متاح —';
      }
      else if (kind === 'loadingNext') {
        var foot3 = $('#worContinuousFooter');
        if (foot3) foot3.textContent = msg.value ? 'جاري جلب الفصل التالي…' : '';
      }
      else if (kind === 'chapters') {
        CHAPTERS = msg.list || [];
        // الإجمالي الحقيقي من الأب (الموقع) — في التطبيق يبقى 0 = قائمة كاملة
        CHAPTERS_TOTAL = parseInt(msg.total, 10) > 0 ? parseInt(msg.total, 10) : CHAPTERS.length;
        if (CHAPTERS.length >= CHAPTERS_TOTAL) CHAPTERS_TOTAL = CHAPTERS.length;
        // اعرض كل ما حمّله الأب (الصفحة الأولى أو المدموج بعد «تحميل المزيد»)
        chaptersPageCount = Math.max(1, Math.ceil(CHAPTERS.length / CHAPTERS_PAGE));
        serverSearchResults = null;
        lastServerSearchQ = null;
        renderChapters();
        renderSearch();
      }
      else if (kind === 'chaptersSearchResults') {
        // نتائج البحث الشامل من الخادم — تُعرض فقط إن ما زال نفس الاستعلام
        var rq = String(msg.q || '').trim().toLowerCase();
        if (msg.loadFailed) {
          lastServerSearchQ = null; // يسمح بإعادة المحاولة
          if (rq && (chaptersSearch || '').trim().toLowerCase() === rq) {
            var st1 = $('.wor-reader-chapters-sheet__state');
            if (st1) st1.textContent = 'تعذر البحث في الخادم — حاول مجدداً';
          }
        } else if (rq) {
          serverSearchResults = { q: rq, results: msg.results || [], total: msg.total || 0 };
          if ((chaptersSearch || '').trim().toLowerCase() === rq) renderChapters();
          if ((searchQ || '').trim().toLowerCase() === rq) renderSearch();
        }
      }
      else if (kind === 'words') {
        WORDS.items = {
          novel: (msg.items && msg.items.novel) || [],
          global: (msg.items && msg.items.global) || []
        };
        renderWords();
      }
      else if (kind === 'wordsSaved') {
        WORDS.items = {
          novel: (msg.items && msg.items.novel) || [],
          global: (msg.items && msg.items.global) || []
        };
        wordsEndEdit();
        toast(msg.toast || 'تم الحفظ');
      }
      // PORT EDIT: 'commentCount' receive branch removed (comments UI removed).
      // else if (kind === 'commentCount') { ... }
      else if (kind === 'fav') {
        favOn = !!msg.value;
        updateFavUI();
      }
      else if (kind === 'scrollTo') {
        pendingScroll = msg.offset || 0;
        restoreScroll();
      }
      else if (kind === 'backPress') {
        var sheet1 = $('#wor-reader-chapters-sheet');
        var sheet2 = $('#wor-reader-words-sheet');
        var search = $('#wor-search');
        var drawer = $('#wor-drawer');
        if (sheet1 && !sheet1.hidden) closeChaptersSheet();
        else if (sheet2 && !sheet2.hidden) closeWordsSheet();
        else if (search && !search.hidden) closeSearch();
        // PORT EDIT: report modal close branch removed with the modal.
        else if (drawer && drawer.classList.contains('is-open')) closeDrawer();
        else send({ t: 'exit' });
      }
      // ---- Zeus chapter translation (tr*) ----
      else if (kind === 'trConfig') {
        TR.enabled = !!msg.enabled;
        if (msg.target != null) TR.target = String(msg.target || '');
        if (msg.rtl != null) TR.rtl = !!msg.rtl;
        TR.caps = (msg.caps && msg.caps.maxCharacters) ? msg.caps : null;
        trRenderUI();
      }
      else if (kind === 'trStart') {
        if (msg.target != null) TR.target = String(msg.target || '');
        if (msg.rtl != null) TR.rtl = !!msg.rtl;
        if (msg.caps && msg.caps.maxCharacters) TR.caps = msg.caps;
        if (TR.savedLang === null) TR.savedLang = document.documentElement.getAttribute('lang') || '';
        TR.active = true;
        collectAndPost(true, true);
      }
      else if (kind === 'trCollect') {
        // Next batch (scroll / continuation after a capped round).
        collectAndPost(true, true);
      }
      else if (kind === 'trApply') {
        trApplyItems(msg.items || [], parseInt(msg.expected, 10) || 0);
      }
      else if (kind === 'trRestore') {
        trRestoreAll();
      }
      else if (kind === 'trProgress') {
        trSetProgress(msg);
      }
      else if (kind === 'trOffer') {
        trSetOffer(!!msg.visible);
      }
      else if (kind === 'toast') toast(msg.text || '');
    } catch (e) {
      send({ t: 'error', message: String(e && e.message || e) });
    }
  }

  function restoreScroll() {
    var inOffset = Math.max(0, pendingScroll || 0);
    var ticket = ++restoreEpoch;
    // The saved offset is measured INSIDE the chapter's own section (v2), so the
    // restore target is sectionTop + inOffset. Old v1 saves stored a global
    // offset — those are simply clamped to the page maximum.
    function go() {
      if (ticket !== restoreEpoch || userTouched) return;
      var sec = (CH && CH.number != null) ? document.querySelector('.wor-chapter-sec[data-ch="' + CH.number + '"]') : null;
      var top = sec ? sec.offsetTop : 0;
      var doc = document.documentElement;
      var maxY = Math.max(0, doc.scrollHeight - window.innerHeight);
      window.scrollTo(0, inOffset === 0 ? 0 : Math.min(top + inOffset, maxY));
    }
    if (inOffset === 0) go();
    setTimeout(go, 60);
    setTimeout(go, 320);
    setTimeout(go, 900);
    pendingScroll = 0;
  }

  window.__wor = { receive: receive, send: send, setDock: setDock, toast: toast };

  // ============================ boot ============================
  function measureTopbar() {
    var tb = $('.wor-topbar');
    if (tb) document.documentElement.style.setProperty('--wor-topbar-h', (tb.offsetHeight || 58) + 'px');
    if (dockOpen) setDock(true);
  }
  function boot() {
    wire();
    trInit(); // Zeus translation: card/pill wiring + re-collection observers
    preloadFonts();
    applySettingsUI();
    setDock(S.dockOpen !== false);
    // PORT EDIT: renderReportTypes() call removed with the report UI.
    // Local fonts settle asynchronously — a late swap reflows the document, so
    // the cached section tops must be recomputed once every face is ready.
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { invalidateSectionTops(); }).catch(function () {});
    }
    if (USER.role === 'admin') {
      var adm = $('[data-wor-admin-tools]');
      adm && adm.removeAttribute('hidden');
    }
    send({ t: 'ready' });
    var loader = $('#worBootLoading');
    setTimeout(function () { loader && loader.classList.add('is-done'); }, 200);
    setTimeout(measureTopbar, 250);
    setTimeout(measureTopbar, 1000);
    window.addEventListener('resize', measureTopbar);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}

// ---------------------------------------------------------------------------
// Shell document
// ---------------------------------------------------------------------------
const escHtml = s =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// JSON embedded directly inside <script> — keep "</" from closing the tag.
const safeJson = obj => JSON.stringify(obj).replace(/<\//g, '<\\/');

// PORT EDIT (local fonts): one @font-face rule per bundled face. `fontsBase` is
// the absolute runtime prefix of the bundled reader assets (see
// src/utils/readerAssets.ts) — e.g. file://<bundle>/ReaderAssets on iOS or
// file:///android_asset on Android — so <url> always points at the TTF that
// ships inside the app. Variable fonts register a single face across weights;
// static pairs register 400/700 separately.
function worFontFaces(fontsBase) {
  const base = String(fontsBase || '').replace(/\/+$/, '');
  if (!base) return '';
  return WOR_FONT_FACES.map(
    face =>
      `@font-face{font-family:'${face.family}';src:url('${base}/fonts/newmoon/${
        face.file
      }') format('truetype');font-weight:${
        face.weight || '300 900'
      };font-display:swap;}`,
  ).join('\n');
}

export function buildWorShell({
  safeTop = 0,
  safeBottom = 0,
  novelTitle = '',
  novelCover = '',
  userName = '',
  userRole = '',
  initialSettings = {},
  fontsBase = '',
}) {
  const settingsJson = safeJson({ ...initialSettings, safeTop, safeBottom });
  const userJson = safeJson({ name: userName || '', role: userRole || '' });
  const fontsJson = safeJson(WOR_FONTS);
  const presetsJson = safeJson(WOR_BG_PRESETS);
  const title = escHtml(novelTitle);
  const cover = escHtml(novelCover);

  const script = bridgeScript()
    .split("'__WOR_FORMATTER__'")
    .join(LINE_FORMATTER_SOURCE)
    .split("'__WOR_SETTINGS__'")
    .join(settingsJson)
    .split("'__WOR_USER__'")
    .join(userJson)
    .split("'__WOR_FONTS__'")
    .join(fontsJson)
    .split("'__WOR_BG_PRESETS__'")
    .join(presetsJson);

  const coverImg = novelCover
    ? `<img src="${cover}" alt="" width="64" height="64" loading="lazy" decoding="async">`
    : '';

  const colorDots = key =>
    WOR_FORMAT_COLORS.map(
      c =>
        `<button type="button" class="wor-color-dot" style="background:${c}" data-wor-color-dot data-key="${key}" data-value="${c}" aria-label="${c}"></button>`,
    ).join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar" data-wor-theme="custom">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<style>
  /* PORT EDIT: the Google-Fonts @import was removed — every reader face is a
     locally bundled TTF registered below (weights map onto variable fonts). */
  ${worFontFaces(fontsBase)}
</style>
<style>${WOR_CSS}</style>
<style>${WOR_APP_CSS}</style>
</head>
<body class="wor-body single-wor_chapter wor_chapter-template-default">

<!-- boot loader -->
<div class="wor-boot-loading" id="worBootLoading"><div class="wor-boot-spinner"></div></div>

<!-- drawer -->
<div class="wor-drawer-backdrop" data-wor-drawer-backdrop hidden></div>
<aside class="wor-drawer" id="wor-drawer" aria-hidden="true" inert>
  <div class="wor-drawer__head">
    <a class="wor-brand" href="#" data-wor-nav="novel"><span>${title}</span></a>
    <button class="wor-icon-btn" type="button" data-wor-drawer-close aria-label="إغلاق القائمة">
      <span aria-hidden="true"><svg class="wor-ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"></path></svg></span>
    </button>
  </div>
  <div class="wor-drawer__account-state">
    <div class="wor-drawer-user">
      <span class="wor-drawer-user__avatar">${(userName || 'ق')
        .trim()
        .charAt(0)}</span>
      <span class="wor-drawer-user__meta">
        <strong>${userName || 'قارئ زائر'}</strong>
        <small>${userRole === 'admin' ? 'مدير التطبيق' : 'قارئ'}</small>
      </span>
    </div>
  </div>
  <nav class="wor-drawer__nav wor-drawer__nav--modern" aria-label="القائمة الجانبية">
    <a href="#" data-wor-nav="novel"><span>صفحة الرواية</span></a>
    <a href="#" data-wor-nav="home"><span>الرئيسية</span></a>
    <a href="#" data-wor-nav="downloads"><span>التنزيلات</span></a>
    <a href="#" data-wor-nav="settings"><span>الإعدادات</span></a>
    <a href="#" data-wor-nav="about"><span>حول التطبيق</span></a>
  </nav>
</aside>

<!-- search -->
<div class="wor-search" id="wor-search" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-label="البحث">
  <div class="wor-search__panel">
    <form class="wor-search__form" role="search" onsubmit="return false;">
      <label class="screen-reader-text" for="wor-search-input">بحث</label>
      <input id="wor-search-input" type="search" placeholder="ابحث عن فصل..." autocomplete="off">
      <button type="submit">بحث</button>
      <button type="button" data-wor-search-close aria-label="إغلاق البحث">×</button>
    </form>
    <div class="wor-search__suggestions" role="listbox" aria-label="نتائج البحث">
      <div class="wor-search__status" data-wor-search-status></div>
      <div class="wor-search__results" id="worSearchResults" data-wor-search-results></div>
    </div>
  </div>
</div>

<!-- reading page -->
<main class="wor-reader-main wor-page">
  <article class="wor-reading-page" data-wor-continuous-chapter="1">
    <header class="wor-reading-page__header">
      <a class="wor-reading-page__novel" href="#" id="worNovelLink" data-wor-nav="novel"></a>
      <h1 id="worChapterTitle"></h1>
    </header>
    <div class="wor-reader-text-surface" id="worTextSurface" data-wor-reader-text></div>
    <div class="wor-continuous-footer" id="worContinuousFooter"></div>
    <div class="wor-end-mark">◆ ◆ ◆</div>
    <div class="wor-author-section-wrapper" id="worAuthorCardWrap" style="display:none">
      <div class="wor-author-section-title">الناشر</div>
      <div class="wor-author-card" data-wor-author-card>
        <div class="wor-author-banner" id="worAuthorBanner"></div>
        <div class="wor-author-overlay"></div>
        <div class="wor-author-content">
          <div class="wor-author-avatar-wrapper"><img id="worAuthorAvatar" class="wor-author-avatar-img" alt="" /></div>
          <div class="wor-author-name" id="worAuthorName"></div>
        </div>
      </div>
    </div>
    <!-- PORT EDIT: comments trigger markup removed (no comments backend). -->
  </article>
</main>

<!-- chapter progress bar -->
<div class="wor-reader-chapter-progress" data-wor-reader-chapter-progress aria-hidden="false">
  <span class="wor-reader-chapter-progress__track" aria-hidden="true">
    <span class="wor-reader-chapter-progress__fill" data-wor-reader-chapter-progress-fill style="width:0%"></span>
  </span>
</div>

<!-- dock -->
<section class="wor-reader-dock" data-wor-reader-dock data-wor-reader-dock-state="open" aria-label="أدوات قراءة الفصل" data-wor-reader-active-panel="book">
  <div class="wor-reader-dock__top wor-reader-dock__top--book">
    <a class="wor-reader-dock__nav wor-reader-dock__nav--next" href="#" data-wor-reader-nav-next>
      <span class="wor-reader-dock__nav-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14M14 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
      <strong>التالي</strong>
    </a>
    <div class="wor-reader-dock__progress" aria-label="تقدمك في الرواية" style="--wor-reader-progress-value: 0%;">
      <div class="wor-reader-dock__progress-copy">
        <strong>—</strong>
        <span></span>
      </div>
      <span class="wor-reader-dock__progress-track" aria-hidden="true"><span class="wor-reader-dock__progress-fill"></span></span>
    </div>
    <a class="wor-reader-dock__nav wor-reader-dock__nav--previous" href="#" data-wor-reader-nav-prev>
      <strong>السابق</strong>
      <span class="wor-reader-dock__nav-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5M10 7l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
    </a>
  </div>

  <!-- panel: book -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--book" id="wor-reader-panel-book" data-wor-reader-panel="book" role="tabpanel">
    <div class="wor-reader-dock__actions">
      <a class="wor-reader-dock__action wor-reader-dock__action--novel" href="#" data-wor-reader-dock-novel aria-label="صفحة الرواية">
        <span class="wor-reader-dock__cover" aria-hidden="true">${coverImg}</span>
        <strong>صفحة الرواية</strong>
      </a>
      <button class="wor-reader-dock__action" type="button" data-wor-reader-chapters-open aria-controls="wor-reader-chapters-sheet" aria-expanded="false">
        <span class="wor-reader-dock__mini-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6h10M9 12h10M9 18h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path><circle cx="5" cy="6" r="1.35" fill="currentColor"></circle><circle cx="5" cy="12" r="1.35" fill="currentColor"></circle><circle cx="5" cy="18" r="1.35" fill="currentColor"></circle></svg></span>
        <strong>قائمة الفصول</strong>
      </button>
      <button class="wor-reader-dock__action wor-reader-dock__action--favorite" type="button" data-wor-favorite-toggle aria-pressed="false" aria-label="إضافة إلى المفضلة">
        <span class="wor-reader-dock__mini-icon" data-wor-favorite-icon aria-hidden="true"><svg class="wor-reader-dock__svg wor-reader-heart-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="wor-reader-heart-icon__fill" d="M12 20.3 4.6 13A5 5 0 0 1 11.7 6l.3.3.3-.3a5 5 0 0 1 7.1 7L12 20.3Z" fill="currentColor" opacity="0"></path><path d="M12 20.3 4.6 13A5 5 0 0 1 11.7 6l.3.3.3-.3a5 5 0 0 1 7.1 7L12 20.3Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
        <strong data-wor-favorite-label>المفضلة</strong>
      </button>
      <button class="wor-reader-dock__action" type="button" data-wor-reader-words-open aria-controls="wor-reader-words-sheet" aria-expanded="false">
        <span class="wor-reader-dock__mini-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h12.5M14.5 4l3 3-3 3M19 17H6.5M9.5 20l-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
        <strong>تغيير الكلمات</strong>
      </button>
    </div>
  </div>

  <!-- panel: text -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--text" id="wor-reader-panel-text" data-wor-reader-panel="text" role="tabpanel" style="display:none">
    <div class="wor-reader-text-settings">
      <div class="wor-reader-text-setting">
        <h3>حجم الخط</h3>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeFontSize:-1">−</button>
          <input id="worRangeFontSize" type="range" min="14" max="34" step="1" value="18">
          <output>18px</output>
          <button type="button" data-wor-range-step="worRangeFontSize:1">+</button>
        </div>
      </div>
      <div class="wor-reader-text-setting">
        <h3>تباعد الأسطر</h3>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeLineHeight:-0.1">−</button>
          <input id="worRangeLineHeight" type="range" min="1.5" max="3" step="0.1" value="2.3">
          <output>2.3</output>
          <button type="button" data-wor-range-step="worRangeLineHeight:0.1">+</button>
        </div>
      </div>
      <div class="wor-reader-text-setting">
        <h3>تباعد الكلمات</h3>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeWordSpacing:-1">−</button>
          <input id="worRangeWordSpacing" type="range" min="-2" max="10" step="1" value="0">
          <output>0px</output>
          <button type="button" data-wor-range-step="worRangeWordSpacing:1">+</button>
        </div>
      </div>
      <div class="wor-reader-text-setting">
        <h3>سطوع الخط</h3>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeBrightness:-0.05">−</button>
          <input id="worRangeBrightness" type="range" min="0.4" max="1.5" step="0.05" value="1.05">
          <output>1.05</output>
          <button type="button" data-wor-range-step="worRangeBrightness:0.05">+</button>
        </div>
      </div>
      <div class="wor-reader-text-setting wor-reader-text-setting--choices">
        <h3>سمك الخط</h3>
        <div class="wor-reader-text-choices" data-wor-weight>
          <button type="button" data-value="300">خفيف</button>
          <button type="button" data-value="400" class="is-active">متوسط</button>
          <button type="button" data-value="700">عريض</button>
        </div>
      </div>
      <div class="wor-reader-text-setting wor-reader-text-setting--choices">
        <h3>اتجاه النص</h3>
        <div class="wor-reader-text-choices" data-wor-direction>
          <button type="button" data-value="rtl" class="is-active">RTL</button>
          <button type="button" data-value="center">وسط</button>
          <button type="button" data-value="ltr">LTR</button>
        </div>
      </div>
    </div>
  </div>

  <!-- panel: font -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--font" id="wor-reader-panel-font" data-wor-reader-panel="font" role="tabpanel" style="display:none">
    <div class="wor-reader-font-tools">
      <label class="wor-reader-font-search">
        <span class="screen-reader-text">البحث عن خط</span>
        <input id="worFontSearch" type="search" placeholder="ابحث عن خط بالاسم..." autocomplete="off">
      </label>
      <div class="wor-reader-font-settings" id="worFontChoices">
        ${WOR_FONTS.map(
          (f, i) => `
        <button class="wor-reader-font-choice${
          i === 0 ? ' is-active' : ''
        }" type="button" data-wor-font-choice data-value="${
            f.value
          }" data-name="${f.name}" aria-pressed="${
            i === 0
          }" style="font-family:${escHtml(
            f.family === 'inherit' ? 'var(--wor-ui-font)' : f.family,
          )}">
          <strong>${f.name}</strong>
        </button>`,
        ).join('')}
      </div>
    </div>
  </div>

  <!-- panel: background -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--background" id="wor-reader-panel-background" data-wor-reader-panel="background" role="tabpanel" style="display:none">
    <div class="wor-reader-background-settings">
      <div class="wor-reader-background-presets">
        ${WOR_BG_PRESETS.map(
          p => `
        <button class="wor-reader-background-preset" type="button" data-wor-bg-preset data-value="${p.value}">
          <span class="wor-reader-background-preset__sample" style="background:${p.bg};color:${p.text}">Aa</span>
          <strong>${p.name}</strong>
        </button>`,
        ).join('')}
      </div>
      <div class="wor-reader-background-custom">
        <div class="wor-reader-background-custom__head">
          <div class="wor-reader-background-custom__copy">
            <h3>تخصيص الألوان</h3>
            <p>اختر لون الخلفية ولون النص كما تريد، وسيتم تطبيقهما مباشرة على الفصل.</p>
          </div>
          <button class="wor-reader-background-custom__toggle is-inactive" type="button" data-wor-background-custom-toggle>
            <span class="wor-reader-background-custom__toggle-dot"></span>
            <span class="wor-reader-background-custom__toggle-label" data-wor-background-custom-toggle-label>غير مفعّل</span>
          </button>
        </div>
        <div class="wor-reader-background-palette" style="display:none">
          <section class="wor-reader-background-picker" id="wor-picker-bg">
            <div class="wor-reader-background-picker__head">
              <div class="wor-reader-background-picker__meta">
                <i class="wor-reader-background-picker__swatch" data-wor-picker-swatch></i>
                <div>
                  <h4>لون الخلفية</h4>
                  <span data-wor-picker-hex>#000000</span>
                </div>
              </div>
            </div>
            <div class="wor-reader-background-picker__body">
              <div class="wor-reader-background-picker__canvas" aria-label="تخصيص لون الخلفية"><canvas></canvas><span class="wor-reader-background-picker__handle"></span></div>
              <div class="wor-reader-background-picker__side">
                <label class="wor-reader-background-picker__hue">
                  <span>درجة اللون</span>
                  <input type="range" min="0" max="360" step="1" value="0" aria-label="درجة لون الخلفية">
                </label>
                <label class="wor-reader-background-picker__hex">
                  <span>HEX</span>
                  <input type="text" placeholder="#000000" value="#000000">
                </label>
              </div>
            </div>
          </section>
          <section class="wor-reader-background-picker" id="wor-picker-text">
            <div class="wor-reader-background-picker__head">
              <div class="wor-reader-background-picker__meta">
                <i class="wor-reader-background-picker__swatch" data-wor-picker-swatch></i>
                <div>
                  <h4>لون النص</h4>
                  <span data-wor-picker-hex>#FFFFFF</span>
                </div>
              </div>
            </div>
            <div class="wor-reader-background-picker__body">
              <div class="wor-reader-background-picker__canvas" aria-label="تخصيص لون النص"><canvas></canvas><span class="wor-reader-background-picker__handle"></span></div>
              <div class="wor-reader-background-picker__side">
                <label class="wor-reader-background-picker__hue">
                  <span>درجة اللون</span>
                  <input type="range" min="0" max="360" step="1" value="0" aria-label="درجة لون النص">
                </label>
                <label class="wor-reader-background-picker__hex">
                  <span>HEX</span>
                  <input type="text" placeholder="#FFFFFF" value="#FFFFFF">
                </label>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>

  <!-- panel: settings -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--settings" id="wor-reader-panel-settings" data-wor-reader-panel="settings" role="tabpanel" style="display:none">
    <div class="wor-reader-extra-settings" aria-label="إعدادات القراءة الإضافية">
      <div class="wor-reader-extra-card wor-reader-extra-card--chapter-progress">
        <div class="wor-reader-extra-card__head">
          <div class="wor-reader-extra-card__copy"><h3>شريط تقدم الفصل</h3></div>
          <button type="button" class="wor-reader-switch is-active" data-wor-chapter-progress-toggle aria-pressed="true">مفعّل</button>
        </div>
        <div class="wor-reader-chapter-progress-setting">
          <div class="wor-reader-chapter-progress-setting__row">
            <span>لون الشريط</span>
            <button type="button" class="wor-reader-chapter-progress-setting__color" data-wor-chapter-progress-color-open aria-expanded="false" aria-controls="wor-reader-chapter-progress-color-picker">
              <i></i><code>#00FFFF</code>
            </button>
          </div>
          <div class="wor-reader-chapter-progress-color-picker" id="wor-reader-chapter-progress-color-picker" hidden>
            <div class="wor-reader-chapter-progress-color-picker__canvas" aria-label="تخصيص لون شريط تقدم الفصل"><canvas></canvas><span class="wor-picker-handle wor-reader-background-picker__handle"></span></div>
            <div class="wor-reader-chapter-progress-color-picker__controls">
              <label class="wor-reader-chapter-progress-color-picker__hue">
                <span>درجة اللون</span>
                <input type="range" min="0" max="360" step="1" value="180" aria-label="درجة لون شريط التقدم">
              </label>
              <label class="wor-reader-chapter-progress-color-picker__hex">
                <span>HEX</span>
                <input type="text" placeholder="#00FFFF" value="#00FFFF">
              </label>
            </div>
          </div>
        </div>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact">
        <div class="wor-reader-extra-card__head">
          <h3>القراءة المتصلة</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="continuous">مغلق</button>
        </div>
        <p>تضيف الفصل التالي داخل الصفحة تلقائياً أثناء التمرير.</p>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact">
        <div class="wor-reader-extra-card__head">
          <h3>النزول التلقائي</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="autoscroll">مغلق</button>
        </div>
        <p>يمرر الفصل للأسفل ببطء تلقائياً أثناء القراءة.</p>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact">
        <div class="wor-reader-extra-card__head">
          <h3>البقاء مستيقظاً</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="keepawake">مغلق</button>
        </div>
        <p>يمنع إطفاء الشاشة أثناء القراءة.</p>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact">
        <div class="wor-reader-extra-card__head">
          <h3>إخفاء عنوان الفصل</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="hidetitle">مغلق</button>
        </div>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact">
        <div class="wor-reader-extra-card__head">
          <h3>فتح الأدوات بلمس الشاشة</h3>
          <button type="button" class="wor-reader-switch is-active" data-wor-switch="taptoggle">مفعّل</button>
        </div>
      </div>
      <div class="wor-reader-extra-card wor-reader-extra-card--compact" data-wor-admin-tools hidden>
        <div class="wor-reader-extra-card__head">
          <h3>أدوات المدير</h3>
        </div>
        <p>أدوات إدارية خاصة بفريق التطبيق.</p>
        <div class="wor-reader-dock__actions" style="margin-top:10px">
          <button class="wor-reader-dock__action" type="button" data-wor-tool="cleaner">
            <strong>الحذف الشامل</strong>
          </button>
          <button class="wor-reader-dock__action" type="button" data-wor-tool="copyright">
            <strong>حقوق التطبيق</strong>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- panel: coloring (التلوين) -->
  <div class="wor-reader-dock__panel wor-reader-dock__panel--color" id="wor-reader-panel-color" data-wor-reader-panel="color" role="tabpanel" style="display:none">
    <div class="wor-color-wrap">
      <p class="wor-color-hint">لوّن الكلمات المحصورة بين علامات تنصيص تختارها بنفسك، ويُطبق التنسيق فوراً على الفصل أثناء القراءة.</p>

      <div class="wor-fmt-card" data-wor-fmt-card="dialogue">
        <div class="wor-fmt-card__head">
          <h3>الحوار (علامات التنصيص)</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="dialogue">مغلق</button>
        </div>
        <span class="wor-fmt-card__label">نمط التنصيص</span>
        <div class="wor-style-row" data-wor-fmt-style="quote">
          <button type="button" class="wor-style-chip" data-value="all">بدون</button>
          <button type="button" class="wor-style-chip" data-value="guillemets">« »</button>
          <button type="button" class="wor-style-chip" data-value="curly">“ ”</button>
          <button type="button" class="wor-style-chip" data-value="straight">" "</button>
          <button type="button" class="wor-style-chip" data-value="single">‘ ’</button>
        </div>
        <span class="wor-fmt-card__label">اللون</span>
        <div class="wor-color-grid" data-wor-color-for="dialogueColor">${colorDots(
          'dialogueColor',
        )}</div>
        <span class="wor-fmt-card__label">حجم الحوار</span>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeDialogueSize:-5">−</button>
          <input id="worRangeDialogueSize" type="range" min="80" max="150" step="5" value="100">
          <output>100%</output>
          <button type="button" data-wor-range-step="worRangeDialogueSize:5">+</button>
        </div>
        <div class="wor-fmt-card__head">
          <h3 class="wor-fmt-card__sub">إخفاء علامات التنصيص</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="hidequotes">مغلق</button>
        </div>
      </div>

      <div class="wor-fmt-card" data-wor-fmt-card="markdown">
        <div class="wor-fmt-card__head">
          <h3>العريض (علامات **)</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="markdown">مغلق</button>
        </div>
        <span class="wor-fmt-card__label">نمط العلامات</span>
        <div class="wor-style-row" data-wor-fmt-style="markdown">
          <button type="button" class="wor-style-chip" data-value="all">بدون</button>
          <button type="button" class="wor-style-chip" data-value="guillemets">« »</button>
          <button type="button" class="wor-style-chip" data-value="curly">“ ”</button>
          <button type="button" class="wor-style-chip" data-value="straight">" "</button>
          <button type="button" class="wor-style-chip" data-value="single">‘ ’</button>
        </div>
        <span class="wor-fmt-card__label">اللون</span>
        <div class="wor-color-grid" data-wor-color-for="markdownColor">${colorDots(
          'markdownColor',
        )}</div>
        <span class="wor-fmt-card__label">حجم العريض</span>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeMarkdownSize:-5">−</button>
          <input id="worRangeMarkdownSize" type="range" min="80" max="150" step="5" value="100">
          <output>100%</output>
          <button type="button" data-wor-range-step="worRangeMarkdownSize:5">+</button>
        </div>
        <div class="wor-fmt-card__head">
          <h3 class="wor-fmt-card__sub">إخفاء علامات **</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="hidemarkdown">مغلق</button>
        </div>
      </div>

      <div class="wor-fmt-card" data-wor-fmt-card="bracket">
        <div class="wor-fmt-card__head">
          <h3>الأقواس [ ]</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="bracket">مغلق</button>
        </div>
        <span class="wor-fmt-card__label">نمط العلامات الداخلية</span>
        <div class="wor-style-row" data-wor-fmt-style="bracket">
          <button type="button" class="wor-style-chip" data-value="all">بدون</button>
          <button type="button" class="wor-style-chip" data-value="guillemets">« »</button>
          <button type="button" class="wor-style-chip" data-value="curly">“ ”</button>
          <button type="button" class="wor-style-chip" data-value="straight">" "</button>
          <button type="button" class="wor-style-chip" data-value="single">‘ ’</button>
        </div>
        <span class="wor-fmt-card__label">اللون</span>
        <div class="wor-color-grid" data-wor-color-for="bracketColor">${colorDots(
          'bracketColor',
        )}</div>
        <span class="wor-fmt-card__label">حجم الأقواس</span>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeBracketSize:-5">−</button>
          <input id="worRangeBracketSize" type="range" min="80" max="150" step="5" value="110">
          <output>110%</output>
          <button type="button" data-wor-range-step="worRangeBracketSize:5">+</button>
        </div>
        <div class="wor-fmt-card__head">
          <h3 class="wor-fmt-card__sub">إخفاء علامات [ ]</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="hidebrackets">مغلق</button>
        </div>
      </div>

      <div class="wor-fmt-card" data-wor-fmt-card="custom">
        <div class="wor-fmt-card__head">
          <h3>علامات مخصصة</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="custom">مغلق</button>
        </div>
        <span class="wor-fmt-card__label">حدد علامتي الفتح والإغلاق كما تريد</span>
        <div class="wor-custom-marks">
          <input id="worCustomOpenMark" type="text" placeholder="علامة الفتح" autocomplete="off">
          <span class="wor-custom-marks__arrow">←</span>
          <input id="worCustomCloseMark" type="text" placeholder="علامة الإغلاق" autocomplete="off">
        </div>
        <span class="wor-fmt-card__label">اللون</span>
        <div class="wor-color-grid" data-wor-color-for="customColor">${colorDots(
          'customColor',
        )}</div>
        <span class="wor-fmt-card__label">الحجم</span>
        <div class="wor-reader-range-control">
          <button type="button" data-wor-range-step="worRangeCustomSize:-5">−</button>
          <input id="worRangeCustomSize" type="range" min="80" max="150" step="5" value="105">
          <output>105%</output>
          <button type="button" data-wor-range-step="worRangeCustomSize:5">+</button>
        </div>
        <div class="wor-fmt-card__head">
          <h3 class="wor-fmt-card__sub">إخفاء العلامات المخصصة</h3>
          <button type="button" class="wor-reader-switch" data-wor-switch="hidecustom">مغلق</button>
        </div>
      </div>
    </div>
  </div>

  <!-- PORT EDIT: report panel removed (no report backend). -->

  <!-- dock tabs -->
  <div class="wor-reader-dock__tabs" aria-label="أقسام أدوات القراءة">
    <button class="wor-reader-dock__tab is-active" type="button" data-wor-tab="book" id="wor-reader-tab-book">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><path d="M8 7.5h8M8 11h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg></span>
      <span class="wor-reader-dock__tab-label">الفصل</span>
    </button>
    <button class="wor-reader-dock__tab" type="button" data-wor-tab="text" id="wor-reader-tab-text">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 6h14M12 6v13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path></svg></span>
      <span class="wor-reader-dock__tab-label">النص</span>
    </button>
    <button class="wor-reader-dock__tab" type="button" data-wor-tab="font" id="wor-reader-tab-font">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 13.5 10.5 5h3L18 13.5M8 10.5h8M9.5 19h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
      <span class="wor-reader-dock__tab-label">الخط</span>
    </button>
    <button class="wor-reader-dock__tab" type="button" data-wor-tab="background" id="wor-reader-tab-background">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"></rect><path d="M4 14.5 9 9l11 8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><circle cx="15.4" cy="8.6" r="1.5" fill="currentColor"></circle></svg></span>
      <span class="wor-reader-dock__tab-label">الخلفية</span>
    </button>
    <button class="wor-reader-dock__tab" type="button" data-wor-tab="settings" id="wor-reader-tab-settings">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h9m3.5 0H19M5 12h3m3.5 0H19M5 17h9m3.5 0H19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path><circle cx="15.5" cy="7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.7"></circle><circle cx="9.5" cy="12" r="1.7" fill="none" stroke="currentColor" stroke-width="1.7"></circle><circle cx="15.5" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="1.7"></circle></svg></span>
      <span class="wor-reader-dock__tab-label">الإعدادات</span>
    </button>
    <button class="wor-reader-dock__tab" type="button" data-wor-tab="color" id="wor-reader-tab-color">
      <span class="wor-reader-dock__tab-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.2a8.8 8.8 0 1 0 0 17.6h1.6a2.1 2.1 0 0 0 0-4.2H12a1.7 1.7 0 0 1 0-3.4h5.8A3.2 3.2 0 0 0 21 10C21 6.2 16.9 3.2 12 3.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><circle cx="7.4" cy="10.6" r="1.25" fill="currentColor"></circle><circle cx="11.4" cy="7.2" r="1.25" fill="currentColor"></circle><circle cx="15.8" cy="9.4" r="1.25" fill="currentColor"></circle></svg></span>
      <span class="wor-reader-dock__tab-label">التلوين</span>
    </button>
    <!-- PORT EDIT: report dock tab removed. -->
  </div>
</section>

<!-- floating dock toggle -->
<button class="wor-reader-dock__toggle wor-reader-dock__toggle--floating" type="button" aria-expanded="true" aria-label="فتح/إغلاق أدوات القراءة">
  <span class="wor-reader-dock__toggle-icon" aria-hidden="true"><svg class="wor-reader-dock__svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 14 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>
</button>

<!-- chapters sheet -->
<div class="wor-reader-chapters-sheet" id="wor-reader-chapters-sheet" role="dialog" aria-modal="true" aria-label="قائمة الفصول" hidden aria-hidden="true">
  <div class="wor-reader-chapters-sheet__head">
    <h2>قائمة الفصول</h2>
    <div style="display:flex;gap:8px">
      <button class="wor-reader-chapters-sheet__close" type="button" data-wor-chapters-sort aria-label="ترتيب الفصول" title="ترتيب تنازلي / تصاعدي">
        <svg class="wor-ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4v13m0 3-3.5-3.5M7 20l3.5-3.5M17 20V7m0-3 3.5 3.5M17 4l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
      </button>
      <button class="wor-reader-chapters-sheet__close" type="button" data-wor-chapters-close aria-label="إغلاق">×</button>
    </div>
  </div>
  <div class="wor-reader-chapters-sheet__search">
    <input id="worChaptersSearch" type="search" placeholder="ابحث برقم الفصل أو عنوانه..." autocomplete="off">
  </div>
  <div class="wor-reader-chapters-sheet__list" id="worChaptersList"></div>
  <div class="wor-reader-chapters-sheet__footer">
    <button class="wor-reader-chapters-sheet__more" type="button" id="worChaptersMore">المزيد</button>
  </div>
</div>

<!-- words sheet (Galaxy "تغيير الكلمات") -->
<div class="wor-reader-words-sheet" id="wor-reader-words-sheet" role="dialog" aria-modal="true" aria-label="تغيير الكلمات" hidden aria-hidden="true">
  <div class="wor-reader-words-sheet__head">
    <h2>تغيير الكلمات</h2>
    <button class="wor-reader-words-sheet__close" type="button" data-wor-words-close aria-label="إغلاق">×</button>
  </div>
  <div class="wor-reader-words-sheet__body">
    <div class="wor-reader-words-editor">
      <div class="wor-reader-words-tabs" role="tablist" aria-label="نطاق تغيير الكلمات">
        <button type="button" data-wor-words-scope="novel" aria-selected="true" class="is-active">هذه الرواية</button>
        <button type="button" data-wor-words-scope="global" aria-selected="false">كل الروايات</button>
      </div>
      <p class="wor-reader-words-sheet__hint">استبدل مصطلحًا أثناء القراءة لهذه الرواية أو لكل الروايات.</p>
      <form class="wor-reader-words-form" data-wor-words-form autocomplete="off">
        <label>
          <span>الكلمة الأصلية</span>
          <input type="text" data-wor-words-from placeholder="مثال: الاسم القديم" required>
        </label>
        <label>
          <span>الكلمة البديلة</span>
          <input type="text" data-wor-words-to placeholder="مثال: الاسم الجديد">
        </label>
        <div class="wor-reader-words-form__options">
          <div class="wor-reader-words-form__switches">
            <label class="wor-reader-words-check">
              <input type="radio" name="worWordsMode" data-wor-words-mode="smart" checked>
              <span>استبدال ذكي</span>
            </label>
            <label class="wor-reader-words-check">
              <input type="radio" name="worWordsMode" data-wor-words-mode="exact">
              <span>كلمة مستقلة</span>
            </label>
            <label class="wor-reader-words-check wor-reader-words-check--color">
              <input type="checkbox" data-wor-words-color-on>
              <span>تلوين البديل</span>
            </label>
          </div>
          <div class="wor-reader-words-color-control" data-wor-words-color-control aria-hidden="true">
            <input type="hidden" data-wor-words-color value="#0ea5e9">
            <div class="wor-reader-words-color-control__head">
              <div class="wor-reader-words-color-summary">
                <i class="wor-reader-words-color-summary__swatch" data-wor-words-color-preview aria-hidden="true" style="background: #0ea5e9;"></i>
                <div class="wor-reader-words-color-summary__copy">
                  <strong>لون المصطلح البديل</strong>
                  <span data-wor-words-color-hex>#0EA5E9</span>
                </div>
              </div>
              <button type="button" class="wor-reader-words-color-reset" data-wor-words-color-reset>افتراضي</button>
            </div>
            <div class="wor-reader-words-color-grid" data-wor-words-color-grid></div>
            <div class="wor-reader-words-color-picker" data-wor-words-color-picker>
              <div class="wor-reader-words-color-canvas-wrap">
                <div class="wor-reader-words-color-canvas" data-wor-words-color-canvas aria-label="لوحة تخصيص لون المصطلح" tabindex="0" role="application" style="background-image: linear-gradient(to top, rgb(0, 0, 0), transparent), linear-gradient(to right, rgb(255, 255, 255), rgb(0, 174, 255)); background-color: rgb(0, 174, 255);">
                  <span class="wor-reader-words-color-canvas__handle" data-wor-words-color-handle aria-hidden="true"></span>
                </div>
                <div class="wor-reader-words-color-side">
                  <label class="wor-reader-words-color-hue">
                    <span>درجة اللون</span>
                    <input type="range" min="0" max="360" step="1" value="198" data-wor-words-color-hue aria-label="درجة اللون">
                  </label>
                  <div class="wor-reader-words-color-preview-card">
                    <i data-wor-words-color-preview-large aria-hidden="true" style="background: #0ea5e9;"></i>
                    <div>
                      <strong>معاينة</strong>
                      <span>سيطبق هذا اللون على المصطلح المستبدل داخل الفصل.</span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="wor-reader-words-color-footer">
                <label class="wor-reader-words-color-hex-field">
                  <span>HEX</span>
                  <input type="text" data-wor-words-color-hex-input inputmode="text" dir="ltr" spellcheck="false" maxlength="7" placeholder="#0EA5E9">
                </label>
              </div>
            </div>
          </div>
        </div>
        <div class="wor-reader-words-form__actions">
          <button type="submit" class="wor-reader-words-btn wor-reader-words-btn--primary" data-wor-words-submit>إضافة</button>
          <button type="button" class="wor-reader-words-btn" data-wor-words-cancel hidden>إلغاء التعديل</button>
        </div>
      </form>
    </div>
    <aside class="wor-reader-words-library" aria-label="المصطلحات المحفوظة">
      <div class="wor-reader-words-library__head">
        <strong>المصطلحات المحفوظة</strong>
        <span data-wor-words-count>0</span>
      </div>
      <div class="wor-reader-words-list" data-wor-words-list></div>
      <button type="button" class="wor-reader-words-btn wor-reader-words-btn--danger" data-wor-words-clear hidden>مسح الكل</button>
    </aside>
  </div>
</div>

<!-- PORT EDIT: report modal removed (no report backend). -->

<!-- Zeus chapter translation: pill + status/offer cards. The layer itself is
     pointer-events:none (never blocks scroll); only the pill/cards opt in.
     Everything is driven through the tr* bridge protocol — this static markup
     is part of the mount-time HTML and is NEVER rebuilt. -->
<div class="wor-tr-layer" id="worTrLayer">
  <button class="wor-tr-pill" id="worTrPill" type="button" hidden>ترجمة إلى العربية</button>
  <div class="wor-tr-card" id="worTrStatus" role="status" aria-live="polite" hidden>
    <div class="wor-tr-card__body">
      <strong id="worTrStatusText"></strong>
      <span id="worTrStatusMeta"></span>
      <small id="worTrStatusErr" hidden></small>
    </div>
    <div class="wor-tr-card__actions" id="worTrStatusActions"></div>
    <button class="wor-tr-icon" type="button" data-wor-tr-settings aria-label="إعدادات الترجمة" title="إعدادات الترجمة">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
    </button>
    <button class="wor-tr-icon" type="button" data-wor-tr-dismiss aria-label="إخفاء" title="إخفاء">×</button>
  </div>
  <div class="wor-tr-card wor-tr-card--offer" id="worTrOffer" hidden>
    <div class="wor-tr-card__body">
      <strong>ترجمة هذا الفصل؟</strong>
    </div>
    <button class="wor-tr-btn" type="button" data-wor-tr-offer-start>ترجمة</button>
    <button class="wor-tr-icon" type="button" data-wor-tr-offer-dismiss aria-label="إخفاء" title="إخفاء">×</button>
  </div>
</div>

<!-- toast -->
<div class="wor-mini-toast" id="worMiniToast"><span></span></div>

<script>${script}<\/script>
</body>
</html>`;
}

export default buildWorShell;
