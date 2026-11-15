import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { suggestLexicon, suggests } from '../../src/core/options.js';

const qwerty: KeyboardDef = { id: 'en/english', name: 'QWERTY', layout: 'en/qwerty', composer: 'direct', lexicon: 'en/words' };
const japanese: KeyboardDef = {
  id: 'ja/romaji', name: 'ローマ字', layout: 'ja/qwerty-romaji', composer: 'romaji',
  modes: [{ id: 'kana' }, { id: 'latin', letters: 'ABC', latin: true, lexicon: 'en/words' }],
};
const korean: KeyboardDef = {
  id: 'ko/korean', name: '두벌식', layout: 'ko/dubeolsik', composer: 'hangul-2set',
  modes: [{ id: 'hangul', lexicon: 'ko/words' }, { id: 'latin', letters: 'ABC', latin: true, lexicon: 'en/words' }],
};

describe('the word list a mode suggests from', () => {
  it('is the mode\'s own on a keyboard with modes, else the keyboard\'s', () => {
    expect([suggestLexicon(qwerty, false), suggestLexicon(qwerty, true)]).toEqual(['en/words', 'en/words']);
    expect([suggestLexicon(japanese, false), suggestLexicon(japanese, true)]).toEqual([undefined, 'en/words']); // かな: none
    expect([suggestLexicon(korean, false), suggestLexicon(korean, true)]).toEqual(['ko/words', 'en/words']);
    expect(suggestLexicon(undefined, false)).toBeUndefined();
  });

  it('a keyboard suggests when it, or any of its modes, has a word list', () => {
    expect([suggests(qwerty), suggests(japanese), suggests(korean), suggests(undefined)]).toEqual([true, true, true, false]);
    expect(suggests({ ...korean, modes: [{ id: 'hangul' }, { id: 'latin', latin: true }] })).toBe(false);
  });
});
