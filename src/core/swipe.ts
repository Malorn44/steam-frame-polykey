// Swipe typing, the pure parts: when a press on a letter key becomes a swipe, the path sent to the
// sidecar's swipe engine, the swiped word's case, and whether a space goes before it. The decoding is
// the sidecar's (sidecar/polykey/swipe.py). Paths and words are typed content: never logged.
//
// The thresholds follow TaiKeid's Full Keyboard: a laser trembles, so a press near a key's edge must
// stay a tap. It becomes a swipe only once it is more than a third of a key outside the key it pressed,
// and half a key from where it pressed.

import type { Effect } from './keyboard.js';

export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** How far outside its key, and how far from where it pressed, a press must go to be a swipe (key widths). */
export const SWIPE_OUTSIDE = 1 / 3;
export const SWIPE_TRAVEL = 1 / 2;
/** Points sent per swipe: the path resampled evenly along its length. */
export const SWIPE_POINTS = 64;
/** A path this long (over 20 s of laser at 90 Hz) is stuck, not a word: it ends without typing. */
export const SWIPE_MAX_POINTS = 2000;
/** Words the engine returns: the one typed and the alternatives offered. */
export const SWIPE_WORDS = 5;

/** A key that swipes: a letter. */
export const swipeLetter = (char: string): boolean => /^\p{L}$/u.test(char);

/** True once a press that started at `start` on `key` has moved to `at` far enough to be a swipe. */
export const leftKey = (start: Point, at: Point, key: Rect, keyWidth: number): boolean => {
  const margin = keyWidth * SWIPE_OUTSIDE;
  const outside = at.x < key.left - margin || at.x > key.right + margin || at.y < key.top - margin || at.y > key.bottom + margin;
  return outside && Math.hypot(at.x - start.x, at.y - start.y) > keyWidth * SWIPE_TRAVEL;
};

/** n points evenly spaced along the path (fewer points to send, whatever the laser's rate). */
export const resample = (points: readonly Point[], n = SWIPE_POINTS): Point[] => {
  if (points.length < 2) return [...points];
  const steps = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = steps.reduce((a, b) => a + b, 0);
  if (total === 0) return [points[0]!, points[points.length - 1]!];
  const interval = total / (n - 1);
  const out: Point[] = [points[0]!];
  let walked = 0;
  let goal = interval;
  for (let i = 0; i < steps.length && out.length < n - 1;) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const step = steps[i]!;
    if (step > 0 && walked + step >= goal) {
      const t = (goal - walked) / step;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      goal += interval;
    } else {
      walked += step;
      i += 1;
    }
  }
  while (out.length < n) out.push(points[points.length - 1]!);
  return out;
};

/** A swiped word in the case Shift asks for: once, a capital first letter; locked or Caps, all capitals. */
export const swipeCase = (word: string, shift: 'off' | 'once' | 'locked', caps: boolean): string => {
  if (caps || shift === 'locked') return word.toUpperCase();
  if (shift === 'once') return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
};

/** Where a space before a swiped word belongs: after a word, a number or closing punctuation (phones' rule). */
const SPACE_AFTER = /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}.,!?;:)\]}%”’…]$/u;
/** Among Japanese, only after Latin text: an English word right after kana or 。 goes in without one. */
const SPACE_AFTER_LATIN = /[A-Za-z0-9\u00c0-\u024f.,!?;:)\]}%]$/u;
const RECENT_MAX = 64; // more than a word (40), so deleting one still knows what is before it

/**
 * The last few characters this keyboard sent into the field, following one press's effects; null when
 * unknown (a new field, the cursor moved, Backspace past what we typed).
 */
export const recentAfter = (recent: string | null, effects: readonly Effect[]): string | null => {
  let text = recent;
  for (const effect of effects) {
    if (effect.kind === 'text') text = ((text ?? '') + effect.text).slice(-RECENT_MAX);
    else if (effect.kind === 'key' && effect.key === 'Backspace') text = text ? Array.from(text).slice(0, -1).join('') || null : null;
    else if (effect.kind === 'key' && effect.key === 'Enter') text = '\n';
    else if (effect.kind === 'key' || effect.kind === 'chord') text = null;
  }
  return text;
};

/** A swiped word goes in with a space before it when it follows a word (it never joins the one before). */
export const spaceBefore = (recent: string | null, latinOnly = false): boolean =>
  recent !== null && (latinOnly ? SPACE_AFTER_LATIN : SPACE_AFTER).test(recent);
