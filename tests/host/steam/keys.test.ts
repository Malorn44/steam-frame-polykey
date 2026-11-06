import { describe, expect, it } from 'vitest';
import { createKeySender, getSetKeyState } from '../../../src/host/steam/keys.js';

const recorder = () => {
  const events: [number, boolean][] = [];
  return { events, setKeyState: (code: number, down: boolean) => events.push([code, down]) };
};

const heldAfter = (events: [number, boolean][]): number[] => {
  const held = new Set<number>();
  for (const [code, down] of events) {
    if (down) held.add(code);
    else held.delete(code);
  }
  return [...held];
};

describe('getSetKeyState', () => {
  it('finds SteamClient.Input.ControllerKeyboardSetKeyState, or null', () => {
    const { setKeyState } = recorder();
    expect(getSetKeyState({ SteamClient: { Input: { ControllerKeyboardSetKeyState: setKeyState } } })).not.toBeNull();
    expect(getSetKeyState({})).toBeNull();
    expect(getSetKeyState({ SteamClient: { Input: {} } })).toBeNull();
  });
});

describe('createKeySender', () => {
  it('sends events in order with the gap between them', async () => {
    const { events, setKeyState } = recorder();
    const sleeps: number[] = [];
    const sender = createKeySender({ getSetKeyState: () => setKeyState, sleep: async (ms) => { sleeps.push(ms); } });
    const result = await sender.send([[103, true], [24, true], [24, false], [103, false]], 8);
    expect(result).toEqual({ ok: true, sent: 4 });
    expect(events).toEqual([[103, true], [24, true], [24, false], [103, false]]);
    expect(sleeps).toEqual([8, 8, 8]);
  });

  it('fails cleanly without the key-state call', async () => {
    const sender = createKeySender({ getSetKeyState: () => null });
    expect(await sender.send([[24, true], [24, false]], 0)).toEqual({ ok: false, sent: 0, error: 'no-key-state-call' });
  });

  it('releases held keys when a call throws mid-chord', async () => {
    const { events, setKeyState } = recorder();
    let calls = 0;
    const flaky = (code: number, down: boolean) => {
      calls += 1;
      if (calls === 3) throw new TypeError('Unknown method');
      setKeyState(code, down);
    };
    const sender = createKeySender({ getSetKeyState: () => flaky, sleep: async () => {} });
    const result = await sender.send([[103, true], [101, true], [24, true], [24, false], [101, false], [103, false]], 0);
    expect(result).toEqual({ ok: false, sent: 2, error: 'TypeError' });
    expect(heldAfter(events)).toEqual([]);
    expect(events.slice(-2)).toEqual([[101, false], [103, false]]); // last pressed first
  });

  it('releaseAll during a send leaves nothing held', async () => {
    const { events, setKeyState } = recorder();
    let release: () => void = () => {};
    const sender = createKeySender({
      getSetKeyState: () => setKeyState,
      sleep: async () => { release(); },
    });
    release = sender.releaseAll;
    await sender.send([[103, true], [24, true], [24, false], [103, false]], 1);
    expect(heldAfter(events)).toEqual([]);
  });
});
