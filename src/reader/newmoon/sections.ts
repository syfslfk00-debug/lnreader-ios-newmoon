// lnreader-ios/src/reader/newmoon/sections.ts
// Faithful port of the New-moon-2 engine's chapter-section builder
// (src/screens/Reader/wor/sections.ts) — one Galaxy-style <section> per
// chapter, with the single-pass line formatter (brackets / markdown /
// dialogue / custom marks / colored replacement terms).
//
// PORT EDITS vs the source file (everything else is VERBATIM):
//   1. legacyDecrypt/normalizeContent — the old Galaxy encrypted-base64
//      compatibility path — REMOVED. LNReader chapter content is plain,
//      sanitized HTML (see src/screens/reader/utils/sanitizeChapterText.ts).
//   2. LEGACY_FONT_MAP removed with it (no legacy localStorage settings exist
//      on this platform; @wor_reader_settings_v4 stores wor values directly).
//   3. Image support: LNReader's sanitizer KEEPS <img> tags. htmlToWorText.ts
//      emits each image as its own line; buildWorSectionHTML recognizes an
//      image line and embeds it as
//          <p class="wor-image-p"><img …/></p>
//      WITHOUT the escape+format pipeline (documented exception — the only
//      place raw content reaches the DOM, and it comes from sanitized HTML).

// Escape text for safe embedding in HTML text nodes (quotes are intentionally kept).
export const escapeHtmlText = (text: any): string =>
  String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// A content line that is already an <img> tag (emitted by htmlToWorText.ts).
// Anchored + case-insensitive; sanitize-html guarantees well-formed img tags.
const IMAGE_LINE_RE = /^\s*<img\s/i;

export const isImageLine = (line: string): boolean => IMAGE_LINE_RE.test(line);

// Process a single content line: brackets / markdown / dialogue / custom marks.
// SINGLE-PASS: one combined regex runs over the ESCAPED text and every match is
// wrapped exactly once (see the app reader for the full rationale).
// Self-contained factory is compiled into formatterSource.ts for the WebView.
// Both render paths escape and format provider output identically.
export const createLineFormatter = () => {
  const escapeHtmlText = (text: unknown): string =>
    String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  // Quote-mark pairs used by the coloring features (brackets / markdown inner marks)
  const STYLE_MARKS: Record<string, string[] | null> = {
    guillemets: ['«', '»'],
    curly: ['“', '”'],
    straight: ['"', '"'],
    single: ['‘', '’'],
    all: null,
  };

  const escapeRegex = (s: any): string =>
    String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const formatLine = (line: string, S: any): string => {
    const text = escapeHtmlText(line);

    // Dialogue pair pattern (quote marks chosen by the user)
    let dialogueSrc: string;
    if (S.selectedQuoteStyle === 'guillemets') dialogueSrc = '«[^»]*»';
    else if (S.selectedQuoteStyle === 'curly') dialogueSrc = '“[^”]*”';
    else if (S.selectedQuoteStyle === 'straight') dialogueSrc = '"[^"]*"';
    else if (S.selectedQuoteStyle === 'single') dialogueSrc = "['‘][^'’]*['’]";
    else dialogueSrc = '[“"«][^”"»]*[”"»]';

    const alternatives = [
      '\\[[^\\]\\n]*\\]', // brackets [...]
      '\\*\\*[\\s\\S]*?\\*\\*', // markdown bold **...**
      dialogueSrc, // dialogue quote pair
    ];

    // Custom marks are escaped for HTML first (so marks like "<<" work) then for regex
    let customOpen = '',
      customClose = '';
    if (
      S.customOpenMark &&
      S.customOpenMark.trim() &&
      S.customCloseMark &&
      S.customCloseMark.trim()
    ) {
      customOpen = escapeHtmlText(S.customOpenMark.trim());
      customClose = escapeHtmlText(S.customCloseMark.trim());
      alternatives.push(
        escapeRegex(customOpen) + '[\\s\\S]*?' + escapeRegex(customClose),
      );
    }

    // Colored replacement terms ("تلوين البديل") join the SAME single pass
    const colored = Array.isArray(S.colored) ? S.colored : [];
    colored.forEach((c: any) => alternatives.push(c.src));

    let re: RegExp;
    try {
      re = new RegExp(alternatives.join('|'), 'g');
    } catch {
      return text;
    }

    const bracketMarks = STYLE_MARKS[S.selectedBracketStyle] ?? null;
    const markdownMarks = STYLE_MARKS[S.selectedMarkdownStyle] ?? null;

    return text.replace(re, m => {
      // colored replacement term (checked first so it always wins)
      for (let ci = 0; ci < colored.length; ci++) {
        if (m === colored[ci].escaped) {
          return `<span class="wor-rep-colored" style="color:${colored[ci].color}">${m}</span>`;
        }
      }
      // custom marks first (user-chosen delimiters take precedence)
      if (customOpen && m.startsWith(customOpen) && m.endsWith(customClose)) {
        const inner = m.slice(customOpen.length, m.length - customClose.length);
        return `<span class="custom-formatted"><span class="cmark">${customOpen}</span>${inner}<span class="cmark">${customClose}</span></span>`;
      }
      // brackets [ ... ]
      if (m.charAt(0) === '[' && m.charAt(m.length - 1) === ']') {
        const inner = m.slice(1, -1);
        const innerStart = bracketMarks
          ? `<span class="bq-style">${escapeHtmlText(bracketMarks[0])}</span>`
          : '';
        const innerEnd = bracketMarks
          ? `<span class="bq-style">${escapeHtmlText(bracketMarks[1])}</span>`
          : '';
        return `<span class="bracket-formatted"><span class="bmark">[</span>${innerStart}${inner}${innerEnd}<span class="bmark">]</span></span>`;
      }
      // markdown bold ** ... **
      if (m.startsWith('**') && m.endsWith('**') && m.length > 4) {
        const inner = m.slice(2, -2);
        const qStart = markdownMarks
          ? `<span class="mq-style">${escapeHtmlText(markdownMarks[0])}</span>`
          : '';
        const qEnd = markdownMarks
          ? `<span class="mq-style">${escapeHtmlText(markdownMarks[1])}</span>`
          : '';
        return `<span class="cm-markdown-bold"><span class="mmark">**</span>${qStart}${inner}${qEnd}<span class="mmark">**</span></span>`;
      }
      // dialogue quote pair
      const open = m.charAt(0);
      const close = m.charAt(m.length - 1);
      const inner = m.length > 2 ? m.slice(1, -1) : '';
      return `<span class="cm-dialogue-text"><span class="qmark">${open}</span>${inner}<span class="qmark">${close}</span></span>`;
    });
  };

  return formatLine;
};
export const processLineHTML = createLineFormatter();

