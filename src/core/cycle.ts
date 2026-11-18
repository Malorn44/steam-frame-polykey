// Tap cycles, as on a phone's 12-key: tapping a key again types its next character in place of the one
// its last tap typed (か → き → く, a → b → c); another key ends the cycle. Pure. What typing in place
// means is each keyboard's own (a kana in the reading replaced, a letter in the English word).

import type { KeyDef } from './catalog.js';
import { DIRECTIONS } from './kana.js';

/** An open tap cycle: the key tapped (by its tap character), what tapping it goes through, and where it is. */
export interface TapCycle { readonly key: string; readonly chars: readonly string[]; readonly index: number }

/** The cycle one step on (or back), the first again after the last. */
export const stepCycle = (cycle: TapCycle, by: 1 | -1): TapCycle =>
  ({ ...cycle, index: (cycle.index + by + cycle.chars.length) % cycle.chars.length });

/**
 * A tap on a key that cycles: what it types, and the cycle open after it. A key's cycle is its own, else
 * its char then its flicks; a key with one character does not cycle (null).
 * `again`: it went on with the open cycle, so what it types replaces what the last tap typed.
 */
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
