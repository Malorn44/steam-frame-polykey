import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { latinPage, pageLayout } from '../../src/core/pages.js';

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
});
