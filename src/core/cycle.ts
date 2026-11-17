// Tap cycles, as on a phone's 12-key: tapping a key again types its next character in place of the one
// its last tap typed (か → き → く, a → b → c); another key ends the cycle. Pure. What typing in place
// means is each keyboard's own (a kana in the reading replaced, a letter in the English word).

import type { FlickKey } from './catalog.js';

/** An open tap cycle: the key tapped (by its tap character), what tapping it goes through, and where it is. */
export interface TapCycle { readonly key: string; readonly chars: readonly string[]; readonly index: number }

/** The cycle one step on (or back), the first again after the last. */
export const stepCycle = (cycle: TapCycle, by: 1 | -1): TapCycle =>
  ({ ...cycle, index: (cycle.index + by + cycle.chars.length) % cycle.chars.length });

/**
 * A tap on a 12-key key: what it types, and the cycle open after it (none for a key with one character).
 * `again`: it went on with the open cycle, so what it types replaces what the last tap typed.
 */
export const tapKey = (open: TapCycle | null, key: FlickKey): { char: string; cycle: TapCycle | null; again: boolean } => {
  if (open?.key === key.flick[0]) {
    const cycle = stepCycle(open, 1);
    return { char: cycle.chars[cycle.index]!, cycle, again: true };
  }
  const chars = key.cycle ?? key.flick.filter(Boolean);
  return { char: key.flick[0], cycle: chars.length > 1 ? { key: key.flick[0], chars, index: 0 } : null, again: false };
};
