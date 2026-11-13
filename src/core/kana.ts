// 12-key kana helpers: flick directions and the ゛゜小 table. Pure. The reading buffer they feed is
// core/composers/kana.ts.

import { SLOP_PX } from './interaction.js';

/** Directions in the order of a flick key's list. */
export const DIRECTIONS = ['tap', 'left', 'up', 'right', 'down'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Tap below the threshold; otherwise the nearest axis (90° sectors, so a slanted flick still counts). */
export const flickDirection = (dx: number, dy: number, threshold = SLOP_PX.flick): Direction => {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < threshold) return 'tap';
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (angle >= -45 && angle < 45) return 'right';
  if (angle >= 45 && angle < 135) return 'up';
  if (angle >= -135 && angle < -45) return 'down';
  return 'left';
};

/** The ゛゜小 table: each character to its next form ("はばぱ": は → ば → ぱ → は). */
export const modifyTable = (cycles: readonly string[] = []): ReadonlyMap<string, string> =>
  new Map(cycles.flatMap((group) => {
    const chars = Array.from(group);
    return chars.map((ch, i): [string, string] => [ch, chars[(i + 1) % chars.length]!]);
  }));
