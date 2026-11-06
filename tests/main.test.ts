// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_CHORDS, MODIFIER } from '../src/core/keycodes.js';
import { SURFACE_ID } from '../src/host/steam/popup.js';
import { BOOT_GLOBAL, CHECK_MS, GLOBAL, PREREQ_RETRY_MS, PREREQ_TIMEOUT_MS, installPolykey, type PolykeyApi } from '../src/main.js';
import { bundledBoot } from './boot.js';
import { MINIMAL, fakeManager, fakePopupWindow, fakeSteam, type FakePopupWindow } from './fake-steam.js';

let logged: string[];
let installed: PolykeyApi[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  installed = [];
  const capture = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
});
afterEach(() => {
  for (const api of installed) api.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const setup = (options: Parameters<typeof fakeSteam>[0] = {}) => {
  const popup = fakePopupWindow();
  const manager = fakeManager(true);
  const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true, ...options });
  steam.g[BOOT_GLOBAL] = bundledBoot();
  const api = installPolykey(steam.g);
  installed.push(api);
  return { ...steam, popup, manager, api };
};

const shadowOf = (popup: FakePopupWindow) => popup.document.getElementById(SURFACE_ID)?.shadowRoot ?? null;
/** A key by its data-k id: the char, key name, modifier or action. */
const key = (popup: FakePopupWindow, id: string) =>
  [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
const tap = async (popup: FakePopupWindow, label: string) => {
  const el = key(popup, label);
  el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(200);
};

describe('installPolykey', () => {
  it('draws the keyboard over the stock keys and hides them', () => {
    const { popup, api } = setup();
    expect(api.state).toBe('running');
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5);
    expect(popup.document.getElementById('polykey-stock-guard')).not.toBeNull();
  });

  it('types text, keys and chords through Steam', async () => {
    const { popup, manager, state } = setup();
    await tap(popup, 'h');
    await tap(popup, 'shift');
    await tap(popup, 'i');
    await tap(popup, 'Backspace');
    expect(manager.calls).toEqual([['h', false], ['I', false], ['Backspace', false]]);
    await tap(popup, 'ctrl');
    await tap(popup, 'z');
    expect(state.keyEvents).toEqual([[MODIFIER.ctrl, true], [29, true], [29, false], [MODIFIER.ctrl, false]]);
  });

  it('Fn turns ` into Esc', async () => {
    const { popup, state } = setup();
    await tap(popup, 'fn');
    await tap(popup, '`');
    expect(state.keyEvents).toEqual([[41, true], [41, false]]);
  });

  it('toolbar copy is a chord; hide closes Steam keyboard', async () => {
    const { popup, manager, state } = setup();
    await tap(popup, 'copy');
    expect(state.keyEvents).toEqual([...CLIPBOARD_CHORDS.copy]);
    await tap(popup, 'hide');
    expect(manager.calls).toEqual([['VKClose', false]]);
  });

  it('with one keyboard in your list there is no 🌐: the layout\'s rows without it', async () => {
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    steam.g[BOOT_GLOBAL] = { ...boot, settings: { ...boot.settings, keyboards: ['en/english'] } };
    installed.push(installPolykey(steam.g));
    await vi.advanceTimersByTimeAsync(200);
    expect(key(popup, 'next-keyboard')).toBeUndefined();
    const bottom = [...shadowOf(popup)!.querySelectorAll('.row')].at(-1)!;
    expect([...bottom.querySelectorAll<HTMLElement>('.key')].map((el) => el.dataset['k']))
      .toEqual(['fn', 'ctrl', 'super', 'alt', ' ', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
  });

  it('🌐 rotates polykey\'s keyboards only; settings hands over to Steam\'s keyboard, with a way back', async () => {
    const { popup, api } = setup();
    await tap(popup, 'next-keyboard');
    expect(key(popup, 'あ')).toBeDefined(); // the 12-key
    for (const next of ['ja/50on', 'ja/romaji', 'ja/jis', 'en/english']) {
      await tap(popup, 'next-keyboard');
      expect(api.debug.status()).toContain(`keyboard=${next}`); // never Steam's
    }
    await tap(popup, 'settings');
    const stockButton = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .opt')].find((o) => o.textContent === 'Steam keyboard')!;
    stockButton.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    stockButton.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(shadowOf(popup)!.querySelector('.kb')).toBeNull();
    expect(popup.document.getElementById('polykey-stock-guard')).toBeNull();
    const back = shadowOf(popup)!.querySelector<HTMLElement>('[aria-label="Back to polykey"]')!;
    expect(back.querySelector('svg')).not.toBeNull(); // the 文A icon, no text
    back.click();
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5);
  });

  it('never logs typed text', async () => {
    const { popup } = setup();
    for (const label of ['s', 'e', 'c', 'r', 't']) await tap(popup, label);
    expect(logged.join('\n')).not.toMatch(/secrt|s\b.*e\b/);
    for (const line of logged) expect(line).not.toContain('secr');
  });
});

describe('suggestions', () => {
  /** A fake sidecar answering `suggest` from a small list. */
  const withSidecar = (g: Record<string, unknown>) => {
    const words = ['hello', 'help', 'held', 'helmet'];
    const asked: string[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      if (req.op === 'suggest') asked.push(req.prefix);
      const found = words.filter((w) => w.startsWith(String(req.prefix).toLowerCase()));
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words: found }), 1);
    };
    return asked;
  };
  const slots = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].map((el) => el.textContent);

  it('suggests completions for the word being typed, best in the middle, in the typed case', async () => {
    const boot = bundledBoot();
    boot.catalog.keyboards['en/english']!.lexicon = 'en/words';
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const asked = withSidecar(steam.g);
    installed.push(installPolykey(steam.g));
    await tap(popup, 'shift');
    await tap(popup, 'h');
    await tap(popup, 'e');
    await tap(popup, 'l');
    expect(asked).toEqual(['H', 'He', 'Hel']);
    expect(slots(popup)).toEqual(['Help', 'Hello', 'Held']);
  });

  it('picking one replaces the typed letters and adds a space; the next word starts clean', async () => {
    const boot = bundledBoot();
    boot.catalog.keyboards['en/english']!.lexicon = 'en/words';
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    withSidecar(steam.g);
    installed.push(installPolykey(steam.g));
    await tap(popup, 'h');
    await tap(popup, 'e');
    const best = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')][1]!;
    best.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    best.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    const calls = manager.calls.map(([k]) => k);
    expect(calls.slice(0, 4)).toEqual(['h', 'e', 'Backspace', 'Backspace']);
    expect(calls.slice(4).join('')).toBe('hello '); // ASCII goes one character per call in minimal mode
    expect(slots(popup)).toEqual(['', '', '']);
  });

  it('no lexicon or no sidecar: no suggestions, typing unaffected', async () => {
    const { popup, manager } = setup();
    await tap(popup, 'h');
    expect(slots(popup)).toEqual(['', '', '']);
    expect(manager.calls).toEqual([['h', false]]);
  });
});

