// Text and named keys through VirtualKeyboardManager.HandleVirtualKeyDown, the entry point Steam's own
// keys use; Steam routes it to the target.

import { planCalls, type Delivery, type OutputOp } from '../../core/output/plan.js';
import type { VirtualKeyboardManager } from './globals.js';

export interface SendResult {
  readonly ok: boolean;
  /** Calls made before stopping. */
  readonly calls: number;
  readonly planned: number;
  readonly delivery: Delivery;
  /** Error kind only (never a message that could carry text). */
  readonly error?: string;
}

interface OutputDeps {
  readonly getManager: () => VirtualKeyboardManager | null;
  readonly getDelivery: () => Delivery;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Create the sender. Sends run one after another, so spaced calls never interleave. */
export const createOutput = ({ getManager, getDelivery, sleep = defaultSleep }: OutputDeps) => {
  let queue: Promise<unknown> = Promise.resolve();

  const deliver = async (ops: readonly OutputOp[]): Promise<SendResult> => {
    const delivery = getDelivery();
    const calls = planCalls(ops, delivery.policy);
    const manager = getManager();
    if (!manager) return { ok: false, calls: 0, planned: calls.length, delivery, error: 'no-keyboard-manager' };
    let made = 0;
    try {
      for (const call of calls) {
        if (made > 0) await sleep(delivery.gapMs);
        manager.HandleVirtualKeyDown(call, false);
        made += 1;
      }
      return { ok: true, calls: made, planned: calls.length, delivery };
    } catch (error) {
      const kind = error instanceof Error ? error.name : typeof error;
      return { ok: false, calls: made, planned: calls.length, delivery, error: kind };
    }
  };

  return (ops: readonly OutputOp[]): Promise<SendResult> => {
    const result = queue.then(() => deliver(ops));
    queue = result.catch(() => undefined);
    return result;
  };
};
