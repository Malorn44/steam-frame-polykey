import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { suggestLexicon, suggests } from '../../src/core/options.js';

const english: KeyboardDef = { id: 'en/english', name: 'QWERTY', layout: 'en/qwerty', composer: 'direct', lexicon: 'en/words' };
const japanese: KeyboardDef = {
  id: 'ja/romaji', name: 'ローマ字', layout: 'ja/qwerty-romaji', composer: 'romaji', lexicon: 'en/words',
  modes: [{ id: 'kana' }, { id: 'latin', letters: 'ABC', latin: true }],
};
const korean: KeyboardDef = {
  id: 'ko/korean', name: '두벌식', layout: 'ko/dubeolsik', composer: 'hangul-2set', lexicon: 'en/words',
  modes: [{ id: 'hangul', lexicon: 'ko/words' }, { id: 'latin', letters: 'ABC', latin: true }],
};

describe('the word list a mode suggests from', () => {
  it('is the mode\'s own, else the keyboard\'s, except in a mode that composes', () => {
    expect([suggestLexicon(english, false), suggestLexicon(english, true)]).toEqual(['en/words', 'en/words']);
    expect([suggestLexicon(japanese, false), suggestLexicon(japanese, true)]).toEqual([undefined, 'en/words']); // かな: none
    expect([suggestLexicon(korean, false), suggestLexicon(korean, true)]).toEqual(['ko/words', 'en/words']);
    const own: KeyboardDef = { ...korean, modes: [{ id: 'hangul' }, { id: 'latin', latin: true, lexicon: 'en/other' }] };
    expect([suggestLexicon(own, false), suggestLexicon(own, true)]).toEqual([undefined, 'en/other']);
    const direct: KeyboardDef = { ...english, modes: [{ id: 'one' }, { id: 'latin', latin: true }] };
    expect(suggestLexicon(direct, false)).toBe('en/words'); // no composer: every mode types words
    expect(suggestLexicon(undefined, false)).toBeUndefined();
  });

  it('a keyboard suggests when it or any of its modes has a word list', () => {
    expect([suggests(english), suggests(japanese), suggests(korean)]).toEqual([true, true, true]);
    const bare: KeyboardDef = { id: 'ko/bare', name: 'bare', layout: 'ko/dubeolsik', composer: 'hangul-2set', modes: korean.modes! };
    expect(suggests(bare)).toBe(true);
    expect(suggests({ ...bare, modes: [{ id: 'hangul' }] })).toBe(false);
    expect(suggests(undefined)).toBe(false);
  });
});