describe('settings', () => {
  const opts = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .opt')];
  const pick = async (popup: FakePopupWindow, text: string, nth = 0) => {
    const el = opts(popup).filter((o) => o.textContent === text)[nth]!;
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
  };

  it('⚙ opens settings; changes apply at once, are saved, and ✕ returns to the keys', async () => {
    const { popup, g } = setup();
    const saved: unknown[] = [];
    const haptics: unknown[] = [];
    Object.assign(popup, { SteamClient: { OpenVR: { TriggerOverlayHapticEffect: (...a: unknown[]) => haptics.push(a) } } });
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      if (req.op === 'settings.save') saved.push(req.settings);
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words: [] }), 1);
    };
    await tap(popup, 'settings');
    expect(shadowOf(popup)!.querySelector('.kb')).toBeNull();
    expect(shadowOf(popup)!.querySelector('.panel')!.textContent).toContain('polykey test');
    const themeControl = () => shadowOf(popup)!.querySelector<HTMLElement>('.panel .pick > .opt')!;
    expect(themeControl().textContent).toBe('Steam');
    await pick(popup, 'Steam'); // the dropdown...
    expect(shadowOf(popup)!.querySelector('.pick.open')).not.toBeNull();
    await pick(popup, 'Night Owl'); // ...and a theme in its list
    expect(saved).toEqual([{ theme: 'themes/night-owl' }]);
    expect(shadowOf(popup)!.querySelector<HTMLElement>('.panel')!.style.getPropertyValue('--surface').trim()).toBe('#011627');
    expect(themeControl().textContent).toBe('Night Owl');
    expect(shadowOf(popup)!.querySelector('.pick.open')).toBeNull();
    const hapticsSwitch = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .row')].find((r) => r.textContent === 'Haptics')!
      .querySelector<HTMLElement>('.switch.on')!;
    hapticsSwitch.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    hapticsSwitch.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true })); // haptics off
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual([{ theme: 'themes/night-owl' }, { haptics: false }]);
    const before = haptics.length;
    const close = shadowOf(popup)!.querySelector<HTMLElement>('.panel .opt.close')!;
    close.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    close.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5); // the keys are back
    await tap(popup, 'q');
    expect(haptics.length).toBe(before); // no tick with haptics off
  });

  it('12-key ABC: suggestions show where the candidates go; picking one replaces the word', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = bundledBoot();
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      const words = req.op === 'suggest' ? ['dog', 'door'].filter((w) => w.startsWith(req.prefix)) : [];
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words }), 1);
    };
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('ja/12key');
    await tap(popup, 'eisu');
    await tap(popup, 'd');
    const cands = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')];
    expect(cands.map((el) => el.textContent)).toEqual(['dog', 'door']);
    cands[1]!.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    cands[1]!.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.calls.map(([k]) => k).join('')).toBe('door '); // the word was only in the bar
    expect(shadowOf(popup)!.querySelectorAll('.cand')).toHaveLength(0);
  });

  it('suggestions off: no suggest requests', async () => {
    const boot = bundledBoot();
    boot.catalog.keyboards['en/english']!.lexicon = 'en/words';
    boot.settings.suggestions = false;
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const asked: string[] = [];
    steam.g['polykeyBridge'] = (payload: string) => asked.push(JSON.parse(payload).op);
    installed.push(installPolykey(steam.g));
    await tap(popup, 'h');
    expect(asked).not.toContain('suggest');
  });
});

