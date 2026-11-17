// The English word being typed in a Japanese keyboard's 英数 (ABC) mode: kept in the bar until it is
// committed, like the kana reading (and like frame-jp-keyboard's QWERTY page). Pure.
//
// Everything typed goes into the word (letters, digits, @ and other symbols), as a Japanese phone
// keyboard composes; a space sends the word followed by it. While there is a word: ⌫ and ← → edit it, 確定 (Enter) sends it,
// ↶ drops it, and a picked suggestion is sent in its place with a space. Any other key sends the
// word first, then acts as usual (the caller does that on null). With tapCycle, tapping an ABC key again
// steps its letter on (a → b → c → 2), as the kana keys do; → ends the cycle.

import type { KeyDef } from './catalog.js';
import { tapKey, type TapCycle } from './cycle.js';
import type { Effect } from './keyboard.js';

export interface EnglishWord {
  readonly chars: readonly string[];
  readonly caret: number;
  /** An open tap cycle (tapCycle on): tapping the same ABC key again replaces the letter before the caret. */
  readonly cycle?: (TapCycle & { readonly upper: boolean }) | null;
}
export const NO_ENGLISH: EnglishWord = { chars: [], caret: 0 };

/** What waits in the word: anything but whitespace (a space sends it). */
const WORD_CHAR = /^\S+$/u;
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
export const pressEnglish = (word: EnglishWord, key: KeyDef, typed: string | undefined,
  { tapCycle = false, flicked = false }: { tapCycle?: boolean; flicked?: boolean } = {}):
  { word: EnglishWord; effects: Effect[] } | null => {
  if (typed !== undefined) {
    const tap = tapCycle && key.type === 'flick' && !flicked ? tapKey(word.caret > 0 ? word.cycle ?? null : null, key) : null;
    // The same key tapped again: its next character, in the case the cycle started in.
    if (tap?.again && word.cycle) {
      const { upper } = word.cycle;
      const chars = [...word.chars.slice(0, word.caret - 1), upper ? tap.char.toUpperCase() : tap.char, ...word.chars.slice(word.caret)];
      return { word: { chars, caret: word.caret, cycle: { ...tap.cycle!, upper } }, effects: [] };
    }
    if (WORD_CHAR.test(typed) && word.chars.length < MAX_WORD) {
      const chars = [...word.chars.slice(0, word.caret), typed, ...word.chars.slice(word.caret)];
      const cycle = tap?.cycle ? { ...tap.cycle, upper: typed !== typed.toLowerCase() } : null;
      return { word: { chars, caret: word.caret + 1, cycle }, effects: [] };
    }
    return { word: NO_ENGLISH, effects: commitEnglish(word, typed) };
  }
  if (!word.chars.length) return null;
  if (isKey(key, 'Backspace')) {
    if (word.caret === 0) return { word, effects: [] };
    const chars = [...word.chars.slice(0, word.caret - 1), ...word.chars.slice(word.caret)];
    return { word: { chars, caret: word.caret - 1, cycle: null }, effects: [] };
  }
  if (isKey(key, 'ArrowLeft')) return { word: { ...word, caret: Math.max(0, word.caret - 1), cycle: null }, effects: [] };
  // → first ends an open tap cycle (so the same key can type its letter again), then moves.
  if (isKey(key, 'ArrowRight') && word.cycle) return { word: { ...word, cycle: null }, effects: [] };
  if (isKey(key, 'ArrowRight')) return { word: { ...word, caret: Math.min(word.chars.length, word.caret + 1) }, effects: [] };
  if (isKey(key, 'Enter')) return { word: NO_ENGLISH, effects: commitEnglish(word) };
  if (key.type === 'action' && key.action === 'undo') return { word: NO_ENGLISH, effects: [] };
  return null;
};
