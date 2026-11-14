// The line sends go out on: one after another, and none before the last keymap swap has settled
// (core/output/plan.ts, KEYMAP_SETTLE_MS).

export interface Pacer {
  /** Run a send after every send queued before it. A send never starts another (it would wait for itself). */
  readonly run: <T>(send: () => Promise<T>) => Promise<T>;
  /** Before a call: wait `gapMs`, or what is left of the last keymap swap's settle time when that is longer. */
  readonly ready: (gapMs: number) => Promise<void>;
  /** A call swapped the keymap: the next call waits `settleMs`. */
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