describe('swipe typing', () => {
  /** polykey with a fake sidecar (there from the start, as the injector adds the binding first): `swipe`
   * answers with the next words from `replies`; every request is kept. */
  const setupSwipe = (replies: string[][], on: string[] = ['en/english']) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboardOptions = Object.fromEntries(on.map((id) => [id, { swipe: true }])); // off by default
    steam.g[BOOT_GLOBAL] = boot;
    const requests = withSwipe(steam.g, replies);
    const api = installPolykey(steam.g);
    installed.push(api);
    return { popup, manager, requests, api };
  };
  const withSwipe = (g: Record<string, unknown>, replies: string[][]) => {
    const requests: Record<string, unknown>[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      requests.push(req);
      const words = req.op === 'swipe' && !req.prepare ? replies.shift() ?? [] : [];
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words }), 5);
    };
    return requests;
  };
  /** Lay the keys out on a grid of 40×30 px cells (row, column), as jsdom draws nothing. */
  const layOut = (popup: FakePopupWindow) => {
    [...shadowOf(popup)!.querySelectorAll('.row')].forEach((row, r) => [...row.querySelectorAll<HTMLElement>('.key')].forEach((el, c) => {
      el.getBoundingClientRect = () => ({ left: c * 40, right: c * 40 + 40, top: r * 30, bottom: r * 30 + 30, width: 40, height: 30 }) as DOMRect;
    }));
  };
  const touch = (el: Element, type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    el.dispatchEvent(e);
  };
  /** Swipe from the centre of one letter key to another's (the touches all go to the first key, as a laser's do). */
  const swipe = async (popup: FakePopupWindow, from: string, to: string, wait = 200) => {
    const centre = (id: string) => { const r = key(popup, id).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 15 }; };
    const a = centre(from);
    const b = centre(to);
    const el = key(popup, from);
    touch(el, 'touchstart', a.x, a.y);
    for (let i = 1; i <= 10; i++) touch(el, 'touchmove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
    touch(el, 'touchend', b.x, b.y);
    await vi.advanceTimersByTimeAsync(wait);
  };
  const typed = (manager: ReturnType<typeof fakeManager>) => manager.calls.map(([k]) => (k === 'Backspace' ? '⌫' : k)).join('');
  const slots = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].map((el) => el.textContent);

  it('types the best word, a space before the next, and offers the others; a pick replaces the word', async () => {
    const { popup, manager, requests } = setupSwipe([['hello', 'hell', 'help'], ['world', 'would']]);
    layOut(popup);
    await swipe(popup, 'h', 'o');
    const sent = requests.find((r) => r['op'] === 'swipe' && !r['prepare'])!;
    expect(sent['lexicon']).toBe('en/words');
    expect(sent['keyWidth']).toBe(40);
    expect((sent['path'] as number[][])[0]).toEqual([260, 75]); // h: row 2, column 6
    expect(Object.keys(sent['keys'] as object).sort().join('')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(typed(manager)).toBe('hello');
    expect(slots(popup)).toEqual(['hell', 'hello', 'help']); // the word typed in the middle
    await swipe(popup, 'w', 'd');
    expect(typed(manager)).toBe('hello world');
    const would = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].find((el) => el.textContent === 'would')!;
    would.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    would.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(typed(manager)).toBe('hello world⌫⌫⌫⌫⌫would');
    expect(slots(popup)).toEqual(['would', 'world', '']); // still offered: another pick replaces it again
  });

  it('the word list is loaded when the keyboard first shows, once', async () => {
    const { popup, requests } = setupSwipe([]);
    for (let i = 0; i < 10; i++) await tap(popup, 'next-keyboard'); // round the five keyboards twice
    expect(requests.filter((r) => r['prepare'])).toEqual([{ op: 'swipe', lexicon: 'en/words', prepare: true, id: expect.any(Number),
      keys: Object.fromEntries([...'qwertyuiopasdfghjklzxcvbnm'].map((c) => [c, [0, 0]])) }]);
  });

  it('Shift capitalises the word; Backspace right after a swipe takes the whole word back', async () => {
    const { popup, manager } = setupSwipe([['hello'], ['there']]);
    layOut(popup);
    await tap(popup, 'shift');
    await swipe(popup, 'h', 'o');
    expect(typed(manager)).toBe('Hello');
    await swipe(popup, 't', 'e');
    await tap(popup, 'Backspace');
    expect(typed(manager)).toBe('Hello there⌫⌫⌫⌫⌫'); // there, not Hello: Shift was used up
    await tap(popup, 'Backspace');
    expect(typed(manager)).toBe('Hello there⌫⌫⌫⌫⌫⌫'); // then one character at a time
  });

  it('keys pressed while the word is decoding wait for it, and end its alternatives', async () => {
    const { popup, manager } = setupSwipe([['hello', 'help']]);
    layOut(popup);
    await swipe(popup, 'h', 'o', 0);
    await tap(popup, '.');
    expect(typed(manager)).toBe('hello.');
    expect(slots(popup)).toEqual(['', '', '']);
  });

  it('after a tapped word or punctuation a swiped word gets a space; after a space, or in a new field, none', async () => {
    const { popup, manager } = setupSwipe([['one'], ['two'], ['three']]);
    layOut(popup);
    await swipe(popup, 'o', 'e');
    await tap(popup, ',');
    await swipe(popup, 't', 'o');
    await tap(popup, ' ');
    await swipe(popup, 't', 'e');
    expect(typed(manager)).toBe('one, two three');
  });

  it('no word: nothing is typed, and nothing typed is logged', async () => {
    const { popup, manager } = setupSwipe([[], ['secret']]);
    layOut(popup);
    await swipe(popup, 'q', 'p');
    expect(typed(manager)).toBe('');
    await swipe(popup, 's', 't');
    expect(typed(manager)).toBe('secret');
    expect(logged.join('\n')).not.toContain('secret');
  });

  it('without the sidecar, a press that moves off a letter types the letter', async () => {
    const { popup, manager } = setup();
    layOut(popup);
    const el = key(popup, 'h');
    touch(el, 'touchstart', 260, 75);
    touch(el, 'touchmove', 400, 75);
    touch(el, 'touchend', 400, 75);
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.calls).toEqual([['h', false]]);
  });

  it('off by default; switched on in settings it is saved and swipes', async () => {
    const { popup, manager, requests } = setupSwipe([['hello']], []);
    layOut(popup);
    await swipe(popup, 'h', 'o');
    expect(typed(manager)).toBe('h'); // off: the press types its letter
    await tap(popup, 'settings');
    const row = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .row')].find((r) => r.textContent === 'Swipe typing')!;
    const off = row.querySelector<HTMLElement>('.switch:not(.on)')!;
    off.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    off.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(requests.find((r) => r['op'] === 'settings.save')!['settings']).toEqual({ keyboardOptions: { 'en/english': { swipe: true } } });
    const close = shadowOf(popup)!.querySelector<HTMLElement>('.panel .opt.close')!;
    close.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    close.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    layOut(popup);
    await swipe(popup, 'h', 'o');
    expect(typed(manager)).toBe('h hello'); // after a letter, as after a word: a space
  });
});

