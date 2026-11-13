// Content-direction detection: Arabic-dominant text renders RTL, Latin-dominant
// text renders LTR, mixed text follows the majority — never the UI locale.

import { detectTextDirection, directionStyleFor } from '../textDirection';

describe('detectTextDirection', () => {
  it('detects Arabic text as rtl', () => {
    expect(detectTextDirection('في قلب المدينة القديمة بدأت الحكاية')).toBe(
      'rtl',
    );
  });

  it('detects English text as ltr', () => {
    expect(detectTextDirection('The moon rose over the quiet hills.')).toBe(
      'ltr',
    );
  });

  it('follows the majority language in mixed text', () => {
    // Mostly Arabic with a Latin fragment
    expect(
      detectTextDirection(
        'هذه جملة عربية طويلة جداً تحتوي على كلمة English واحدة',
      ),
    ).toBe('rtl');
    // Mostly English with one Arabic word
    expect(
      detectTextDirection(
        'A long English sentence that merely mentions قمر once',
      ),
    ).toBe('ltr');
  });

  it('treats punctuation/digits-only text as ltr (neutral)', () => {
    expect(detectTextDirection('12345 - 6789')).toBe('ltr');
    expect(detectTextDirection('١٢٣٤٥ - ٦٧٨٩')).toBe('ltr');
    expect(detectTextDirection('')).toBe('ltr');
    expect(detectTextDirection(null)).toBe('ltr');
  });

  it('directionStyleFor pairs writingDirection with textAlign', () => {
    expect(directionStyleFor('رواية عربية')).toEqual({
      direction: 'ltr',
      writingDirection: 'rtl',
      textAlign: 'right',
    });
    expect(directionStyleFor('English novel')).toEqual({
      direction: 'ltr',
      writingDirection: 'ltr',
      textAlign: 'left',
    });
  });
});
