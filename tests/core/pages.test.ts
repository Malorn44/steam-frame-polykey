import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { latinPage, modeLetters, pageLabel, pageLayout } from '../../src/core/pages.js';

const twelve: KeyboardDef = {
  id: 'ja/12key', name: '12キー', layout: 'ja/flick',
  pages: { latin: { flick: 'ja/flick-abc', qwerty: 'ja/flick-qwerty' }, symbols: ['ja/flick-symbols', 'ja/flick-symbols2'] },
};
const jis: KeyboardDef = { id: 'ja/jis', name: 'かな (JIS)', layout: 'ja/kana-jis' };

describe('pages', () => {
  it('shows the main layout, the 英数 page in 英数 mode (flick or QWERTY by the option), and symbols over both', () => {
    const at = (latin: boolean, symbols: 0 | 1 | 2, qwerty = false) => pageLayout(twelve, { latin, symbols, qwerty });
    expect(at(false, 0)).toBe('ja/flick');
    expect(at(true, 0)).toBe('ja/flick-abc');
    expect(at(true, 0, true)).toBe('ja/flick-qwerty');
    expect(at(false, 1)).toBe('ja/flick-symbols');
    expect(at(true, 2)).toBe('ja/flick-symbols2');
  });

  it('a keyboard without pages always shows its layout; a single latin page needs no option', () => {
    expect(pageLayout(jis, { latin: true, symbols: 1, qwerty: true })).toBe('ja/kana-jis');
    const one: KeyboardDef = { ...jis, pages: { latin: 'en/qwerty' } };
    expect(latinPage(one, true)).toBe('en/qwerty');
    expect(pageLayout(one, { latin: true, symbols: 0, qwerty: false })).toBe('en/qwerty');
  });

  it('the current mode\'s letters: by the pack, the first mode by default, none without modes', () => {
    const modes = { ...twelve, modes: [{ id: 'kana', letters: 'あいう' }, { id: 'latin', letters: 'ABC', latin: true }] };
    expect(modeLetters(modes, false)).toBe('あいう');
    expect(modeLetters(modes, true)).toBe('ABC');
    expect(modeLetters(jis, false)).toBeUndefined();
  });

  it('labels follow the page and mode: back to あいう or ABC, and to 123 from the second symbols page', () => {
    const symbols = { type: 'action', action: 'symbols' } as const;
    const more = { type: 'action', action: 'more-symbols' } as const;
    expect(pageLabel(symbols, { letters: 'あいう', symbols: 0 })).toBeUndefined(); // ?123 (its own name)
    expect(pageLabel(symbols, { letters: 'あいう', symbols: 1 })).toBe('あいう');
    expect(pageLabel(symbols, { letters: 'ABC', symbols: 2 })).toBe('ABC');
    expect(pageLabel(more, { symbols: 1 })).toBeUndefined(); // =\\<
    expect(pageLabel(more, { symbols: 2 })).toBe('123');
    expect(pageLabel({ ...symbols, label: 'back' }, { letters: 'ABC', symbols: 1 })).toBeUndefined(); // its own label wins
    const abc = { type: 'action', action: 'abc' } as const; // the emoji row's back key
    expect(pageLabel(abc, { letters: '한글', symbols: 0 })).toBe('한글'); // whatever the mode is called
    expect(pageLabel(abc, { symbols: 0 })).toBe('ABC'); // a keyboard without modes
  });
});
