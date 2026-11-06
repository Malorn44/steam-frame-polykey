import { describe, expect, it } from 'vitest';
import type { Delivery } from '../../../src/core/output/plan.js';
import { createOutput } from '../../../src/host/steam/output.js';
import { fakeManager } from '../../fake-steam.js';

const run: Delivery = { policy: 'run', gapMs: 0 };
const chars: Delivery = { policy: 'chars', gapMs: 40 };

describe('createOutput', () => {
  it('calls HandleVirtualKeyDown once per planned call, with shift false', async () => {
    const manager = fakeManager();
    const send = createOutput({ getManager: () => manager, getDelivery: () => run });
    const result = await send([{ text: 'テスト' }, { key: 'Enter' }]);
    expect(manager.calls).toEqual([
      ['テスト', false],
      ['Enter', false],
    ]);
    expect(result).toMatchObject({ ok: true, calls: 2, planned: 2 });
  });

  it('waits the gap between calls, not before the first', async () => {
    const manager = fakeManager();
    const sleeps: number[] = [];
    const send = createOutput({
      getManager: () => manager,
      getDelivery: () => chars,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await send([{ text: 'テスト' }]);
    expect(manager.calls.map(([k]) => k)).toEqual(['テ', 'ス', 'ト']);
    expect(sleeps).toEqual([40, 40]);
  });

  it('fails cleanly without a manager', async () => {
    const send = createOutput({ getManager: () => null, getDelivery: () => run });
    expect(await send([{ text: 'a' }])).toMatchObject({
      ok: false,
      calls: 0,
      planned: 1,
      error: 'no-keyboard-manager',
    });
  });

  it('reports the error kind only, and keeps working after a failure', async () => {
    let fail = true;
    const manager = fakeManager();
    const flaky = {
      HandleVirtualKeyDown: (key: string, shift: boolean) => {
        if (fail) throw new TypeError('text: テスト');
        manager.HandleVirtualKeyDown(key, shift);
      },
    };
    const send = createOutput({ getManager: () => flaky, getDelivery: () => run });
    const failed = await send([{ text: 'x' }]);
    expect(failed).toMatchObject({ ok: false, calls: 0, error: 'TypeError' });
    expect(JSON.stringify(failed)).not.toContain('テスト');
    fail = false;
    expect(await send([{ text: 'y' }])).toMatchObject({ ok: true, calls: 1 });
  });

  it('runs sends one after another, never interleaved', async () => {
    const manager = fakeManager();
    const send = createOutput({
      getManager: () => manager,
      getDelivery: () => chars,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    await Promise.all([send([{ text: 'ab' }]), send([{ text: 'cd' }])]);
    expect(manager.calls.map(([k]) => k).join('')).toBe('abcd');
  });
});
