// The one line both senders share: text and named keys (output.ts, HandleVirtualKeyDown) and chords
// (keys.ts, ControllerKeyboardSetKeyState). Sends run one after another whichever sender they come
// from, and none goes before the last keymap swap has settled (core/output/plan.ts, KEYMAP_SETTLE_MS):
// a chord pressed straight after typed kana or Hangul brings gamescope's default keymap back before
// the target has read the text's keys, and they come out as number-row digits.

export interface Pacer {
  /** Run a send after every send queued before it, from either sender (never from inside a send: it waits for itself). */
  readonly run: <T>(send: () => Promise<T>) => Promise<T>;
  /** Before a call: wait `gapMs`, or what is left of the last keymap swap's settle time when that is longer. */
  readonly ready: (gapMs: number) => Promise<void>;
  /** A call swapped the keymap: the next call, from either sender, waits `settleMs`. */
  readonly swapped: (settleMs: number) => void;
}

interface PacerDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createPacer = ({ sleep = defaultSleep, now = Date.now }: PacerDeps = {}): Pacer => {
  let queue: Promise<unknown> = Promise.resolve();
  let settledAt = 0;
  return {
    run: (send) => {
      const result = queue.then(() => send());
      queue = result.catch(() => undefined);
      return result;
    },
    ready: (gapMs) => {
      const ms = Math.max(gapMs, settledAt - now());
      return ms > 0 ? sleep(ms) : Promise.resolve();
    },
    swapped: (settleMs) => {
      settledAt = now() + settleMs;
    },
  };
};
