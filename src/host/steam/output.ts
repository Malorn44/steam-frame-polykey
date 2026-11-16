// Text and named keys through VirtualKeyboardManager.HandleVirtualKeyDown, the entry point Steam's own
// keys use; Steam routes it to the target.

import { planCalls, swapsKeymap, type Delivery, type OutputOp } from '../../core/output/plan.js';
import type { VirtualKeyboardManager } from './globals.js';
import { createPacer, type Pacer } from './pace.js';

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
  /** The line its calls go out on, in order and paced (pace.ts); its own unless one is passed. */
  readonly pacer?: Pacer;
}

/** Create the sender. Sends run one after another, so spaced calls never interleave. */
export const createOutput = ({ getManager, getDelivery, pacer = createPacer() }: OutputDeps) => {
  const deliver = async (ops: readonly OutputOp[]): Promise<SendResult> => {
    const delivery = getDelivery();
    const calls = ops.flatMap((op) => planCalls([op], delivery.policy).map((call) => ({ call, kind: 'key' in op ? 'key' as const : 'text' as const })));
    const manager = getManager();
    if (!manager) return { ok: false, calls: 0, planned: calls.length, delivery, error: 'no-keyboard-manager' };
    let made = 0;
    try {
      for (const { call, kind } of calls) {
        await pacer.ready(made > 0 ? delivery.gapMs : 0, kind);
        manager.HandleVirtualKeyDown(call, false);
        made += 1;
        if (delivery.settle && swapsKeymap(call)) pacer.swapped(delivery.settle);
      }
      return { ok: true, calls: made, planned: calls.length, delivery };
    } catch (error) {
      const kind = error instanceof Error ? error.name : typeof error;
      return { ok: false, calls: made, planned: calls.length, delivery, error: kind };
    }
  };

  return (ops: readonly OutputOp[]): Promise<SendResult> => pacer.run(() => deliver(ops));
};