describe('swipe typing on the Japanese keyboards (英数 only)', () => {
  const swipeRequests = (requests: Record<string, unknown>[]) => requests.filter((r) => r['op'] === 'swipe' && !r['prepare']);
  const pre = (popup: FakePopupWindow) => shadowOf(popup)!.querySelector('.pre')?.textContent ?? '';
  const cands = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].map((el) => el.textContent);
  const pickCand = async (popup: FakePopupWindow, text: string) => {
    const el = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => c.textContent === text)!;
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
  };
  const layOut = (popup: FakePopupWindow) => {
    [...shadowOf(popup)!.querySelectorAll('.row')].forEach((row, r) => [...row.querySelectorAll<HTMLElement>('.key')].forEach((el, c) => {
      el.getBoundingClientRect = () => ({ left: c * 40, right: c * 40 + 40, top: r * 30, bottom: r * 30 + 30, width: 40, height: 30 }) as DOMRect;
    }));
  };
  const touch = (el: Element, type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    el.dispatchEvent(e);
  };
  const swipe = async (popup: FakePopupWindow, from: string, to: string) => {
    layOut(popup);
    const centre = (id: string) => { const r = key(popup, id).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 15 }; };
    const a = centre(from);
    const b = centre(to);
    const el = key(popup, from);
    touch(el, 'touchstart', a.x, a.y);
    for (let i = 1; i <= 10; i++) touch(el, 'touchmove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
    touch(el, 'touchend', b.x, b.y);
    await vi.advanceTimersByTimeAsync(200);
  };
  const setupJa = (keyboard: string, replies: string[][], on = true) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    if (on) boot.settings.keyboardOptions = { [keyboard]: { swipe: true } };
    steam.g[BOOT_GLOBAL] = boot;
    const requests: Record<string, unknown>[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      requests.push(req);
      const words = req.op === 'swipe' && !req.prepare ? replies.shift() ?? [] : [];
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words, segments: [], predictions: [] }), 5);
    };
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use(keyboard);
    return { popup, manager, requests };
  };
  const sent = (manager: ReturnType<typeof fakeManager>) => manager.calls.map(([k]) => k).join('');

  it('romaji: in かな mode a press that moves off a letter is romaji; in 英数 the swiped word waits in the bar', async () => {
    const { popup, manager, requests } = setupJa('ja/romaji', [['hello', 'help', 'hell'], ['world', 'would'], ['there', 'three'], ['oops']]);
    await swipe(popup, 'k', 'a');
    expect(swipeRequests(requests)).toEqual([]);
    expect(pre(popup)).toBe('k'); // the letter, into the reading
    await tap(popup, 'eisu'); // sends the reading, then 英数
    await tap(popup, ' ');
    manager.calls.length = 0;
    await swipe(popup, 'h', 'o');
    expect([pre(popup), cands(popup), sent(manager)]).toEqual(['hello', ['hello', 'help', 'hell'], '']);
    await swipe(popup, 'w', 'd'); // the waiting word goes, with a space
    expect([pre(popup), sent(manager)]).toEqual(['world', 'hello ']);
    await tap(popup, ' ');
    expect(sent(manager)).toBe('hello world ');
    await swipe(popup, 't', 'e');
    await pickCand(popup, 'three'); // a pick sends it in place of the swiped word
    expect([sent(manager), pre(popup)]).toEqual(['hello world three ', '']);
    await swipe(popup, 'o', 's');
    await tap(popup, 'Backspace'); // takes the whole word back out of the bar
    expect([sent(manager), pre(popup), cands(popup)]).toEqual(['hello world three ', '', []]);
  });

  it('a swiped word after Japanese text gets no space; after an English word sent with 確定, one', async () => {
    const { popup, manager } = setupJa('ja/romaji', [['one'], ['two']]);
    await tap(popup, 'eisu');
    await swipe(popup, 'o', 'e');
    await tap(popup, 'Enter'); // 確定: sends it alone
    await swipe(popup, 't', 'o');
    await tap(popup, 'Enter');
    expect(sent(manager)).toBe('one two');
  });

  it('JIS: no swipe in かな mode (the same keys type kana); in 英数 it swipes', async () => {
    const { popup, requests } = setupJa('ja/jis', [['hello']]);
    await swipe(popup, 'h', 'o');
    expect(swipeRequests(requests)).toEqual([]);
    await tap(popup, 'Backspace');
    await tap(popup, 'eisu');
    await swipe(popup, 'h', 'o');
    expect(swipeRequests(requests)).toHaveLength(1);
    expect(pre(popup)).toBe('hello');
  });

  it('12-key: swipes on its QWERTY ABC page, with the candidates on the left', async () => {
    const { popup, manager, requests } = setupJa('ja/12key', [['hello', 'help']]);
    await tap(popup, 'eisu'); // the QWERTY ABC page (英字入力はQWERTY is on)
    await swipe(popup, 'h', 'o');
    expect([pre(popup), cands(popup), swipeRequests(requests).length]).toEqual(['hello', ['hello', 'help'], 1]);
    await tap(popup, 'Enter');
    expect(sent(manager)).toBe('hello');
  });

  it('off by default on the Japanese keyboards', async () => {
    const { popup, requests } = setupJa('ja/romaji', [['hello']], false);
    await tap(popup, 'eisu');
    await swipe(popup, 'h', 'o');
    expect(swipeRequests(requests)).toEqual([]);
    expect(pre(popup)).toBe('h'); // the press typed its letter into the word
  });
});

