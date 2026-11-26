// The one line both senders share: text and named keys (output.ts, HandleVirtualKeyDown) and chords
// (keys.ts, ControllerKeyboardSetKeyState). Sends run one after another whichever sender they come
// from, and none goes before the last keymap swap has settled for its kind (core/output/plan.ts,
// KEYMAP_SETTLE): a chord or a ⌫ sent straight after typed kana or Hangul brings gamescope's default
// keymap back before the target has read the text's keys, and they come out as number-row digits.

import type { Settle } from '../../core/output/plan.js';

export interface Pacer {
  /** Run a send after every send queued before it, from either sender (never from inside a send: it waits for itself). */
  readonly run: <T>(send: () => Promise<T>) => Promise<T>;
  /** Before a call of this kind: wait `gapMs`, or what is left of the last keymap swap's settle time for it when that is longer. */
  readonly ready: (gapMs: number, kind: keyof Settle) => Promise<void>;
  /** A call swapped the keymap: what is sent next, from either sender, waits as long as `settle` says for its kind. */
  readonly swapped: (settle: Settle) => void;
}

interface PacerDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createPacer = ({ sleep = defaultSleep, now = Date.now }: PacerDeps = {}): Pacer => {
  let queue: Promise<unknown> = Promise.resolve();
  let settledAt: Settle = { text: 0, key: 0, chord: 0 };
  return {
    run: (send) => {
      const result = queue.then(() => send());
      queue = result.catch(() => undefined);
      return result;
    },
    ready: (gapMs, kind) => {
      const ms = Math.max(gapMs, settledAt[kind] - now());
      return ms > 0 ? sleep(ms) : Promise.resolve();
    },
    swapped: (settle) => {
      const at = now();
      settledAt = { text: at + settle.text, key: at + settle.key, chord: at + settle.chord };
    },
  };
};