// Build one chapter <section> in the Galaxy reading-page style.
// The chapter object shape on this platform is
//     { number, title, content, copyrightStyles: null, ... }
// (copyrightStart/copyrightEnd are absent — LNReader has no publisher
// copyright-injection system; buildWorSectionHTML keeps accepting them).
export const buildWorSectionHTML = (sec: any, idx: number, S: any): string => {
  const style = sec.copyrightStyles || {};
  const copyrightCSS = `color:${style.color || '#888'};opacity:${
    style.opacity || 1
  };text-align:${style.alignment || 'center'};font-weight:${
    style.isBold ? '700' : '400'
  };font-size:${style.fontSize || 14}px;line-height:1.6`;
  const lines = String(sec.content || '')
    .split('\n')
    .filter((line: string) => line.trim() !== '');
  const paragraphs = lines
    .map((line: string) =>
      // PORT EXCEPTION (documented above): sanitized <img> lines pass
      // through unescaped; every other line takes the normal pipeline.
      isImageLine(line)
        ? `<p class="wor-image-p">${line.trim()}</p>`
        : `<p data-wor-source="${escapeHtmlText(line).replace(
            /"/g,
            '&quot;',
          )}">${processLineHTML(line, S)}</p>`,
    )
    .join('');
  const sepHTML =
    idx > 0
      ? `<div class="wor-chapter-sep"><span class="sep-orn">◆</span></div>`
      : '';
  const titleHTML = `<div class="wor-chapter-title-block${
    idx > 0 ? ' wor-chapter-title-block--sub' : ''
  }">${escapeHtmlText(sec.title || '')}</div>`;
  const customSep =
    idx === 0 && S.enableSeparator
      ? `<div class="wor-custom-sep">${escapeHtmlText(S.separatorText)}</div>`
      : '';
  const startHTML = sec.copyrightStart
    ? `<div class="wor-app-copyright" style="${copyrightCSS}">${escapeHtmlText(
        sec.copyrightStart,
      )}</div><div class="wor-chapter-divider"></div>`
    : '';
  const endHTML = sec.copyrightEnd
    ? `<div class="wor-chapter-divider"></div><div class="wor-app-copyright" style="${copyrightCSS}">${escapeHtmlText(
        sec.copyrightEnd,
      )}</div>`
    : '';
  return `<section class="wor-chapter-sec" data-ch="${sec.number}">${sepHTML}${titleHTML}${customSep}${startHTML}<div>${paragraphs}</div>${endHTML}</section>`;
};