describe('emoji', () => {
  it('😀 opens the picker over a key row; a tap types the emoji, updates Recent and is saved; ABC returns', async () => {
    const boot = bundledBoot();
    boot.emoji = { groups: [{ id: 'smileys', name: 'Smileys & Emotion', items: ['😀', '😃'] }] };
    boot.emojiState = { recent: [], favorites: [], tone: '' };
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const saved: unknown[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      if (req.op === 'emoji.save') saved.push(req.state);
      // Like the real sidecar outside KDE Desktop Mode: no paste route.
      const reply = req.op === 'desktop.prepare' ? { ok: false, error: 'not-desktop' } : { ok: true };
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    installed.push(installPolykey(steam.g));
    await tap(popup, 'emoji');
    expect(shadowOf(popup)!.querySelector('.emoji')).not.toBeNull();
    const smile = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.strip .cell')].find((c) => c.textContent === '😃')!;
    smile.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    smile.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.calls).toEqual([['😃', false]]);
    expect(saved).toEqual([{ recent: ['😃'], favorites: [], tone: '' }]);
    await vi.advanceTimersByTimeAsync(CHECK_MS * 2); // the periodic check keeps the row a row
    const row = shadowOf(popup)!.querySelector<HTMLElement>('.kb')!;
    expect(row.style.height).toBe('44px');
    await tap(popup, 'Backspace'); // the bottom row works like keys
    expect(manager.calls.at(-1)).toEqual(['Backspace', false]);
    expect(key(popup, 'abc').querySelector('.lbl')!.textContent).toBe('ABC'); // English: back to the letters
    await tap(popup, 'abc');
    expect(shadowOf(popup)!.querySelector('.emoji')).toBeNull();
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5);
  });
});

