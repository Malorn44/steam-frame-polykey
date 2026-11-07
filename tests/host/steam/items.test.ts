import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSteamItems, steamItems } from '../../../src/host/steam/items.js';
import { fakeItemStore, fakeSteam } from '../../fake-steam.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('loadSteamItems', () => {
  it('asks Steam\'s store for the items as its own picker does, and says when they are in', () => {
    const store = fakeItemStore(800);
    const { g } = fakeSteam({ itemStore: store });
    expect(loadSteamItems(g)).toBe(true);
    expect(store.UpdateEmoticonList).toHaveBeenCalledTimes(1);
    expect(store.UpdateEmoticonList.mock.contexts[0]).toBe(store); // Steam's loader needs its store as `this`
    expect(steamItems(g)).toEqual([]);
    vi.advanceTimersByTime(800);
    expect(loadSteamItems(g)).toBe(false);
    expect(steamItems(g)).toEqual([
      { kind: 'emoticon', name: 'steamhappy' }, { kind: 'sticker', name: 'Intense Gaming' }, { kind: 'effect', name: 'confetti' },
    ]);
  });

  it('reads m_bInitialized when is_initialized is gone', () => {
    const store = { m_bInitialized: false, UpdateEmoticonList: vi.fn() };
    const { g } = fakeSteam({ itemStore: store });
    expect(loadSteamItems(g)).toBe(true);
    store.m_bInitialized = true;
    expect(loadSteamItems(g)).toBe(false);
  });

  it('leaves Steam alone when its store or loader is missing, or throws', () => {
    expect(loadSteamItems(fakeSteam().g)).toBe(false);
    const arrays = { m_bInitialized: false, m_rgEmoticons: [{ name: 'steamhappy' }] };
    const { g } = fakeSteam({ itemStore: arrays });
    expect(loadSteamItems(g)).toBe(false);
    expect(arrays).toEqual({ m_bInitialized: false, m_rgEmoticons: [{ name: 'steamhappy' }] });
    expect(steamItems(g)).toEqual([{ kind: 'emoticon', name: 'steamhappy' }]);
    expect(loadSteamItems(fakeSteam({ itemStore: { UpdateEmoticonList: () => { throw new Error('moved'); } } }).g)).toBe(false);
    expect(loadSteamItems(fakeSteam({ itemStore: { UpdateEmoticonList: vi.fn() } }).g)).toBe(false); // no flag: nothing to wait for
  });
});