// ----- Default reader settings (Galaxy reader defaults) — identical to the app -----
export const DEFAULT_SETTINGS = {
  fontSize: 18,
  lineHeight: 2.3,
  wordSpacing: 0,
  brightness: 1.05,
  fontWeight: '400',
  direction: 'rtl',
  fontValue: 'default',
  bgColor: '#000000',
  textColor: '#ffffff',
  accent: '#808080',
  bgPreset: 'black',
  customColors: false,
  // advanced formatting
  enableDialogue: false,
  dialogueColor: '#4ade80',
  dialogueSize: 100,
  hideQuotes: false,
  selectedQuoteStyle: 'all',
  enableMarkdown: false,
  markdownColor: '#ffffff',
  markdownSize: 100,
  hideMarkdownMarks: false,
  selectedMarkdownStyle: 'all',
  enableBracket: false,
  bracketColor: '#3b82f6',
  bracketSize: 110,
  hideBracketMarks: false,
  selectedBracketStyle: 'all',
  enableCustom: false,
  customOpenMark: '',
  customCloseMark: '',
  customColor: '#f97316',
  customSize: 105,
  hideCustomMarks: false,
  // tools
  showProgressBar: true,
  progressBarColor: '#00ffff',
  continuousMode: false,
  autoScroll: false,
  ttsEnabled: false,
  keepAwake: false,
  hideTitle: false,
  tapToToggle: true,
  enableSeparator: true,
  separatorText: '________________________________________',
  dockOpen: true,
};

// Every setting key the engine persists (same list the source WorReader.tsx
// kept — moved here so the RN parent owns a single copy).
export const SETTINGS_KEYS = [
  'fontSize',
  'lineHeight',
  'wordSpacing',
  'brightness',
  'fontWeight',
  'direction',
  'fontValue',
  'bgColor',
  'textColor',
  'accent',
  'bgPreset',
  'customColors',
  'enableDialogue',
  'dialogueColor',
  'dialogueSize',
  'hideQuotes',
  'selectedQuoteStyle',
  'enableMarkdown',
  'markdownColor',
  'markdownSize',
  'hideMarkdownMarks',
  'selectedMarkdownStyle',
  'enableBracket',
  'bracketColor',
  'bracketSize',
  'hideBracketMarks',
  'selectedBracketStyle',
  'enableCustom',
  'customOpenMark',
  'customCloseMark',
  'customColor',
  'customSize',
  'hideCustomMarks',
  'showProgressBar',
  'progressBarColor',
  'continuousMode',
  'autoScroll',
  'keepAwake',
  'hideTitle',
  'tapToToggle',
  'enableSeparator',
  'separatorText',
  'dockOpen',
];

// keys that change the chapter's HTML structure → rebuild while keeping scroll
export const STRUCTURAL_KEYS = [
  'selectedQuoteStyle',
  'selectedMarkdownStyle',
  'selectedBracketStyle',
  'customOpenMark',
  'customCloseMark',
];

// Theme cycle for the topbar toggle
export const THEME_CYCLE = [
  { bgPreset: 'black', bgColor: '#000000', textColor: '#ffffff' },
  { bgPreset: '__light__', bgColor: '#f3efe7', textColor: '#1c1c1c' },
  { bgPreset: 'soft', bgColor: '#16181d', textColor: '#eef1f6' },
  { bgPreset: 'charcoal', bgColor: '#232323', textColor: '#f3f3f3' },
];

export const isLightColor = (hex: string): boolean => {
  const h = String(hex || '#000000').replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map(c => c + c)
          .join('')
      : h;
  const n = parseInt(full || '000000', 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};