describe('Japanese 12-key', () => {
  /** A fake sidecar: settings saves are kept; convert and predict answer from a tiny dictionary. */
  const withConverter = (g: Record<string, unknown>) => {
    const saved: unknown[] = [];
    const asked: string[] = [];
    const learned: unknown[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      asked.push(req.op);
      let reply: Record<string, unknown> = { ok: true };
      if (req.op === 'settings.save') saved.push(req.settings);
      if (req.op === 'learn') learned.push({ reading: req.reading, lengths: req.lengths, choices: req.choices, texts: req.texts });
      if (req.op === 'desktop.prepare') reply = { ok: false, error: 'not-desktop' };
      if (req.op === 'predict') reply = { ok: true, predictions: [] };
      if (req.op === 'convert') {
        const cut = req.lengths?.[0] === 2 && req.resize?.[1] === 1 ? 3 : 2;
        const r: string = req.reading;
        reply = { ok: true, segments: r === 'かんじ'
          ? [{ reading: r.slice(0, cut), candidates: cut === 2 ? ['漢', '感'] : ['漢字'] }, ...(cut < 3 ? [{ reading: r.slice(cut), candidates: ['字', 'じ'] }] : [])]
          : [{ reading: r, candidates: [r] }] };
      }
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    return { saved, asked, learned };
  };
  const bar = (popup: FakePopupWindow) => ({
    pre: shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null, // empty: no reading (the hint shows)
    placeholder: shadowOf(popup)!.querySelector('.comp.on .placeholder')?.textContent ?? null,
    cands: [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.comp.on .cand')].map((c) => c.textContent),
  });
  const pickCand = async (popup: FakePopupWindow, text: string) => {
    const el = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => c.textContent === text)!;
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
  };

  it('kana wait in the buffer, shown in the bar; 確定 sends them; nothing reaches the app before', async () => {
    const { popup, manager, g } = setup();
    withConverter(g);
    await tap(popup, 'next-keyboard');
    await tap(popup, 'た');
    await tap(popup, 'た');
    expect(manager.calls).toEqual([]);
    expect(bar(popup).pre).toBe('たた');
    expect(key(popup, ' ').textContent).toBe('変換');
    await tap(popup, 'Backspace'); // deletes in the buffer, not in the app
    expect(bar(popup).pre).toBe('た');
    await tap(popup, 'Enter'); // 確定
    expect(manager.calls).toEqual([['た', false]]);
    expect(bar(popup).pre).toBeNull();
    expect(bar(popup).placeholder).toBe('入力すると、ここに変換候補が出ます'); // on top, too
    await tap(popup, 'Enter'); // nothing in the buffer: a real Enter
    expect(manager.calls.at(-1)).toEqual(['Enter', false]);
  });

  it('変換 converts into segments; picking a candidate per segment sends the result; ← → resize', async () => {
    const { popup, manager, g } = setup();
    const { learned } = withConverter(g);
    await tap(popup, 'next-keyboard');
    /** Press a flick key and move the given way before releasing (the view's own touch flow). */
    const flickTo = async (id: string, dir: 'tap' | 'left' | 'up' | 'right' | 'down') => {
      const offsets: Record<typeof dir, [number, number]> = { tap: [0, 0], left: [-40, 0], up: [0, -40], right: [40, 0], down: [0, 40] };
      const [dx, dy] = offsets[dir];
      const el = key(popup, id);
      const ev = (type: string, x: number, y: number) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
        el.dispatchEvent(e);
      };
      ev('touchstart', 100, 100);
      ev('touchmove', 100 + dx, 100 + dy);
      ev('touchend', 100 + dx, 100 + dy);
      await vi.advanceTimersByTimeAsync(50);
    };
    await flickTo('か', 'tap');
    await flickTo('わ', 'up'); // ん
    await flickTo('さ', 'left'); // し
    await tap(popup, 'modify'); // し → じ
    expect(bar(popup).pre).toBe('かんじ');
    expect(bar(popup).cands).toContain('カンジ'); // live: katakana as well
    await tap(popup, ' '); // 変換
    expect(bar(popup).cands).toEqual(['漢', '感']);
    expect(key(popup, ' ').textContent).toBe('次変換');
    await tap(popup, 'ArrowRight'); // lengthen the first segment: かん → かんじ
    expect(bar(popup).cands).toEqual(['漢字']);
    await tap(popup, 'ArrowLeft'); // and back
    expect(bar(popup).cands).toEqual(['漢', '感']);
    await pickCand(popup, '漢');
    expect(manager.calls).toEqual([]); // one segment left
    await pickCand(popup, '字');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('漢字'); // sent once the last segment is picked
    expect(learned).toEqual([{ reading: 'かんじ', lengths: [2, 1], choices: [0, 0], texts: ['漢', '字'] }]);
    expect(bar(popup).pre).toBeNull();
  });

  it('with フリックのみ switched off in settings, tapping again cycles in the buffer, and the choice is saved', async () => {
    const { popup, manager, g } = setup();
    const { saved } = withConverter(g);
    await tap(popup, 'next-keyboard');
    await tap(popup, 'settings');
    const row = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .row')].find((r) => r.textContent === 'フリックのみ')!;
    const opt = row.querySelector<HTMLElement>('.switch.on')!; // on by default (tapCycle off)
    opt.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    opt.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual([{ keyboardOptions: { 'ja/12key': { tapCycle: true } } }]);
    const close = shadowOf(popup)!.querySelector<HTMLElement>('.panel .opt.close')!;
    close.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    close.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await tap(popup, 'は');
    await tap(popup, 'は');
    await tap(popup, 'modify');
    await tap(popup, 'ArrowRight'); // ends the cycle (not sent)
    await tap(popup, 'は');
    expect(bar(popup).pre).toBe('びは');
    expect(manager.calls).toEqual([]);
    await tap(popup, 'emoji'); // any other key sends the buffer first
    expect(manager.calls.map((c) => c[0]).join('')).toBe('びは');
  });
});

describe('emoji row on a Japanese keyboard', () => {
  it('its back key reads あいう from kana mode and ABC from 英数 mode', async () => {
    const boot = bundledBoot();
    boot.emoji = { groups: [{ id: 'smileys', name: 'Smileys & Emotion', items: ['😀'] }] };
    boot.emojiState = { recent: [], favorites: [], tone: '' };
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('ja/12key');
    await tap(popup, 'emoji');
    expect(key(popup, 'abc').querySelector('.lbl')!.textContent).toBe('あいう');
    await tap(popup, 'abc');
    await tap(popup, 'eisu');
    await tap(popup, 'emoji');
    expect(key(popup, 'abc').querySelector('.lbl')!.textContent).toBe('ABC');
  });
});

describe('12-key ABC', () => {
  it('ABC keys QWERTY (the default): letters with digits on the top row; ?123 and back return to it', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/12key');
    await tap(popup, 'eisu');
    expect(key(popup, 'q').querySelector('.lg.tr')!.textContent).toBe('1');
    await tap(popup, 'q');
    await tap(popup, 'shift');
    await tap(popup, 'w');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('qW');
    await tap(popup, 'symbols');
    await tap(popup, 'symbols'); // あいう: back to the QWERTY letters
    expect(key(popup, 'q')).toBeDefined();
    await tap(popup, '.');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('qW.'); // a symbol waits in the word too
    expect(manager.calls).toEqual([]);
    await tap(popup, 'Enter'); // 確定
    expect(manager.calls.map((c) => c[0]).join('')).toBe('qW.');
  });

  it('ABC keys Flick: sends the reading and shows the letter keys; a/A capitalises; あ a goes back', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboardOptions = { 'ja/12key': { qwertyLatin: false } };
    steam.g[BOOT_GLOBAL] = boot;
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('ja/12key');
    await tap(popup, 'あ');
    await tap(popup, 'eisu');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('あ');
    expect(key(popup, 'あ')).toBeUndefined();
    await tap(popup, 'a');
    await tap(popup, 'shift');
    await tap(popup, 'd');
    await tap(popup, 'd'); // Shift was one-shot
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('aDd'); // the word waits in the bar
    await tap(popup, ' ');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('あaDd ');
    await tap(popup, 'a');
    await tap(popup, 'undo'); // ↶ drops the word
    await tap(popup, 'kana');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('あaDd ');
    expect(key(popup, 'あ')).toBeDefined();
  });
});

