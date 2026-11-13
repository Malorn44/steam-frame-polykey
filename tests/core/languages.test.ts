import { describe, expect, it } from 'vitest';
import type { KeyboardDef, LanguageDef } from '../../src/core/catalog.js';
import { dictationLanguage, dictationLanguages } from '../../src/core/dictation.js';
import { idleHint, languageOf, spelled } from '../../src/core/languages.js';
import { modeLetters } from '../../src/core/pages.js';

const ko: LanguageDef = { id: 'ko', name: '한국어', letters: '한글', labels: { confirm: '확인' } };
const pt: LanguageDef = { id: 'pt', name: 'Português', idleHint: 'Escreva', dictation: 'pt' };
const languages = { ko, pt };
const keyboard = (fields: Partial<KeyboardDef> = {}): KeyboardDef => ({ id: 'x/y', name: 'Y', layout: 'x/l', ...fields });

describe('language packs', () => {
  it('a keyboard has its language\'s pack, else its base language\'s, else none', () => {
    expect(languageOf(languages, keyboard({ language: 'ko' }))).toBe(ko);
    expect(languageOf(languages, keyboard({ language: 'pt-BR' }))).toBe(pt);
    expect(languageOf(languages, keyboard({ language: 'en' }))).toBeUndefined();
    expect(languageOf(languages, keyboard())).toBeUndefined();
    expect(languageOf(undefined, keyboard({ language: 'ko' }))).toBeUndefined();
    expect(languageOf(languages, keyboard({ language: 'constructor' }))).toBeUndefined(); // own entries only
  });

  it('the keyboard\'s own idle hint wins over its language\'s', () => {
    expect(idleHint(keyboard(), pt)).toBe('Escreva');
    expect(idleHint(keyboard({ strings: { idleHint: 'Mine' } }), pt)).toBe('Mine');
    expect(idleHint(keyboard(), undefined)).toBeUndefined();
  });

  it('spells label names in the language\'s words; a name it lacks leaves the key as it is', () => {
    expect(spelled({ Enter: 'confirm', ' ': 'convert' }, ko)).toEqual({ Enter: '확인' });
    expect(spelled({ Enter: 'toString' }, ko)).toEqual({});
    expect(spelled({ Enter: 'confirm' }, undefined)).toEqual({});
  });

  it('the first mode\'s letters come from the language unless the mode names them; a Latin mode never takes them', () => {
    const modes = keyboard({ modes: [{ id: 'hangul' }, { id: 'latin', latin: true }] });
    expect(modeLetters(modes, false, ko)).toBe('한글');
    expect(modeLetters(modes, true, ko)).toBeUndefined(); // the back key's own name (ABC)
    expect(modeLetters(keyboard({ modes: [{ id: 'hangul', letters: '가나다' }] }), false, ko)).toBe('가나다');
    expect(modeLetters(keyboard(), false, ko)).toBe('한글'); // no modes: the language's letters
    expect(modeLetters(keyboard(), true, ko)).toBeUndefined();
  });

  it('dictates in the language\'s dictation language, else the keyboard\'s language', () => {
    expect(dictationLanguage(keyboard({ language: 'pt-BR' }), false, { ...pt, dictation: 'gl' })).toBe('gl');
    expect(dictationLanguage(keyboard({ language: 'ko' }), false, ko)).toBe('ko');
    expect(dictationLanguage(keyboard({ language: 'ko' }), true, ko)).toBe('en'); // the Latin mode
    const lookup = (k: KeyboardDef) => languageOf({ ...languages, pt: { ...pt, dictation: 'gl' } }, k);
    expect(dictationLanguages([keyboard({ language: 'ko' }), keyboard({ language: 'pt-BR' })], lookup)).toEqual(['gl', 'ko']);
  });
});
