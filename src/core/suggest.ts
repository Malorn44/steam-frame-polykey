// Word suggestions: which word is being typed, how to rank completions, how to replace the word.
// Pure. We can't read the text field, so the word is the letters we sent ourselves; a pick deletes only
// those. Anything that may move the cursor away from them (arrows, chords, Backspace past them) makes
// the text before them unknown: letters typed after it are still suggested for (a pick replaces only
// them), but the word is not learned at the next boundary, as it may be part of a longer one.

import type { Effect } from './keyboard.js';
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

/** Follow the effects of one key press; `ended` is a word that a boundary just finished. */
export const trackWord = (state: WordState, effects: readonly Effect[]): { state: WordState; ended?: string } => {
  let { word, known } = state;
  let ended: string | undefined;
  for (const effect of effects) {
    if (effect.kind === 'text') {
      for (const ch of effect.text) {
        if (WORD_CHAR.test(ch)) {
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

/** The prefix to complete, or null when there is nothing to suggest for. */
export const suggestPrefix = (state: WordState): string | null => state.word || null;

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

/** What replaces the typed word with a suggestion, then a space. */
export const replaceWord = (typed: string, suggestion: string): Effect[] => [
  ...graphemes(typed).map((): Effect => ({ kind: 'key', key: 'Backspace' })),
  { kind: 'text', text: `${matchCase(suggestion, typed)} ` },
];