describe('settings → Keyboards', () => {
  it('✕ removes a keyboard, a tapped layout comes back at the end; 🌐 and the save follow', async () => {
    const { popup, g, api } = setup();
    const saved: unknown[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload);
      if (req.op === 'settings.save') saved.push(req.settings);
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true }), 1);
    };
    const press = async (el: HTMLElement) => {
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    };
    const panel = () => shadowOf(popup)!.querySelector('.panel')!;
    await tap(popup, 'settings');
    await press([...panel().querySelectorAll<HTMLElement>('.opt.tab')].find((o) => o.textContent === 'Keyboards')!);
    const mine = () => [...panel().querySelectorAll<HTMLElement>('.mine .item')];
    expect(mine().map((i) => i.querySelector('.nm')!.textContent)).toEqual(
      ['English · QWERTY', '日本語 · 12キー', '日本語 · 五十音', '日本語 · ローマ字', '日本語 · かな (JIS)']);
    await press(mine()[1]!.querySelector<HTMLElement>('.x')!); // remove the 12-key
    expect(saved).toEqual([{ keyboards: ['en/english', 'ja/50on', 'ja/romaji', 'ja/jis'] }]);
    await press([...panel().querySelectorAll<HTMLElement>('.langs .item')].find((i) => i.textContent?.startsWith('日本語'))!);
    const twelve = [...panel().querySelectorAll<HTMLElement>('.lays .item')].find((i) => i.textContent?.includes('12キー'))!;
    expect(twelve.textContent).toContain('+');
    await press(twelve);
    expect(saved.at(-1)).toEqual({ keyboards: ['en/english', 'ja/50on', 'ja/romaji', 'ja/jis', 'ja/12key'] });
    await press(panel().querySelector<HTMLElement>('.opt.close')!);
    await tap(popup, 'next-keyboard');
    expect(api.debug.status()).toContain('keyboard=ja/50on');
  });

  it('holding 🌐 shows your keyboards by name', async () => {
    const { popup } = setup();
    const globe = key(popup, 'next-keyboard');
    globe.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect([...shadowOf(popup)!.querySelectorAll('.alts.menu .key')].map((c) => c.textContent)).toEqual(
      ['EnglishQWERTY', '日本語12キー', '日本語五十音', '日本語ローマ字', '日本語かな (JIS)']); // language above layout
    globe.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  });
});

describe('五十音', () => {
  it('kana keys go into the reading; ゛゜小 voices the one before; the two-row あa switches to letters', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/50on');
    await tap(popup, 'か');
    await tap(popup, 'modify');
    await tap(popup, 'な');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('がな');
    const halves = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.key')].filter((el) => el.dataset['k'] === 'eisu');
    expect(halves.map((el) => el.className.includes('tall'))).toEqual([true, true]);
    halves[1]!.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    halves[1]!.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.calls.map((c) => c[0]).join('')).toBe('がな'); // あa sends the reading first
    expect(key(popup, 'q')).toBeDefined(); // the QWERTY letters
    await tap(popup, 'kana');
    expect(key(popup, 'か')).toBeDefined();
  });
});

describe('12-key ?123', () => {
  it('digits and symbols wait in the reading in kana mode, and in the English word in ABC mode', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/12key');
    await tap(popup, 'symbols');
    await tap(popup, '3');
    await tap(popup, 'symbols'); // back to the kana
    await tap(popup, 'た');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('3た');
    expect(manager.calls).toEqual([]);
    await tap(popup, 'Enter');
    await tap(popup, 'eisu');
    await tap(popup, 'a');
    await tap(popup, 'symbols');
    await tap(popup, '!');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('a!');
    await tap(popup, 'Enter');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('3たa!');
  });

  it('=\\< opens the second page; 123 goes back to the numbers, あいう to the letters', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/12key');
    await tap(popup, 'symbols');
    await tap(popup, 'more-symbols');
    expect(key(popup, '1')).toBeUndefined();
    await tap(popup, '§');
    await tap(popup, 'more-symbols'); // 123
    expect(key(popup, '1')).toBeDefined();
    await tap(popup, 'more-symbols');
    await tap(popup, 'symbols'); // あいう
    expect(key(popup, 'あ')).toBeDefined();
    await tap(popup, 'Enter');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('§');
  });
});

