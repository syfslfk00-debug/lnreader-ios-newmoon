// lnreader-ios/src/utils/textDirection.ts
//
// Content-direction detection for mixed Arabic/English novel metadata.
// The app UI language and the novel's content language are independent —
// an Arabic reader may follow English novels and vice versa, so every
// free-text field (summary, title, genre names…) must follow the TEXT it
// renders, not the UI locale.
//
// Rule (Unicode B&P47 heuristic, good enough for novel metadata): count
// strong-directional characters; Arabic-script characters win the paragraph
// direction when they meaningfully outnumber Latin ones. Neutrals
// (punctuation, digits) are ignored.

const ARABIC_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_RE = /[A-Za-z\u00C0-\u024F]/g;

const countMatches = (text: string, re: RegExp): number =>
  (text.match(re) || []).length;

/** 'rtl' when the text is Arabic-dominant, otherwise 'ltr'. */
export const detectTextDirection = (
  text: string | null | undefined,
): 'rtl' | 'ltr' => {
  if (!text) {
    return 'ltr';
  }
  const arabic = countMatches(text.replace(/[^\p{L}]/gu, ''), ARABIC_RE);
  const latin = countMatches(text, LATIN_RE);
  if (arabic === 0 && latin === 0) {
    return 'ltr';
  }
  return arabic >= latin ? 'rtl' : 'ltr';
};

/**
 * RN TextStyle fragment pinning a mixed-language text to its detected
 * direction (writingDirection affects the Unicode bidi base direction).
 */
export const directionStyleFor = (
  text: string | null | undefined,
): {
  direction: 'ltr';
  writingDirection: 'rtl' | 'ltr';
  textAlign: 'right' | 'left';
} => {
  const dir = detectTextDirection(text);
  return {
    // Fabric iOS flips explicit left/right alignment inside an RTL layout.
    // Keep this text node's layout physical; writingDirection handles bidi.
    direction: 'ltr',
    writingDirection: dir,
    textAlign: dir === 'rtl' ? 'right' : 'left',
  };
};
