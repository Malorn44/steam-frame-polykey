// 12-key kana input: flick directions, tapping a key again (when the tapCycle option is on), ゛゜小 and
// ↶. Pure. Text goes straight out (no composition yet), so changing the last character is Backspace
// plus the new one; it only ever changes a character polykey itself just typed.

import type { FlickKey, KeyDef } from './catalog.js';
import { MODIFIER, chord, keyForChar } from './keycodes.js';
import type { Effect } from './keyboard.js';

/** How far the pointer must travel before a press counts as a flick (fjk: 24 CSS px). */
export const FLICK_PX = 20;
/** Directions in the order of a flick key's list. */
export const DIRECTIONS = ['tap', 'left', 'up', 'right', 'down'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Tap below the threshold; otherwise the nearest axis (90° sectors, so a slanted flick still counts). */
export const flickDirection = (dx: number, dy: number, threshold = FLICK_PX): Direction => {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < threshold) return 'tap';
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (angle >= -45 && angle < 45) return 'right';
  if (angle >= 45 && angle < 135) return 'up';
  if (angle >= -135 && angle < -45) return 'down';
  return 'left';
};

export interface KanaState {
  /** Tapping the same key again moves on through its cycle (tapCycle on); ↶ steps back. */
  readonly cycle: { readonly key: string; readonly chars: readonly string[]; readonly index: number } | null;
  /** The character polykey just typed, which ゛゜小 may change; null once anything else happens. */
  readonly last: string | null;
}
export const NO_KANA: KanaState = { cycle: null, last: null };

/** The ゛゜小 table: each character to its next form ("はばぱ": は → ば → ぱ → は). */
export const modifyTable = (cycles: readonly string[] = []): ReadonlyMap<string, string> =>
  new Map(cycles.flatMap((group) => {
    const chars = Array.from(group);
    return chars.map((ch, i): [string, string] => [ch, chars[(i + 1) % chars.length]!]);
  }));

const cycleOf = (key: FlickKey): string[] => key.cycle ?? key.flick.filter(Boolean);
const replaceLast = (text: string): Effect[] => [{ kind: 'key', key: 'Backspace' }, { kind: 'text', text }];
const z = keyForChar('z');
/** ↶ with nothing to step back: undo in the app. */
const UNDO: Effect = { kind: 'chord', events: chord([MODIFIER.ctrl], z ? z.code : 29) };

/**
 * A press on the 12-key: a flick key (tapped, or flicked to `flicked`), ゛゜小, ↶, or → while a cycle
 * is open (that ends the cycle, so the same key can start a new character, and is not sent).
 * null: not a 12-key press; the caller handles the key as usual and resets the state.
 */
export const pressKana = (
  state: KanaState,
  key: KeyDef,
  flicked: string | undefined,
  options: { tapCycle: boolean },
  modify: ReadonlyMap<string, string>,
): { state: KanaState; effects: Effect[] } | null => {
  if (key.type === 'flick') {
    if (flicked !== undefined) return { state: { cycle: null, last: flicked }, effects: [{ kind: 'text', text: flicked }] };
    const id = key.flick[0];
    if (options.tapCycle && state.cycle?.key === id) return step(state.cycle, 1);
    const chars = cycleOf(key);
    return {
      state: { cycle: options.tapCycle && chars.length > 1 ? { key: id, chars, index: 0 } : null, last: id },
      effects: [{ kind: 'text', text: id }],
    };
  }
  if (key.type === 'action' && key.action === 'modify') {
    const next = state.last === null ? undefined : modify.get(state.last);
    return next ? { state: { cycle: null, last: next }, effects: replaceLast(next) } : { state, effects: [] };
  }
  if (key.type === 'action' && key.action === 'undo') {
    return state.cycle ? step(state.cycle, -1) : { state: NO_KANA, effects: [UNDO] };
  }
  if (key.type === 'key' && key.key === 'ArrowRight' && state.cycle) return { state: { ...state, cycle: null }, effects: [] };
  return null;
};

const step = (cycle: NonNullable<KanaState['cycle']>, by: 1 | -1): { state: KanaState; effects: Effect[] } => {
  const index = (cycle.index + by + cycle.chars.length) % cycle.chars.length;
  const text = cycle.chars[index]!;
  return { state: { cycle: { ...cycle, index }, last: text }, effects: replaceLast(text) };
};
