import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYMAP_SETTLE, KEYMAP_SETTLE_KEY_MS, KEYMAP_SETTLE_MS, type Delivery } from '../../../src/core/output/plan.js';
import { createKeySender } from '../../../src/host/steam/keys.js';
import { createOutput } from '../../../src/host/steam/output.js';
import { createPacer } from '../../../src/host/steam/pace.js';
import { fakeManager } from '../../fake-steam.js';

const run: Delivery = { policy: 'run', gapMs: 0, settle: null };
const chars: Delivery = { policy: 'chars', gapMs: 40, settle: null };

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
    const send = createOutput({ getManager: () => manager, getDelivery: () => chars, pacer: createPacer({ sleep: async (ms) => { sleeps.push(ms); } }) });
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
      pacer: createPacer({ sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) }),
    });
    await Promise.all([send([{ text: 'ab' }]), send([{ text: 'cd' }])]);
    expect(manager.calls.map(([k]) => k).join('')).toBe('abcd');
  });
});

describe('a keymap swap settles before what needs it (minimal mode)', () => {
  const minimal: Delivery = { policy: 'run', gapMs: 0, settle: KEYMAP_SETTLE };
  const KEY = KEYMAP_SETTLE_KEY_MS;
  const CHORD = KEYMAP_SETTLE_MS;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** The text sender and the key sender on one pacer, as main.ts has them; calls are recorded with their time. */
  const timed = (delivery: () => Delivery = () => minimal) => {
    const at: [string, number][] = [];
    const start = Date.now();
    const mark = (what: string) => { at.push([what, Date.now() - start]); };
    const pacer = createPacer();
    const manager = { HandleVirtualKeyDown: (key: string) => mark(key) };
    const keys = createKeySender({ getSetKeyState: () => (code, down) => mark(`${code}${down ? '↓' : '↑'}`), pacer });
    return { at, keys, send: createOutput({ getManager: () => manager, getDelivery: delivery, pacer }) };
  };
  const ctrlInsert = [[103, true], [110, true], [110, false], [103, false]] as const;

  it('text after a non-ASCII run goes at once, ASCII or not', async () => {
    const { at, send } = timed();
    const sent = send([{ text: '(|ω・)ﾉ' }]);
    void send([{ text: '가나' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sent).toMatchObject({ ok: true, calls: 5 });
    expect(at).toEqual([['(', 0], ['|', 0], ['ω・', 0], [')', 0], ['ﾉ', 0], ['가나', 0]]);
  });

  it('a named key after a non-ASCII call waits; the syllable after the ⌫ goes at once', async () => {
    const { at, send } = timed();
    void send([{ text: '하' }]);
    void send([{ key: 'Backspace' }, { text: '한' }]);
    void send([{ text: 'a' }, { key: 'Enter' }]); // 한's keymap is still settling
    await vi.advanceTimersByTimeAsync(1000);
    void send([{ text: 'b' }, { key: 'Enter' }]); // nothing to settle
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toEqual([['하', 0], ['Backspace', KEY], ['한', KEY], ['a', KEY], ['Enter', 2 * KEY], ['b', 1000], ['Enter', 1000]]);
  });

  it('waits only what is left of the settle time: taps a person makes are not slowed', async () => {
    const { at, send } = timed();
    void send([{ text: 'あ' }]);
    await vi.advanceTimersByTimeAsync(KEY / 2);
    void send([{ key: 'Backspace' }]);
    await vi.advanceTimersByTimeAsync(300);
    void send([{ key: 'Backspace' }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(at).toEqual([['あ', 0], ['Backspace', KEY], ['Backspace', KEY / 2 + 300]]);
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

  it('a chord after a non-ASCII call waits too: before its first press, never with a key held', async () => {
    const { at, keys, send } = timed();
    void send([{ text: 'かな' }]); // nobody waits for it: the chord still goes after
    void keys.send(ctrlInsert, 8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toEqual([['かな', 0], ['103↓', CHORD], ['110↓', CHORD + 8], ['110↑', CHORD + 16], ['103↑', CHORD + 24]]);
  });

  it('a chord after ASCII, or in buffered mode, is not slowed', async () => {
    for (const delivery of [minimal, chars]) {
      const { at, keys, send } = timed(() => delivery);
      void send([{ text: 'a' }]);
      void keys.send(ctrlInsert, 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(at.map(([, t]) => t)).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('text after a chord waits for the chord, in order', async () => {
    const { at, keys, send } = timed();
    void keys.send(ctrlInsert, 8);
    void send([{ text: 'あ' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toEqual([['103↓', 0], ['110↓', 8], ['110↑', 16], ['103↑', 24], ['あ', 24]]);
  });

  it('the settle time is read at each send', async () => {
    let key = KEY;
    const { at, send } = timed(() => ({ ...minimal, settle: { ...KEYMAP_SETTLE, key } }));
    void send([{ text: 'あ' }, { key: 'Backspace' }]);
    await vi.advanceTimersByTimeAsync(500);
    key = 150;
    void send([{ text: 'い' }, { key: 'Backspace' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(at).toEqual([['あ', 0], ['Backspace', KEY], ['い', 500], ['Backspace', 650]]);
  });
});
