import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '../../../src/core/output/plan.js';
import { createOutput } from '../../../src/host/steam/output.js';
import { fakeManager } from '../../fake-steam.js';

const run: Delivery = { policy: 'run', gapMs: 0, settleMs: 0 };
const chars: Delivery = { policy: 'chars', gapMs: 40, settleMs: 0 };

describe('createOutput', () => {
  it('calls HandleVirtualKeyDown once per planned call, with shift false', async () => {
    const manager = fakeManager();
    const send = createOutput({ getManager: () => manager, getDelivery: () => run });
    const result = await send([{ text: 'テスト' }, { key: 'Enter' }]);
    expect(manager.calls).toEqual([['テスト', false], ['Enter', false]]);
    expect(result).toMatchObject({ ok: true, calls: 2, planned: 2 });
  });

  it('waits the gap between calls, not before the first', async () => {
    const manager = fakeManager();
    const sleeps: number[] = [];
    const send = createOutput({ getManager: () => manager, getDelivery: () => chars, sleep: async (ms) => { sleeps.push(ms); } });
    await send([{ text: 'テスト' }]);
    expect(manager.calls.map(([k]) => k)).toEqual(['テ', 'ス', 'ト']);
    expect(sleeps).toEqual([40, 40]);
  });

  it('fails cleanly without a manager', async () => {
    const send = createOutput({ getManager: () => null, getDelivery: () => run });
    expect(await send([{ text: 'a' }])).toMatchObject({ ok: false, calls: 0, planned: 1, error: 'no-keyboard-manager' });
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

describe('a keymap swap settles before the next call (minimal mode)', () => {
  const minimal: Delivery = { policy: 'run', gapMs: 0, settleMs: 60 };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** A sender whose calls are recorded with the time they were made. */
  const timed = (delivery: () => Delivery = () => minimal) => {
    const at: [string, number][] = [];
    const start = Date.now();
    const manager = { HandleVirtualKeyDown: (key: string) => { at.push([key, Date.now() - start]); } };
    return { at, send: createOutput({ getManager: () => manager, getDelivery: delivery }) };
  };

  it('the call after a non-ASCII run waits; ASCII calls with nothing to settle do not', async () => {
    const { at, send } = timed();
    const sent = send([{ text: '(|ω・)ﾉ' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sent).toMatchObject({ ok: true, calls: 5 });
    expect(at).toEqual([['(', 0], ['|', 0], ['ω・', 0], [')', 60], ['ﾉ', 60]]);
  });

  it('a second send straight after waits out the first one\'s swap, and its own', async () => {
    const { at, send } = timed();
    void send([{ text: '(ω)' }]);
    void send([{ text: 'ω)' }]);
    void send([{ key: 'Backspace' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toEqual([['(', 0], ['ω', 0], [')', 60], ['ω', 60], [')', 120], ['Backspace', 120]]);
  });

  it('waits only what is left of the settle time: taps a person makes are not slowed', async () => {
    const { at, send } = timed();
    void send([{ text: 'あ' }]);
    await vi.advanceTimersByTimeAsync(45);
    void send([{ text: 'い' }]);
    await vi.advanceTimersByTimeAsync(300);
    void send([{ text: 'う' }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(at).toEqual([['あ', 0], ['い', 60], ['う', 345]]);
  });

  it('ASCII typing is as fast as before', async () => {
    const { at, send } = timed();
    void send([{ text: 'hi :-)' }]);
    void send([{ key: 'Enter' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(at.map(([, t]) => t)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('buffered mode keeps its gap and nothing more', async () => {
    const { at, send } = timed(() => chars);
    void send([{ text: 'あい' }]);
    void send([{ text: 'う' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toEqual([['あ', 0], ['い', 40], ['う', 40]]);
  });

  it('the settle time is read at each send', async () => {
    let settleMs = 60;
    const { at, send } = timed(() => ({ ...minimal, settleMs }));
    void send([{ text: 'あa' }]);
    await vi.advanceTimersByTimeAsync(500);
    settleMs = 150;
    void send([{ text: 'いb' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(at).toEqual([['あ', 0], ['a', 60], ['い', 500], ['b', 650]]);
  });
});
