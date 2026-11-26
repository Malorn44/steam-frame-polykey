// Word suggestions: which word is being typed, how to rank completions, how to replace the word.
// Pure. We can't read the text field, so the word is the letters we sent ourselves; a pick deletes only
// those. Anything that may move the cursor away from them (arrows, chords, Backspace past them) makes
// the text before them unknown: letters typed after it are still suggested for (a pick replaces only
// them), but the word is not learned at the next boundary, as it may be part of a longer one.

import type { Effect } from './keyboard.js';
import { planEffects, planInline } from './output/inline.js';
import { graphemes } from './output/plan.js';

export interface WordState {
  /** Letters typed since the last boundary. */
  readonly word: string;
  /** False when the text before the word is unknown (it may continue a word there): not learned. */
  readonly known: boolean;
}
export const NO_WORD: WordState = { word: '', known: true };
export const UNKNOWN: WordState = { word: '', known: false };

const WORD_CHAR = /^[\p{L}\p{M}'’]$/u;
const BOUNDARY_KEYS = new Set(['Enter', 'Tab']);

/** A character of a word, unless the keyboard's composer says otherwise (its wordChar): a letter, a mark or an apostrophe. */
export const isLetter = (ch: string): boolean => WORD_CHAR.test(ch);

/** The word at the end of `text`: its last run of word characters. */
export const wordEnd = (text: string, isWord = isLetter): string => {
  const chars = Array.from(text);
  let start = chars.length;
  while (start > 0 && isWord(chars[start - 1]!)) start--;
  return chars.slice(start).join('');
};

/** Follow the effects of one key press; `ended` is a word that a boundary (any character not `isWord`) just finished. */
export const trackWord = (state: WordState, effects: readonly Effect[], isWord = isLetter): { state: WordState; ended?: string } => {
  let { word, known } = state;
  let ended: string | undefined;
  for (const effect of effects) {
    if (effect.kind === 'text') {
      for (const ch of effect.text) {
        if (isWord(ch)) {
          word += ch;
        } else {
          if (known && word) ended = word;
          word = '';
          known = true;
        }
      }
    } else if (effect.kind === 'key' && effect.key === 'Backspace') {
      if (word) word = graphemes(word).slice(0, -1).join('');
      else known = false; // deleting into text we did not type
    } else if (effect.kind === 'key' && BOUNDARY_KEYS.has(effect.key)) {
      if (known && word) ended = word;
      word = '';
      known = true;
    } else if (effect.kind === 'key' || effect.kind === 'chord') {
      word = '';
      known = false;
    }
  }
  return ended ? { state: { word, known }, ended } : { state: { word, known } };
};

/**
 * The prefix to complete: the letters sent since the boundary, then what is still composed in the bar
 * (a syllable: 학 sent and 교 composing is 학교), as far back as the word goes (學校에 is 에, by Hangul's
 * wordChar); null when there is nothing to suggest for.
 */
export const suggestPrefix = (state: WordState, composed = '', isWord = isLetter): string | null =>
  wordEnd(state.word + composed, isWord) || null;

/** Words used this session first (by use count), then the list's own order. */
export const rank = (candidates: readonly string[], session: ReadonlyMap<string, number>, count = 3): string[] => {
  const order = new Map(candidates.map((word, i) => [word, i]));
  return [...candidates]
    .sort((a, b) => (session.get(b.toLowerCase()) ?? 0) - (session.get(a.toLowerCase()) ?? 0) || (order.get(a)! - order.get(b)!))
    .slice(0, count);
};

/** A suggestion in the case the word was typed in: ALL CAPS, Capitalised, or the list's own. */
export const matchCase = (suggestion: string, typed: string): string => {
  if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return suggestion.toUpperCase();
  if (typed[0] && typed[0] !== typed[0].toLowerCase()) return suggestion[0]!.toUpperCase() + suggestion.slice(1);
  return suggestion;
};

/** Three slots, the best in the middle: [2nd, 1st, 3rd]. */
export const slotOrder = (ranked: readonly string[]): (string | undefined)[] => [ranked[1], ranked[0], ranked[2]];

/**
 * What turns `typed`, letters just sent, into `text`: what both start with stays, the rest of `typed` is
 * deleted and the rest of `text` typed. A field that completes inline (a browser's address bar, with its
 * completion selected after the caret) spends the first Backspace on the selection, so a completion
 * that only adds letters sends none.
 */
export const replaceText = (typed: string, text: string): Effect[] => planEffects(planInline(typed, text, ''));

/**
 * What replaces the word being typed with a suggestion, then a space: `typed` is what was sent of it, and
 * `waiting` what follows it unsent (in the bar). What goes before the word (a Hanja) stays.
 */
export const replaceWord = (typed: string, suggestion: string, isWord = isLetter, waiting = ''): Effect[] => {
  const whole = typed + waiting;
  const word = wordEnd(whole, isWord);
  return replaceText(typed, `${whole.slice(0, whole.length - word.length)}${matchCase(suggestion, word)} `);
};

const CLOSES_UP = /^[.,!?;:]$/;

/** Punctuation typed right after a pick's space takes the space's place ("word." not "word ."), as on phones. */
export const closeUp = (effects: readonly Effect[]): readonly Effect[] => {
  const only = effects.length === 1 ? effects[0] : undefined;
  return only?.kind === 'text' && CLOSES_UP.test(only.text) ? [{ kind: 'key', key: 'Backspace' }, only] : effects;
};
