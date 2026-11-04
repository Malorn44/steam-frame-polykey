// The English word being typed in a Japanese keyboard's 英数 (ABC) mode: kept in the bar until it is
// committed, like the kana reading (and like frame-jp-keyboard's QWERTY page). Pure.
//
// Letters, digits and the apostrophe go into the word (as a phone keyboard keeps them); any other
// character typed (space, punctuation) sends the word followed by it. While there is a word: ⌫ and ← → edit it, 確定 (Enter) sends it,
// ↶ drops it, and a picked suggestion is sent in its place with a space. Any other key sends the
// word first, then acts as usual (the caller does that on null).

import type { KeyDef } from './catalog.js';
import type { Effect } from './keyboard.js';

export interface EnglishWord {
  readonly chars: readonly string[];
  readonly caret: number;
}
export const NO_ENGLISH: EnglishWord = { chars: [], caret: 0 };

/** Characters that belong to a word (so "don't" and "3rd" stay one word). */
const WORD_CHAR = /^[A-Za-z0-9'’]$/;
const MAX_WORD = 40;

export const englishText = (word: EnglishWord): string => word.chars.join('');

/** Send the word (and what ended it), or nothing for an empty word. */
export const commitEnglish = (word: EnglishWord, suffix = ''): Effect[] =>
  (word.chars.length || suffix ? [{ kind: 'text', text: englishText(word) + suffix }] : []);

const isKey = (key: KeyDef, name: string): boolean => key.type === 'key' && key.key === name;

/**
 * A press in 英数 mode; `typed` is the character a key types (Shift applied), undefined for other
 * keys. Null: not for the word (send it first, then act).
 */
export const pressEnglish = (word: EnglishWord, key: KeyDef, typed: string | undefined):
  { word: EnglishWord; effects: Effect[] } | null => {
  if (typed !== undefined) {
    if (WORD_CHAR.test(typed) && word.chars.length < MAX_WORD) {
      const chars = [...word.chars.slice(0, word.caret), typed, ...word.chars.slice(word.caret)];
      return { word: { chars, caret: word.caret + 1 }, effects: [] };
    }
    return { word: NO_ENGLISH, effects: commitEnglish(word, typed) };
  }
  if (!word.chars.length) return null;
  if (isKey(key, 'Backspace')) {
    if (word.caret === 0) return { word, effects: [] };
    const chars = [...word.chars.slice(0, word.caret - 1), ...word.chars.slice(word.caret)];
    return { word: { chars, caret: word.caret - 1 }, effects: [] };
  }
  if (isKey(key, 'ArrowLeft')) return { word: { ...word, caret: Math.max(0, word.caret - 1) }, effects: [] };
  if (isKey(key, 'ArrowRight')) return { word: { ...word, caret: Math.min(word.chars.length, word.caret + 1) }, effects: [] };
  if (isKey(key, 'Enter')) return { word: NO_ENGLISH, effects: commitEnglish(word) };
  if (key.type === 'action' && key.action === 'undo') return { word: NO_ENGLISH, effects: [] };
  return null;
};
