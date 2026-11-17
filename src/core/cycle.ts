// Tap cycles, as on a phone's 12-key: tapping a key again types its next character in place of the last
// (か → き → く, a → b → c, ㄱ → ㅋ → ㄲ), and another key ends it. Pure: the reading, the English word and the
// syllable each replace their own way.

import type { KeyDef } from './catalog.js';
import { DIRECTIONS } from './kana.js';

/** An open tap cycle; key is the tapped key's char. */
export interface TapCycle { readonly key: string; readonly chars: readonly string[]; readonly index: number }

export const stepCycle = (cycle: TapCycle, by: 1 | -1): TapCycle =>
  ({ ...cycle, index: (cycle.index + by + cycle.chars.length) % cycle.chars.length });

/** A tap on a key that cycles (null if it does not). again: it goes on with the open cycle, replacing what the last tap typed. */
export const tapKey = (open: TapCycle | null, key: KeyDef): { char: string; cycle: TapCycle; again: boolean } | null => {
  if (key.type !== 'char') return null;
  const chars = key.cycle ?? DIRECTIONS.flatMap((way) => (way === 'tap' ? key.char : key.flick?.[way] ?? []));
  if (chars.length < 2) return null;
  if (open?.key === key.char) {
    const cycle = stepCycle(open, 1);
    return { char: cycle.chars[cycle.index]!, cycle, again: true };
  }
  return { char: key.char, cycle: { key: key.char, chars, index: 0 }, again: false };
};