describe('Japanese romaji and JIS kana', () => {
  it('romaji: letters become kana in the buffer; 確定 sends them', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/romaji');
    for (const c of ['k', 'a', 'n', 'j', 'i']) await tap(popup, c);
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('かんじ');
    expect(manager.calls).toEqual([]);
    await tap(popup, 'Enter');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('かんじ');
  });

  it('romaji: 英数 types Latin directly, かな goes back to romaji', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/romaji');
    await tap(popup, 'eisu');
    await tap(popup, 'k');
    await tap(popup, 'a');
    expect(manager.calls).toEqual([]);
    await tap(popup, 'kana'); // sends the English word
    expect(manager.calls.map((c) => c[0]).join('')).toBe('ka');
    await tap(popup, 'k');
    await tap(popup, 'a');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('か');
  });

  it('JIS kana: Shift gives the small kana and does not send the buffer; ゛ joins', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/jis');
    await tap(popup, 't'); // か
    await tap(popup, '@'); // ゛
    await tap(popup, 'shift');
    await tap(popup, '3'); // ぁ
    await tap(popup, '3'); // あ: Shift was one-shot
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('がぁあ');
    expect(manager.calls).toEqual([]);
  });

  it('JIS: Fn+1 is F1 (the reading goes first, Fn is one-shot); Esc is its own key', async () => {
    const { popup, manager, state, api } = setup();
    api.debug.use('ja/jis');
    await tap(popup, 'q'); // た in the reading
    await tap(popup, 'fn');
    expect(key(popup, '1').querySelector('.lbl')!.textContent).toBe('F1'); // shown only while Fn is on
    await tap(popup, '1');
    expect(key(popup, '1').querySelector('.lbl')!.textContent).toBe('');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('た');
    expect(state.keyEvents).toEqual([[58, true], [58, false]]);
    await tap(popup, '1'); // Fn was one-shot: ぬ again
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('ぬ');
    await tap(popup, 'Enter');
    await tap(popup, 'Escape');
    expect(state.keyEvents.slice(2)).toEqual([[41, true], [41, false]]);
  });

  it('JIS: 英数 sends the reading and types the Latin legends; かな goes back to kana', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/jis');
    await tap(popup, 'q'); // た
    await tap(popup, 'eisu');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('た');
    expect(key(popup, 'eisu').classList.contains('on')).toBe(true);
    await tap(popup, 'q');
    await tap(popup, 'shift');
    await tap(popup, '2');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('q"'); // the symbol waits in the word
    await tap(popup, 'kana'); // かな sends the word first
    expect(manager.calls.map((c) => c[0]).join('')).toBe('たq"');
    await tap(popup, 'q');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('た');
    expect(key(popup, 'kana').classList.contains('on')).toBe(true);
  });

  it('JIS: かな while typing shows the reading as カタカナ, then ﾊﾝｶｸ; 確定 sends that form', async () => {
    const { popup, manager, api } = setup();
    api.debug.use('ja/jis');
    await tap(popup, 'h'); // く
    await tap(popup, '@'); // ゛
    await tap(popup, 'l'); // り
    expect(key(popup, 'kana').textContent).toBe('カナ');
    await tap(popup, 'kana');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('グリ');
    expect(key(popup, 'kana').textContent).toBe('ﾊﾝｶｸ');
    await tap(popup, 'kana');
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('ｸﾞﾘ');
    await tap(popup, 'Enter');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('ｸﾞﾘ');
  });

  it('JIS with romaji input: Latin keys go through the romaji table, punctuation turns Japanese', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboardOptions = { 'ja/jis': { romajiInput: true } };
    steam.g[BOOT_GLOBAL] = boot;
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('ja/jis');
    for (const c of ['k', 'a', 'n', 'a', ',', '-']) await tap(popup, c);
    expect(shadowOf(popup)!.querySelector('.pre')!.textContent).toBe('かな、ー');
    expect(key(popup, 'k').querySelector('.lbl')!.classList.contains('s-dual')).toBe(true); // the Latin letter, alone in the middle and lit
    await tap(popup, 'Enter');
    expect(manager.calls.map((c) => c[0]).join('')).toBe('かな、ー');
  });

  it('JIS keys show Latin and kana legends, the mode bright; the two-row Enter hovers as one', async () => {
    const { popup, api } = setup();
    api.debug.use('ja/jis');
    const three = key(popup, '3');
    // Latin left, kana right, Shift above; what the key types now (あ) at the JIS keys' current size.
    const legends = [...three.querySelectorAll('.lg')].map((el) => [el.classList[1], el.textContent, el.classList.contains('s-dual')]);
    expect(legends).toEqual([['tl', '#', false], ['tr', 'ぁ', false], ['bl', '3', false], ['br', 'あ', true]]);
    expect(key(popup, ',').querySelector('.lg.br .dot')).toBeNull();
    expect(key(popup, ',').querySelector('.lg.tr .dot.cell')?.textContent).toBe('、'); // boxed: a child of the legend
    const enters = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.key')].filter((el) => el.dataset['k'] === 'Enter');
    expect(enters.map((el) => el.className.includes('tall'))).toEqual([true, true]);
    enters[1]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(enters.map((el) => el.classList.contains('hover'))).toEqual([true, true]);
  });
});

describe('failing safe', () => {
  it('does nothing without packs from the sidecar', () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup });
    const api = installPolykey(g);
    installed.push(api);
    expect(api.state).toBe('inactive');
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
  });

  it('waits for Steam objects, then gives up and leaves the stock keyboard alone', async () => {
    const { popup, api } = setup({ managers: [] });
    expect(api.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(PREREQ_TIMEOUT_MS + PREREQ_RETRY_MS);
    expect(api.state).toBe('inactive');
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('steps aside while frame-jp-keyboard is active', async () => {
    const { popup, api, g } = setup();
    g['__fjk'] = { state: 'running', enabled: true };
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(api.state).toBe('blocked');
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    expect(popup.document.getElementById('polykey-stock-guard')).toBeNull();
  });

  it('re-injection replaces the previous instance; uninstall removes everything', () => {
    const { popup, g } = setup();
    const second = installPolykey(g);
    installed.push(second);
    expect(g[GLOBAL]).toBe(second);
    expect(popup.document.querySelectorAll(`#${SURFACE_ID}`)).toHaveLength(1);
    second.uninstall();
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    expect(popup.document.getElementById('polykey-stock-guard')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
