// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionName, KeyDef } from '../src/core/catalog.js';
import { NO_EMOJI_STATE, type EmojiState, type PickerSet } from '../src/core/emoji.js';
import { HOLD_MS, REPEAT_DELAY_MS, REPEAT_MS } from '../src/core/interaction.js';
import { CLIPBOARD_CHORDS, MODIFIER } from '../src/core/keycodes.js';
import { BUFFERED_GAP_MS, KEYMAP_SETTLE, graphemes } from '../src/core/output/plan.js';
import type { VRKeyboardStatus } from '../src/host/steam/diag.js';
import { SURFACE_ID } from '../src/host/steam/popup.js';
import { BOOT_GLOBAL, CHECK_MS, FIELD_CHECK_MS, GLOBAL, PREREQ_RETRY_MS, PREREQ_TIMEOUT_MS, STEAM_ITEMS_WAIT_MS, installPolykey, type PolykeyApi } from '../src/main.js';
import { STEAM_LOADING_NOTE } from '../src/ui/emoji.js';
import { ICONS } from '../src/ui/icons.js';
import { EMOJI, KAOMOJI, bundledBoot, emojiSet, kaomojiSet } from './boot.js';
import { BUFFERED, MINIMAL, STREAMED, fakeItemStore, fakeManager, fakePopupWindow, fakeSteam, type FakePopupWindow } from './fake-steam.js';

/** A request the page sent the fake sidecar, with the fields these tests look at. */
type SentRequest = {
  op: string;
  id: number;
  prefix?: string;
  lexicon?: string;
  keyboard?: string;
  settings?: unknown;
  state?: unknown;
  prepare?: unknown;
  reading?: string;
  lengths?: number[];
  resize?: number[];
  choices?: unknown;
  texts?: unknown;
  text?: string;
};
const request = (payload: string) => JSON.parse(payload) as SentRequest;
/** Key events as "103↓" / "103↑", to set them beside other things in one sequence. */
const keyNames = (events: readonly (readonly [number, boolean])[]) => events.map(([code, down]) => `${code}${down ? '↓' : '↑'}`);

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
  layOut(popup);
  const centre = (id: string) => { const r = key(popup, id).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 15 }; };
  const a = centre(from);
  const b = centre(to);
  const el = key(popup, from);
  touch(el, 'touchstart', a.x, a.y);
  for (let i = 1; i <= 10; i++) touch(el, 'touchmove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
  touch(el, 'touchend', b.x, b.y);
  await vi.advanceTimersByTimeAsync(wait);
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

describe('a held Backspace', () => {
  const touch = (el: Element, type: string) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: 10, clientY: 10 }] });
    el.dispatchEvent(e);
  };
  const backspaces = (manager: ReturnType<typeof fakeManager>) => manager.calls.filter(([k]) => k === 'Backspace').length;

  it('stops at its release, though its icon was drawn again under the press (the release goes to the old one)', async () => {
    const { popup, manager } = setup();
    const icon = key(popup, 'Backspace').querySelector('svg')!;
    touch(icon, 'touchstart');
    await vi.advanceTimersByTimeAsync(REPEAT_DELAY_MS + REPEAT_MS * 2);
    expect([backspaces(manager), icon.isConnected]).toEqual([3, false]);
    touch(icon, 'touchend');
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 20);
    expect(backspaces(manager)).toBe(3);
  });

  it('stops when the keyboard closes, though its release never comes', async () => {
    const { popup, manager, state } = setup();
    await vi.advanceTimersByTimeAsync(CHECK_MS); // seen open
    const held = key(popup, 'Backspace');
    /** Hold on for `ms`, the laser moving (as when the trigger is still down), and count what it sent. */
    const keepHolding = async (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        touch(held, 'touchmove');
        await vi.advanceTimersByTimeAsync(100);
      }
      return backspaces(manager);
    };
    touch(held, 'touchstart');
    expect(await keepHolding(1000)).toBeGreaterThan(5);
    state.status = { ...MINIMAL, bIsOpen: false };
    const closed = await keepHolding(CHECK_MS); // seen closed by now
    expect(await keepHolding(CHECK_MS)).toBe(closed);
  });
});

describe('suggestions', () => {
  /** A fake sidecar answering `suggest` from a small list. */
  const withSidecar = (g: Record<string, unknown>) => {
    const words = ['hello', 'help', 'held', 'helmet'];
    const asked: string[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      if (req.op === 'suggest' && !req.prepare) asked.push(req.prefix ?? '');
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

  it('picking one types the rest of the word and a space, deleting nothing it starts with; the next word starts clean', async () => {
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
    expect(calls).not.toContain('Backspace'); // he is how hello starts: an address bar's completion takes no letter
    expect(calls.join('')).toBe('hello '); // ASCII goes one character per call in minimal mode
    expect(slots(popup)).toEqual(['', '', '']);
    await tap(popup, '.'); // punctuation closes up to the picked word
    expect(manager.calls.map(([k]) => k).slice(-2)).toEqual(['Backspace', '.']);
  });

  it('a move to another text field, or a click in this one, starts a new word: a pick never deletes there', async () => {
    const boot = bundledBoot();
    boot.catalog.keyboards['en/english']!.lexicon = 'en/words';
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const asked = withSidecar(steam.g);
    installed.push(installPolykey(steam.g));
    await tap(popup, 'h');
    await tap(popup, 'e');
    expect(slots(popup)).toEqual(['help', 'hello', 'held']);
    manager.OnActiveElementChanged.Dispatch({}); // Steam's keyboard moved to another field
    await vi.advanceTimersByTimeAsync(10);
    expect(slots(popup)).toEqual(['', '', '']);
    await tap(popup, 'l');
    expect(asked.at(-1)).toBe('l');
    manager.OnActiveElementClicked.Dispatch({}); // the same field clicked: its caret may have moved
    await tap(popup, 'p');
    expect(asked.at(-1)).toBe('p');
    expect(manager.calls.map(([k]) => k)).toEqual(['h', 'e', 'l', 'p']);
  });

  it('watches each Steam window\'s keyboard as windows come and go, and lets go of every one when uninstalled', async () => {
    const { manager, g, api } = setup();
    const windows = (g['SteamUIStore'] as { WindowStore: { SteamUIWindows: unknown[] } }).WindowStore.SteamUIWindows;
    const watching = (m: ReturnType<typeof fakeManager>) => [m.OnActiveElementChanged.m_vecCallbacks.length, m.OnActiveElementClicked.m_vecCallbacks.length];
    expect(watching(manager)).toEqual([1, 1]);
    const later = fakeManager(); // a window opened later (the bar's popup)
    windows.push({ VirtualKeyboardManager: later });
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(watching(later)).toEqual([1, 1]);
    windows.pop();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(watching(later)).toEqual([0, 0]);
    const bare: Record<string, unknown> = { HandleVirtualKeyDown: () => {} }; // a manager without the lists
    windows.push({ VirtualKeyboardManager: bare });
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    api.uninstall();
    expect(watching(manager)).toEqual([0, 0]);
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
      const req = request(payload);
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

  it('a tap keeps every list where it was scrolled, though the page is drawn again; reopened, settings starts at the top', async () => {
    const { popup } = setup();
    const panel = () => shadowOf(popup)!.querySelector<HTMLElement>('.panel')!;
    const list = (col: string) => panel().querySelector<HTMLElement>(`.col.${col} > .list`)!;
    const tab = (name: string) => [...panel().querySelectorAll<HTMLElement>('.opt.tab')].find((o) => o.textContent === name)!;
    const press = async (el: HTMLElement) => {
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    };
    await tap(popup, 'settings');
    const general = list('general');
    general.scrollTop = 40;
    list('options').scrollTop = 25;
    await press([...general.querySelectorAll<HTMLElement>('.row')].find((r) => r.textContent === 'Haptics')!.querySelector<HTMLElement>('.switch')!);
    expect(list('general')).not.toBe(general); // drawn again...
    expect([list('general').scrollTop, list('options').scrollTop]).toEqual([40, 25]); // ...scrolled as it was
    await press(tab('Keyboards'));
    expect(list('langs').scrollTop).toBe(0); // another tab's lists start at the top
    list('langs').scrollTop = 30;
    list('lays').scrollTop = 20;
    list('mine').scrollTop = 15;
    await press([...list('langs').querySelectorAll<HTMLElement>('.item')].find((i) => i.textContent?.startsWith('日本語'))!);
    expect(list('lays').textContent).toContain('12キー');
    expect([list('langs').scrollTop, list('lays').scrollTop, list('mine').scrollTop]).toEqual([30, 0, 15]); // Japanese layouts: from the top
    await press(tab('Settings'));
    expect([list('general').scrollTop, list('options').scrollTop]).toEqual([40, 25]); // a tab comes back as it was left
    await press(panel().querySelector<HTMLElement>('.opt.close')!);
    await tap(popup, 'settings');
    expect([list('general').scrollTop, list('options').scrollTop]).toEqual([0, 0]);
  });

  it('12-key ABC: suggestions show where the candidates go; picking one replaces the word', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = bundledBoot();
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      const words = req.op === 'suggest' ? ['dog', 'door'].filter((w) => w.startsWith(req.prefix ?? '')) : [];
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
    steam.g['polykeyBridge'] = (payload: string) => asked.push(request(payload).op);
    installed.push(installPolykey(steam.g));
    await tap(popup, 'h');
    expect(asked).not.toContain('suggest');
  });
});

describe('swipe typing', () => {
  /** polykey with a fake sidecar (there from the start, as the injector adds the binding first): `swipe`
   * answers with the next words from `replies`; every request is kept. */
  const setupSwipe = (replies: string[][], on: string[] = ['en/english'], decodeMs = 5) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboardOptions = Object.fromEntries(on.map((id) => [id, { swipe: true }])); // off by default
    steam.g[BOOT_GLOBAL] = boot;
    const requests = withSwipe(steam.g, replies, decodeMs);
    const api = installPolykey(steam.g);
    installed.push(api);
    return { popup, manager, requests, api };
  };
  const withSwipe = (g: Record<string, unknown>, replies: string[][], decodeMs = 5) => {
    const requests: Record<string, unknown>[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      requests.push(req);
      const words = req.op === 'swipe' && !req.prepare ? replies.shift() ?? [] : [];
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ok: true, words }), req.op === 'swipe' && !req.prepare ? decodeMs : 5);
    };
    return requests;
  };
  const typed = (manager: ReturnType<typeof fakeManager>) => manager.calls.map(([k]) => (k === 'Backspace' ? '⌫' : k)).join('');
  const slots = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].map((el) => el.textContent);
  const pick = async (popup: FakePopupWindow, word: string) => {
    const slot = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].find((el) => el.textContent === word)!;
    slot.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    slot.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
  };

  it('types the best word, a space before the next, and offers the others; a pick replaces the word', async () => {
    const { popup, manager, requests } = setupSwipe([['hello', 'hell', 'help'], ['world', 'would']]);
    layOut(popup);
    await swipe(popup, 'h', 'o');
    const sent = requests.find((r) => r['op'] === 'swipe' && !r['prepare'])!;
    expect(sent['lexicon']).toBe('en/words');
    expect(sent['keyWidth']).toBe(40);
    expect((sent['path'] as number[][])[0]).toEqual([260, 75]); // h: row 2, column 6
    expect(Object.keys(sent['keys'] as object).sort().join('')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(Object.keys(sent).sort()).toEqual(['id', 'keyWidth', 'keys', 'lexicon', 'limit', 'op', 'path']); // no keyboard, no shifts: spelled in lower case
    expect(typed(manager)).toBe('hello');
    expect(slots(popup)).toEqual(['hell', 'hello', 'help']); // the word typed in the middle
    await swipe(popup, 'w', 'd');
    expect(typed(manager)).toBe('hello world');
    const would = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.sugg')].find((el) => el.textContent === 'would')!;
    would.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    would.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(typed(manager)).toBe('hello world⌫⌫⌫uld '); // wo, which both start with, stays
    expect(slots(popup)).toEqual(['', '', '']); // picked: the alternatives go
  });

  it('a held key repeating while the word decodes repeats nothing that would come after its release', async () => {
    const { popup, manager } = setupSwipe([['hello']], ['en/english'], 1000);
    layOut(popup);
    await swipe(popup, 'h', 'o', 0);
    const held = key(popup, 'Backspace');
    held.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(REPEAT_DELAY_MS + REPEAT_MS * 5); // held while the word decodes
    held.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1000); // the word comes
    expect(typed(manager)).toBe('hello');
  });

  it('a pick after a swipe adds a space and clears the bar; the next swipe adds no second space', async () => {
    const { popup, manager } = setupSwipe([['hello', 'hell', 'help'], ['world']]);
    layOut(popup);
    await swipe(popup, 'h', 'o');
    await pick(popup, 'hello'); // the swiped word itself: kept, with a space
    expect(typed(manager)).toBe('hello ');
    expect(slots(popup)).toEqual(['', '', '']);
    await swipe(popup, 'w', 'd');
    expect(typed(manager)).toBe('hello world');
  });

  it('punctuation typed right after a pick takes the place of its space; after anything else it does not', async () => {
    const { popup, manager } = setupSwipe([['hello', 'help'], ['there', 'three']]);
    layOut(popup);
    await swipe(popup, 'h', 'o');
    await pick(popup, 'help');
    await tap(popup, ',');
    expect(typed(manager)).toBe('hello⌫⌫p ⌫,');
    await tap(popup, ' ');
    await swipe(popup, 't', 'e');
    await pick(popup, 'there');
    await tap(popup, 'a');
    await tap(popup, ' ');
    await tap(popup, '.');
    expect(typed(manager)).toBe('hello⌫⌫p ⌫, there a .');
  });

  it('each time the keyboard shows, the sidecar is asked to prepare its word list (it builds it once)', async () => {
    const { popup, requests } = setupSwipe([]);
    for (let i = 0; i < 10; i++) await tap(popup, 'next-keyboard'); // round the five keyboards twice
    const prepare = { op: 'swipe', lexicon: 'en/words', prepare: true, id: expect.any(Number) as unknown,
      keys: Object.fromEntries([...'qwertyuiopasdfghjklzxcvbnm'].map((c) => [c, [0, 0]])) };
    expect(requests.filter((r) => r['op'] === 'swipe' && r['prepare'])).toEqual([prepare, prepare, prepare]); // English, shown three times
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
  const setupJa = (keyboard: string, replies: string[][], on = true) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    if (on) boot.settings.keyboardOptions = { [keyboard]: { swipe: true } };
    steam.g[BOOT_GLOBAL] = boot;
    const requests: Record<string, unknown>[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
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

  it('かな, which has no word list, prepares none; 英数 prepares English for the same keys', async () => {
    const { popup, requests } = setupJa('ja/romaji', [['hello']]);
    const prepared = () => requests.filter((r) => r['op'] === 'swipe' && r['prepare']).map((r) => r['lexicon']);
    expect(prepared()).toEqual([]);
    await tap(popup, 'eisu');
    expect(prepared()).toEqual(['en/words']);
    await swipe(popup, 'h', 'o');
    expect(swipeRequests(requests)).toHaveLength(1);
  });

  it('off by default on the Japanese keyboards', async () => {
    const { popup, requests } = setupJa('ja/romaji', [['hello']], false);
    await tap(popup, 'eisu');
    await swipe(popup, 'h', 'o');
    expect(swipeRequests(requests)).toEqual([]);
    expect(pre(popup)).toBe('h'); // the press typed its letter into the word
  });
});

describe('swipe typing on the Korean keyboard', () => {
  /**
   * The Korean keyboard with swipe on, in a game (each syllable composed in the field) unless `status`
   * says otherwise, and a fake sidecar: swipe answers with the next of `replies`, suggest with nothing.
   */
  const setupKo = (replies: string[][], status = MINIMAL) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboards = ['ko/korean', 'en/english', 'ja/romaji'];
    boot.settings.keyboardOptions = { 'ko/korean': { swipe: true } };
    steam.g[BOOT_GLOBAL] = boot;
    const requests: (SentRequest & Record<string, unknown>)[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      requests.push(req);
      const reply = req.op === 'swipe' || req.op === 'suggest' ? { ok: true, words: req.op === 'swipe' && !req.prepare ? replies.shift() ?? [] : [] }
        : { ok: false, error: 'unknown-op' };
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 5);
    };
    const api = installPolykey(steam.g);
    installed.push(api);
    const sent = () => manager.calls.map((c) => c[0]);
    const field = () => sent().reduce((text, k) => (k === 'Backspace' ? graphemes(text).slice(0, -1).join('') : text + k), '');
    const cands = () => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.comp.on .cand')].map((el) => el.textContent);
    const pick = async (text: string) => {
      const el = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => c.textContent === text)!;
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(200);
    };
    const typeAll = async (keys: string) => { for (const k of Array.from(keys)) await tap(popup, k); };
    const swipes = () => requests.filter((r) => r.op === 'swipe' && !r.prepare);
    const prepares = () => requests.filter((r) => r.op === 'swipe' && r.prepare);
    return { popup, api, sent, field, cands, pick, typeAll, swipes, prepares };
  };
  const TENSE = { 'ㅃ': 'ㅂ', 'ㅉ': 'ㅈ', 'ㄸ': 'ㄷ', 'ㄲ': 'ㄱ', 'ㅆ': 'ㅅ', 'ㅒ': 'ㅐ', 'ㅖ': 'ㅔ' };

  it('한글 swipes against the Korean list, spelled with the keyboard\'s keys: the word is typed, the others offered', async () => {
    const { popup, sent, cands, swipes } = setupKo([['한국', '한국은', '한글']]);
    await swipe(popup, 'ㅎ', 'ㄱ');
    expect(swipes()).toHaveLength(1);
    const asked = swipes()[0]!;
    expect([asked.lexicon, asked.keyboard, asked['shifts']]).toEqual(['ko/words', 'ko/korean', TENSE]); // 빨리 through ㅂ, Shift or not
    expect(Object.keys(asked['keys'] as object).sort().join('')).toBe('ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㅏㅐㅑㅓㅔㅕㅗㅛㅜㅠㅡㅣ');
    expect(sent()).toEqual(['한국']);
    expect(cands()).toEqual(['한국', '한국은', '한글']);
    expect(logged.join('\n')).not.toMatch(/한국|한글/); // typed text: never logged
  });

  it('what is being composed is sent first; a pick replaces the swiped word, and Backspace right after one takes it back', async () => {
    const { popup, field, cands, pick, typeAll } = setupKo([['한국', '한국은'], ['사람', '사랑']]);
    await typeAll('ㄴㅏ'); // 나, composed in the field
    await swipe(popup, 'ㅎ', 'ㄱ');
    expect(field()).toBe('나 한국'); // 나 sent, then the word after a space, as after any word
    await pick('한국은');
    expect([field(), cands()]).toEqual(['나 한국은 ', []]); // only 은 typed, then a space
    await swipe(popup, 'ㅅ', 'ㅁ');
    expect(field()).toBe('나 한국은 사람');
    await tap(popup, 'Backspace');
    expect(field()).toBe('나 한국은 ');
  });

  it('where it cannot compose in the field, the word waiting in the bar goes first', async () => {
    const { popup, sent, field, typeAll } = setupKo([['한국']], STREAMED);
    await typeAll('ㅎㅏㄱㄱㅛ'); // 학 waits in the bar, 교 composing
    expect(sent()).toEqual([]);
    await swipe(popup, 'ㅎ', 'ㄱ');
    expect(field()).toBe('학교 한국');
  });

  it('ABC swipes as English does, the word waiting in the bar; each draw prepares the list of the mode it shows', async () => {
    const { popup, sent, swipes, prepares } = setupKo([['hello', 'help']]);
    await tap(popup, 'mode'); // ABC, a page of its own
    await swipe(popup, 'h', 'o');
    expect(swipes().map((r) => [r.lexicon, r.keyboard, r['shifts']])).toEqual([['en/words', undefined, undefined]]);
    expect(shadowOf(popup)!.querySelector('.pre')?.textContent).toBe('hello');
    expect(sent()).toEqual([]);
    await tap(popup, 'mode'); // 한글 again: the word goes, then the Korean list is asked for again (a no-op once built)
    expect(prepares().map((r) => [r.lexicon, r.keyboard, r['shifts']])).toEqual([
      ['ko/words', 'ko/korean', TENSE], ['en/words', undefined, undefined], ['ko/words', 'ko/korean', TENSE]]);
  });
});

describe('emoji', () => {
  it('😀 opens the picker over a key row; a tap types the emoji, updates Recent and is saved; ABC returns', async () => {
    const boot = bundledBoot();
    boot.pickers = [emojiSet([{ id: 'smileys', name: 'Smileys & Emotion', icon: 'smileys', items: ['😀', '😃'] }])];
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const saved: unknown[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
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
    expect(saved).toEqual([{ ...NO_EMOJI_STATE, recent: { [EMOJI]: ['😃'] } }]);
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

describe('Steam items in the emoji picker', () => {
  /** polykey with emoji data and, optionally, Steam's chat item store (as a fresh Steam has it). */
  const setupEmoji = (itemStore?: object) => {
    const boot = bundledBoot();
    boot.pickers = [emojiSet([{ id: 'smileys', name: 'Smileys & Emotion', icon: 'smileys', items: ['😀'] }])];
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true, ...(itemStore ? { itemStore } : {}) });
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    return popup;
  };
  const notes = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll('.note')].map((n) => n.textContent);
  const pictures = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll('.cell img')].map((i) => i.getAttribute('src'));

  it('opening the picker asks Steam once; the items show as soon as they arrive', async () => {
    const store = fakeItemStore(800);
    const popup = setupEmoji(store);
    await tap(popup, 'h');
    expect(store.UpdateEmoticonList).not.toHaveBeenCalled(); // typing does not ask
    await tap(popup, 'emoji');
    expect(store.UpdateEmoticonList).toHaveBeenCalledTimes(1);
    expect(notes(popup)).toEqual(expect.arrayContaining([STEAM_LOADING_NOTE]));
    expect(pictures(popup)).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(notes(popup)).not.toContain(STEAM_LOADING_NOTE);
    expect(pictures(popup)).toEqual([expect.stringMatching(/emoticonlarge\/steamhappy$/), expect.stringMatching(/sticker\/Intense%20Gaming$/)]);
    expect([...shadowOf(popup)!.querySelectorAll('.cell.effect')].map((c) => c.textContent)).toEqual(['confetti']);
    const asked = store.UpdateEmoticonList.mock.calls.length;
    await tap(popup, 'Backspace');
    await vi.advanceTimersByTimeAsync(STEAM_ITEMS_WAIT_MS);
    expect(store.UpdateEmoticonList).toHaveBeenCalledTimes(asked); // in: no more looking, keys do not ask
  });

  it('stops looking when the picker closes', async () => {
    const store = fakeItemStore(null);
    const popup = setupEmoji(store);
    await tap(popup, 'emoji');
    await vi.advanceTimersByTimeAsync(1000);
    await tap(popup, 'abc');
    const asked = store.UpdateEmoticonList.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STEAM_ITEMS_WAIT_MS);
    expect(store.UpdateEmoticonList).toHaveBeenCalledTimes(asked);
  });

  it('gives up after a while, showing the empty sections as before', async () => {
    const store = fakeItemStore(null);
    const popup = setupEmoji(store);
    await tap(popup, 'emoji');
    await vi.advanceTimersByTimeAsync(STEAM_ITEMS_WAIT_MS - 1000);
    expect(notes(popup)).toContain(STEAM_LOADING_NOTE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notes(popup)).not.toContain(STEAM_LOADING_NOTE);
    expect(notes(popup)).toContain('No Steam emoticons yet');
    const asked = store.UpdateEmoticonList.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STEAM_ITEMS_WAIT_MS);
    expect(store.UpdateEmoticonList).toHaveBeenCalledTimes(asked);
  });

  it('without Steam\'s store, shows Steam items unavailable, as before', async () => {
    const popup = setupEmoji();
    await tap(popup, 'emoji');
    expect(notes(popup)).toContain('Steam items unavailable');
    expect(notes(popup)).not.toContain(STEAM_LOADING_NOTE);
  });

  it('with a store but no loader, shows what the store has and does not wait', async () => {
    const store = { m_bInitialized: false, m_rgEmoticons: [{ name: 'steamhappy' }] };
    const popup = setupEmoji(store);
    await tap(popup, 'emoji');
    expect(pictures(popup)).toEqual([expect.stringMatching(/emoticonlarge\/steamhappy$/)]);
    expect(notes(popup)).not.toContain(STEAM_LOADING_NOTE);
    expect(notes(popup)).toContain('No Steam stickers yet');
    expect(store).toEqual({ m_bInitialized: false, m_rgEmoticons: [{ name: 'steamhappy' }] });
  });
});

describe('Japanese 12-key', () => {
  /** A fake sidecar: settings saves are kept; convert and predict answer from a tiny dictionary. */
  const withConverter = (g: Record<string, unknown>) => {
    const saved: unknown[] = [];
    const asked: string[] = [];
    const learned: unknown[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      asked.push(req.op);
      let reply: Record<string, unknown> = { ok: true };
      if (req.op === 'settings.save') saved.push(req.settings);
      if (req.op === 'learn') learned.push({ reading: req.reading, lengths: req.lengths, choices: req.choices, texts: req.texts });
      if (req.op === 'desktop.prepare') reply = { ok: false, error: 'not-desktop' };
      if (req.op === 'predict') reply = { ok: true, predictions: [] };
      if (req.op === 'convert') {
        const cut = req.lengths?.[0] === 2 && req.resize?.[1] === 1 ? 3 : 2;
        const r = req.reading ?? '';
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
    boot.pickers = [emojiSet([{ id: 'smileys', name: 'Smileys & Emotion', icon: 'smileys', items: ['😀'] }])];
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

describe('picker sets', () => {
  const emoji = emojiSet([{ id: 'smileys', name: 'Smileys & Emotion', icon: 'smileys', items: ['😀'] }]);
  const kaomoji = kaomojiSet([
    { id: 'smiling', name: { en: 'Smiling', ja: '笑顔' }, items: ['(^_^)', '(≧▽≦)'] },
    { id: 'classic', name: { en: 'Classic', ja: 'クラシック' }, items: [':-)', ';-)'] },
  ]);
  /** A user's own set: plain characters, with no Favorites, tones or Steam items. */
  const arrows: PickerSet = { id: 'mine/arrows', name: 'Arrows', key: { icon: 'right' }, cells: 'emoji', recent: true, categories: [{ id: 'arrows', name: 'Arrows', icon: 'up', items: ['→', '←'] }] };
  /** polykey with these sets; `saved` is what the sidecar was asked to save. */
  const setupSets = (state: Partial<EmojiState> = {}, sets: PickerSet[] = [emoji, kaomoji]) => {
    const boot = bundledBoot();
    boot.pickers = sets;
    boot.emojiState = { ...NO_EMOJI_STATE, ...state };
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    const saved: EmojiState[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      if (req.op === 'emoji.save') saved.push(req.state as EmojiState);
      const reply = req.op === 'desktop.prepare' ? { ok: false, error: 'not-desktop' } : { ok: true };
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    const api = installPolykey(steam.g);
    installed.push(api);
    return { popup, manager, saved, api };
  };
  const cells = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.strip .cell')];
  const faces = (popup: FakePopupWindow) => cells(popup).filter((c) => c.classList.contains('face'));
  const tabs = (popup: FakePopupWindow) => [...shadowOf(popup)!.querySelectorAll('.tab')].map((t) => t.textContent);
  const note = (popup: FakePopupWindow) => shadowOf(popup)!.querySelector('.note')!.textContent;
  /** What the mode key shows: an icon, by name, or its text. */
  const modeKey = (popup: FakePopupWindow) => {
    const label = key(popup, 'next-set').querySelector('.lbl')!;
    const asDrawn = (svg: string): string => Object.assign(document.createElement('div'), { innerHTML: svg }).innerHTML;
    const icon = Object.entries(ICONS).find(([, svg]) => asDrawn(svg) === label.innerHTML)?.[0];
    return icon ? `icon ${icon}` : label.textContent;
  };
  const press = async (el: HTMLElement) => {
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(2000);
  };

  it('the mode key reads :-) over emoji and shows the emoji icon over kaomoji; each switch is saved', async () => {
    const { popup, saved } = setupSets();
    await tap(popup, 'emoji');
    expect(modeKey(popup)).toBe(':-)'); // the kaomoji set's key label
    expect(faces(popup)).toHaveLength(0);
    await tap(popup, 'next-set');
    expect(modeKey(popup)).toBe('icon emoji');
    expect(faces(popup).map((c) => c.textContent)).toEqual(['(^_^)', '(≧▽≦)', ':-)', ';-)']);
    expect(tabs(popup)).toEqual(['', 'Smiling', 'Classic']); // Recent's tab is its icon
    expect(saved.at(-1)).toMatchObject({ set: KAOMOJI });
    await tap(popup, 'next-set');
    expect(modeKey(popup)).toBe(':-)');
    expect(faces(popup)).toHaveLength(0);
    expect(cells(popup)[0]!.textContent).toBe('😀');
    expect(saved.at(-1)).toMatchObject({ set: EMOJI });
  });

  it('the mode key cycles through every set in pack order, showing the next one\'s icon or key label', async () => {
    const { popup, saved } = setupSets({}, [emoji, kaomoji, arrows]);
    await tap(popup, 'emoji');
    const seen: (string | null)[][] = [];
    for (let i = 0; i < 4; i++) {
      seen.push([note(popup), modeKey(popup)]);
      await tap(popup, 'next-set');
    }
    expect(seen).toEqual([
      ['Recently used emoji appear here.', ':-)'],
      ['Recently used kaomoji appear here.', 'icon right'],
      ['Recently used arrows appear here.', 'icon emoji'],
      ['Recently used emoji appear here.', ':-)'],
    ]);
    expect(saved.map((s) => s.set)).toEqual([KAOMOJI, 'mine/arrows', EMOJI, KAOMOJI]);
  });

  it('with one set there is no mode key, and a saved set that is gone shows the first', async () => {
    const { popup } = setupSets({ ...NO_EMOJI_STATE, set: KAOMOJI }, [emoji]);
    await tap(popup, 'emoji');
    expect(key(popup, 'next-set')).toBeUndefined();
    expect(key(popup, 'abc')).toBeDefined();
    expect(cells(popup)[0]!.textContent).toBe('😀');
  });

  it('without any set the 😀 key stays on the keys', async () => {
    const { popup } = setupSets({}, []);
    await tap(popup, 'emoji');
    expect(shadowOf(popup)!.querySelector('.emoji')).toBeNull();
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5);
  });

  it('the picker opens on the saved set, and stays on it after a visit to the keys', async () => {
    const { popup } = setupSets({ ...NO_EMOJI_STATE, set: KAOMOJI, recent: { [KAOMOJI]: [';-)'] } });
    await tap(popup, 'emoji');
    expect(faces(popup).map((c) => c.textContent)).toEqual([';-)', '(^_^)', '(≧▽≦)', ':-)', ';-)']);
    await tap(popup, 'abc');
    await tap(popup, 'emoji');
    expect(faces(popup)).toHaveLength(5);
  });

  it('Recent is kept per set: what is typed goes to the front of the shown set\'s, and is saved; nothing is logged', async () => {
    const { popup, manager, saved } = setupSets({ ...NO_EMOJI_STATE, set: KAOMOJI, recent: { [EMOJI]: ['😀'] } }, [emoji, kaomoji, arrows]);
    await tap(popup, 'emoji');
    await press(faces(popup).find((c) => c.textContent === '(≧▽≦)')!);
    await press(faces(popup).find((c) => c.textContent === ':-)')!);
    const typed = () => manager.calls.map(([text]) => text).join(''); // ASCII goes a character per call
    expect(typed()).toBe('(≧▽≦):-)');
    expect(saved.at(-1)).toEqual({ ...NO_EMOJI_STATE, set: KAOMOJI, recent: { [EMOJI]: ['😀'], [KAOMOJI]: [':-)', '(≧▽≦)'] } });
    expect(faces(popup).slice(0, 2).map((c) => c.textContent)).toEqual([':-)', '(≧▽≦)']);
    await press(faces(popup)[1]!); // from Recent: typed, and Recent keeps its order under the laser
    expect(typed()).toBe('(≧▽≦):-)(≧▽≦)');
    expect(saved.at(-1)!.recent[KAOMOJI]).toEqual([':-)', '(≧▽≦)']);
    // The next set has its own Recent, empty until something of its own is typed.
    await tap(popup, 'next-set');
    expect(note(popup)).toBe('Recently used arrows appear here.');
    await press(cells(popup).find((c) => c.textContent === '→')!);
    expect(cells(popup).slice(0, 2).map((c) => c.textContent)).toEqual(['→', '→']); // Recent's, then the category's
    expect(saved.at(-1)!.recent).toEqual({ [EMOJI]: ['😀'], [KAOMOJI]: [':-)', '(≧▽≦)'], 'mine/arrows': ['→'] });
    // And the first set's is as it was.
    await tap(popup, 'next-set');
    expect(cells(popup).slice(0, 2).map((c) => c.textContent)).toEqual(['😀', '😀']);
    expect(logged.join('\n')).not.toMatch(/≧|:-\)|→/);
  });

  it('the bin empties the shown set\'s Recent alone', async () => {
    const { popup, saved } = setupSets({ ...NO_EMOJI_STATE, recent: { [EMOJI]: ['😀'], [KAOMOJI]: [':-)'] } });
    await tap(popup, 'emoji');
    shadowOf(popup)!.querySelector('.trash')!.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(saved.at(-1)!.recent).toEqual({ [EMOJI]: [], [KAOMOJI]: [':-)'] });
    expect(shadowOf(popup)!.querySelector('.trash')).toBeNull();
  });

  it('the skin tone applies in a set that offers tones, and nowhere else', async () => {
    const wave = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
    const toned = emojiSet([{ id: 'people', name: 'People & Body', icon: 'people', items: [wave] }]);
    const plain: PickerSet = { id: 'mine/hands', name: 'Hands', key: { icon: 'people' }, cells: 'emoji', categories: [{ id: 'hands', name: 'Hands', icon: 'people', items: ['👋'] }] };
    const { popup, manager } = setupSets({ ...NO_EMOJI_STATE, tone: 'dark' }, [toned, plain]);
    await tap(popup, 'emoji');
    await press(cells(popup).find((c) => c.textContent === '👋🏿')!);
    await tap(popup, 'next-set');
    await press(cells(popup).find((c) => c.textContent === '👋')!);
    expect(manager.calls.map(([text]) => text)).toEqual(['👋🏿', '👋']);
  });

  it('a Japanese keyboard names the tabs in Japanese', async () => {
    const { popup, api } = setupSets({ ...NO_EMOJI_STATE, set: KAOMOJI });
    api.debug.use('ja/12key');
    await tap(popup, 'emoji');
    expect(tabs(popup)).toEqual(['', '笑顔', 'クラシック']);
  });
});

describe('settings → Keyboards', () => {
  it('✕ removes a keyboard, a tapped layout comes back at the end; 🌐 and the save follow', async () => {
    const { popup, g, api } = setup();
    const saved: unknown[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
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

describe('names in more than one language', () => {
  /** polykey with names per language on a theme and two keyboards, the first of `keyboards` showing. */
  const setupNames = (keyboards: string[]) => {
    const boot = bundledBoot();
    boot.catalog.themes['themes/steam']!.name = { en: 'Steam', ja: 'スチーム' };
    boot.catalog.keyboards['en/english']!.name = { en: 'QWERTY', ja: 'クワーティ' };
    boot.catalog.keyboards['ja/12key']!.name = { en: '12-key', ja: '12キー' };
    boot.settings = { ...boot.settings, keyboards };
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    return popup;
  };
  const press = async (el: HTMLElement) => {
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
  };
  /** 🌐's menu, then settings: the theme's name, the keyboard's own name, and Keyboards' layouts and list. */
  const shown = async (popup: FakePopupWindow) => {
    const globe = key(popup, 'next-keyboard');
    globe.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(500);
    const menu = [...shadowOf(popup)!.querySelectorAll('.alts.menu .key')].map((c) => c.textContent);
    globe.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
    await tap(popup, 'settings');
    const panel = shadowOf(popup)!.querySelector('.panel')!;
    const theme = panel.querySelector('.pick > .opt')!.textContent;
    const general = panel.textContent;
    await press([...panel.querySelectorAll<HTMLElement>('.opt.tab')].find((o) => o.textContent === 'Keyboards')!);
    const names = (column: string) => [...shadowOf(popup)!.querySelectorAll(`.panel .${column} .item .nm`)].map((i) => i.textContent);
    return { menu, theme, general, layouts: names('lays'), mine: names('mine') };
  };

  it('on an English keyboard the theme has its English name; each keyboard has its own language\'s', async () => {
    const { menu, theme, general, layouts, mine } = await shown(setupNames(['en/english', 'ja/12key']));
    expect(theme).toBe('Steam');
    expect(general).toContain('English · QWERTY');
    expect(menu).toEqual(['EnglishQWERTY', '日本語12キー']);
    expect(layouts).toEqual(['QWERTY']);
    expect(mine).toEqual(['English · QWERTY', '日本語 · 12キー']);
  });

  it('on a Japanese keyboard the theme has its Japanese name; each keyboard still has its own language\'s', async () => {
    const { menu, theme, general, layouts, mine } = await shown(setupNames(['ja/12key', 'en/english']));
    expect(theme).toBe('スチーム');
    expect(general).toContain('日本語 · 12キー');
    expect(menu).toEqual(['日本語12キー', 'EnglishQWERTY']);
    expect(layouts).toContain('12キー');
    expect(layouts).not.toContain('12-key');
    expect(mine).toEqual(['日本語 · 12キー', 'English · QWERTY']);
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
});

describe('Japanese romaji and JIS kana', () => {
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

  it('copy, cut and paste send the reading first, and their chord waits for its keymap to settle', async () => {
    const { popup, manager, g, api } = setup();
    // Both entry points on one clock: in minimal mode gamescope types the kana through a temporary
    // keymap, and a chord pressed before that settles lands on the default one (number-row digits).
    const at: [string, number][] = [];
    manager.HandleVirtualKeyDown = (k) => { at.push([k, Date.now()]); };
    (g['SteamClient'] as { Input: Record<string, unknown> }).Input['ControllerKeyboardSetKeyState'] =
      (code: number, down: boolean) => { at.push([...keyNames([[code, down]]), Date.now()] as [string, number]); };
    api.debug.use('ja/jis');
    for (const action of ['copy', 'cut', 'paste'] as const) {
      at.length = 0;
      await tap(popup, 'q'); // た
      await tap(popup, 'q');
      await tap(popup, action);
      expect(at.map(([k]) => k)).toEqual(['たた', ...keyNames(CLIPBOARD_CHORDS[action])]);
      expect(at[1]![1] - at[0]![1]).toBeGreaterThanOrEqual(KEYMAP_SETTLE.chord); // the chord's first press
      expect(shadowOf(popup)!.querySelector('.pre')?.textContent || null).toBeNull();
    }
  });

  it('in Desktop Mode the reading a clipboard key sends goes by paste, then the key acts', async () => {
    const { popup, manager, g, api } = setup();
    const seen: string[] = [];
    (g['SteamClient'] as { Input: Record<string, unknown> }).Input['ControllerKeyboardSetKeyState'] =
      (code: number, down: boolean) => { seen.push(...keyNames([[code, down]])); };
    g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      if (req.op === 'desktop.prepare') seen.push(`prepare ${req.text}`);
      if (req.op === 'desktop.wait') seen.push('wait');
      const reply = req.op === 'desktop.wait' ? { ok: true, pasted: true } : { ok: true };
      setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    api.debug.use('ja/jis');
    await tap(popup, 'q'); // た
    await tap(popup, 'q');
    await tap(popup, 'copy');
    expect(manager.calls).toEqual([]); // nothing typed through the keymap Desktop Mode ignores
    expect(seen).toEqual(['prepare たた', ...keyNames(CLIPBOARD_CHORDS.paste), 'wait', ...keyNames(CLIPBOARD_CHORDS.copy)]);
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

describe('language packs', () => {
  it('a Japanese keyboard takes its bar words, its letters and its idle hint from the ja pack', async () => {
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    const ja = boot.catalog.languages!['ja']!;
    boot.catalog.languages = { ...boot.catalog.languages, ja: { ...ja, letters: 'かなA', idleHint: 'Type here',
      labels: { ...ja.labels, convert: 'Conv', confirm: 'OK' } } };
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    await tap(popup, 'next-keyboard'); // the 12-key
    expect(shadowOf(popup)!.querySelector('.comp.on .placeholder')?.textContent).toBe('Type here');
    await tap(popup, 'た');
    expect([key(popup, ' ').textContent, key(popup, 'Enter').textContent]).toEqual(['Conv', 'OK']);
    await tap(popup, 'symbols');
    expect(key(popup, 'symbols').querySelector('.lbl')!.textContent).toBe('かなA'); // back to the kana
  });
});

describe('the mode key', () => {
  it('switches a keyboard between its own letters and its Latin mode, sending what waits, and reads where it goes', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    // The romaji keyboard with one mode key where its 英数 and かな were.
    const romaji = boot.catalog.layouts['ja/qwerty-romaji']!;
    const rows = romaji.rows.map((row) => row.flatMap((k): (string | KeyDef)[] => {
      if (typeof k === 'string' || k.type !== 'action') return [k];
      if (k.action === 'eisu') return [{ type: 'action', action: 'mode', w: 3 }];
      return k.action === 'kana' ? [] : [k];
    }));
    boot.catalog.layouts['mine/mode'] = { ...romaji, id: 'mine/mode', rows };
    boot.catalog.keyboards['mine/mode'] = { ...boot.catalog.keyboards['ja/romaji']!, id: 'mine/mode', layout: 'mine/mode' };
    boot.settings.keyboards = ['en/english', 'mine/mode'];
    steam.g[BOOT_GLOBAL] = boot;
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('mine/mode');
    const pre = () => shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null;
    await tap(popup, 'k');
    await tap(popup, 'a');
    expect([pre(), key(popup, 'mode').textContent]).toEqual(['か', 'ABC']);
    await tap(popup, 'mode'); // the reading goes first
    expect(manager.calls.map((c) => c[0]).join('')).toBe('か');
    expect(key(popup, 'mode').textContent).toBe('あいう'); // the language's letters
    await tap(popup, 'k'); // an English word, in the bar
    expect(pre()).toBe('k');
    await tap(popup, 'mode'); // the word goes first
    expect(manager.calls.map((c) => c[0]).join('')).toBe('かk');
    await tap(popup, 'k');
    await tap(popup, 'a');
    expect([pre(), key(popup, 'mode').textContent]).toEqual(['か', 'ABC']);
  });
});

describe('the convert key', () => {
  it('does nothing where no composer takes it: nothing is sent, and the word being typed goes on', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    // The English keyboard with a convert key in place of its Alt.
    const qwerty = boot.catalog.layouts['en/qwerty']!;
    const rows = qwerty.rows.map((row) => row.map((k): string | KeyDef => (typeof k !== 'string' && k.type === 'mod' && k.mod === 'alt'
      ? { type: 'action', action: 'convert', label: 'Conv' } : k)));
    boot.catalog.layouts['mine/convert'] = { ...qwerty, id: 'mine/convert', rows };
    boot.catalog.keyboards['mine/convert'] = { ...boot.catalog.keyboards['en/english']!, id: 'mine/convert', layout: 'mine/convert' };
    boot.settings.keyboards = ['en/english', 'mine/convert'];
    steam.g[BOOT_GLOBAL] = boot;
    const api = installPolykey(steam.g);
    installed.push(api);
    api.debug.use('mine/convert');
    await tap(popup, 'h');
    await tap(popup, 'convert');
    await tap(popup, 'i');
    expect(manager.calls.map((c) => c[0])).toEqual(['h', 'i']);
    expect(logged.join('\n')).not.toContain('not available'); // not an action the page runs
  });
});

describe('pages', () => {
  const setupPages = (options: { qwertyLatin?: boolean } = {}) => {
    const popup = fakePopupWindow();
    const steam = fakeSteam({ popup, managers: [fakeManager(true)], status: MINIMAL, keyState: true });
    const boot = bundledBoot();
    const action = (name: ActionName): KeyDef => ({ type: 'action', action: name });
    const page = (id: string, ...keys: (string | KeyDef)[]) => { boot.catalog.layouts[id] = { id, name: id, rows: [keys] }; };
    page('mine/letters', 'm', action('symbols'), action('eisu'));
    page('mine/flick', 'f', action('symbols'), action('kana'));
    page('mine/qwerty', 'q', action('symbols'), action('kana'));
    page('mine/symbols', '1', action('more-symbols'), action('symbols'));
    page('mine/symbols2', '§', action('more-symbols'), action('symbols'));
    boot.catalog.keyboards['mine/pages'] = { id: 'mine/pages', name: 'Pages', layout: 'mine/letters', options: { qwertyLatin: true },
      pages: { latin: { flick: 'mine/flick', qwerty: 'mine/qwerty' }, symbols: ['mine/symbols', 'mine/symbols2'] } };
    boot.settings.keyboards = ['mine/pages'];
    boot.settings.keyboardOptions = { 'mine/pages': options };
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    const shown = () => shadowOf(popup)!.querySelector<HTMLElement>('.row .key')!.dataset['k'];
    return { popup, shown };
  };

  it('英数 shows the ABC page qwertyLatin picks; ?123 opens the symbols over it, =\\< goes between their two pages, ?123 back to the letters', async () => {
    const { popup, shown } = setupPages();
    const seen = [shown()];
    for (const k of ['eisu', 'symbols', 'more-symbols', 'more-symbols', 'symbols', 'symbols', 'more-symbols', 'symbols', 'kana']) {
      await tap(popup, k);
      seen.push(shown());
    }
    expect(seen).toEqual(['m', 'q', '1', '§', '1', 'q', '1', '§', 'q', 'm']);
    const flick = setupPages({ qwertyLatin: false });
    await tap(flick.popup, 'eisu');
    expect(flick.shown()).toBe('f');
  });
});

describe('a keyboard that composes', () => {
  /** Composing in the bar (streamed), with ㄴ held for 4. */
  const setupComposing = () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: STREAMED, keyState: true });
    const boot = bundledBoot();
    boot.catalog.tables = { ...boot.catalog.tables, 'mine/hangul': { id: 'mine/hangul', name: 'Hangul', hangul: {} } };
    boot.catalog.layouts['mine/hangul'] = { id: 'mine/hangul', name: 'Hangul', toolbar: [{ type: 'action', action: 'hide' }],
      rows: [['ㅎ', 'ㅏ', { type: 'char', char: 'ㄴ', long: ['4'] }, { type: 'mod', mod: 'shift' }]] };
    boot.catalog.keyboards['mine/hangul'] = { id: 'mine/hangul', name: 'Hangul', layout: 'mine/hangul', composer: 'hangul-2set', table: 'mine/hangul' };
    boot.settings.keyboards = ['mine/hangul'];
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    const sent = () => manager.calls.map((c) => c[0]);
    const pre = () => shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null;
    return { popup, sent, pre };
  };

  it('a held key\'s alternate that the composer does not take sends what is composed first', async () => {
    const { popup, sent, pre } = setupComposing();
    await tap(popup, 'ㅎ');
    await tap(popup, 'ㅏ');
    const held = key(popup, 'ㄴ');
    touch(held, 'touchstart', 0, 0);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    const four = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.alts .key')].find((el) => el.textContent === '4')!;
    Object.defineProperty(shadowOf(popup)!, 'elementsFromPoint', { configurable: true, value: () => [four] });
    touch(held, 'touchmove', 0, 0);
    touch(held, 'touchend', 0, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect([sent(), pre()]).toEqual([['하', '4'], null]);
  });

  it('a modifier only arms: what is composed waits', async () => {
    const { popup, sent, pre } = setupComposing();
    await tap(popup, 'ㅎ');
    await tap(popup, 'shift');
    await tap(popup, 'ㅏ');
    expect([sent(), pre()]).toEqual([[], '하']);
  });
});

// Where it cannot compose in the field (here streamed, as through Steam Link), Korean builds the word in the bar.
describe('Korean', () => {
  const setupKo = () => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: STREAMED, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboards = ['ko/korean', 'en/english'];
    steam.g[BOOT_GLOBAL] = boot;
    installed.push(installPolykey(steam.g));
    const sent = () => manager.calls.map((c) => c[0]);
    const pre = () => shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null;
    const typeAll = async (keys: string) => { for (const k of Array.from(keys)) await tap(popup, k); };
    return { popup, sent, pre, typeAll, state: steam.state };
  };
  /** The mode key's marked half (한 or 영), in this popup. */
  const marked = (popup: FakePopupWindow) => key(popup, 'mode').querySelector('.part.now')?.textContent;

  it('builds the word in the bar, in the language\'s fonts; Space sends it and a space, Enter sends it alone', async () => {
    const { popup, sent, pre, typeAll } = setupKo();
    const font = shadowOf(popup)!.querySelector<HTMLElement>('.kb')!.style.getPropertyValue('--language-font');
    expect(font).toBe('"Noto Sans CJK KR", "Noto Sans CJK JP", var(--font)'); // then the theme's
    await typeAll('ㅎㅏㄴ');
    expect([sent(), pre()]).toEqual([[], '한']);
    await typeAll('ㄱㅡㄹ');
    expect([sent(), pre()]).toEqual([[], '한글']); // 한 waits with the word, before 글
    await tap(popup, ' ');
    expect([sent(), pre()]).toEqual([['한글', ' '], null]); // the word, whole
    await typeAll('ㅇㅓㅂㅅㅇㅓ.');
    expect(sent().slice(2)).toEqual(['없어', '.']); // punctuation sends the word first
    await typeAll('ㄴㅔ');
    await tap(popup, 'Enter');
    expect(sent().slice(4)).toEqual(['네']); // sent, and Enter not pressed: nothing is searched for yet
    await tap(popup, 'Enter');
    expect(sent().slice(5)).toEqual(['Enter']); // with the bar empty, Enter is Enter
  });

  it('Shift types the tense consonant once; ⌫ takes jamo off, then deletes in the field', async () => {
    const { popup, sent, pre, typeAll } = setupKo();
    await tap(popup, 'shift');
    expect(key(popup, 'ㅂ').querySelector('.lbl')!.textContent).toBe('ㅃ');
    await typeAll('ㅂㅏ');
    expect(pre()).toBe('빠');
    expect(key(popup, 'ㅂ').querySelector('.lbl')!.textContent).toBe('ㅂ'); // Shift was one-shot
    await typeAll('ㅂ');
    expect(pre()).toBe('빱');
    for (const shown of ['빠', 'ㅃ', null]) {
      await tap(popup, 'Backspace');
      expect(pre()).toBe(shown);
    }
    expect(sent()).toEqual([]);
    await tap(popup, 'Backspace'); // nothing in the bar: the field's
    expect(sent()).toEqual(['Backspace']);
    await typeAll('ㅎㅏㄴㄱㅡㄹ');
    for (const shown of ['한그', '한ㄱ', '한', null]) { // the composition, then the word's syllables
      await tap(popup, 'Backspace');
      expect(pre()).toBe(shown);
    }
    expect(sent()).toEqual(['Backspace']);
  });

  it('한/영 sends the syllable and switches to ABC, where English waits in the bar as in any Latin mode; and back', async () => {
    const { popup, sent, pre, typeAll } = setupKo();
    await typeAll('ㅎㅏ');
    expect([key(popup, 'mode').textContent, marked(popup)]).toEqual(['한/영', '한']);
    await tap(popup, 'mode');
    expect(sent()).toEqual(['하']);
    expect(key(popup, 'ㅂ')).toBeUndefined(); // the ABC page
    expect(marked(popup)).toBe('영');
    await typeAll('hi');
    expect(pre()).toBe('hi');
    await tap(popup, 'mode'); // the English word goes first
    expect(sent().join('')).toBe('하hi');
    expect(marked(popup)).toBe('한');
    await typeAll('ㄱㅏ');
    expect(pre()).toBe('가');
  });

  it('the marked half follows the mode through a keyboard switch, a closed and reopened keyboard, and a new popup', async () => {
    const { popup, state } = setupKo();
    await tap(popup, 'mode');
    expect(marked(popup)).toBe('영');
    await tap(popup, 'next-keyboard'); // English
    await tap(popup, 'next-keyboard'); // back to Korean, still in ABC
    expect([key(popup, 'q') !== undefined, marked(popup)]).toEqual([true, '영']);
    state.status = { ...MINIMAL, bIsOpen: false };
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    state.status = { ...MINIMAL, bIsOpen: true };
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(marked(popup)).toBe('영');
    const next = fakePopupWindow(); // Steam made the popup again: polykey is drawn anew in it
    state.popup = next;
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(marked(next)).toBe('영');
    await tap(next, 'mode');
    expect(marked(next)).toBe('한');
  });

  it('switching keyboards sends the syllable', async () => {
    const { popup, sent, typeAll } = setupKo();
    await typeAll('ㄷㅏㄹㄱ');
    await tap(popup, 'next-keyboard');
    expect(sent()).toEqual(['닭']);
    expect(key(popup, 'q')).toBeDefined(); // English
  });
});

describe('Korean word suggestions', () => {
  /**
   * The Korean keyboard with a fake sidecar: suggest answers with `words` for the prefix (the sidecar
   * matches on keys; test_spellers.py). Composed in the bar, as where it cannot compose in the field
   * (streamed).
   */
  const setupWords = (words: Record<string, string[]>, boot = bundledBoot()) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const steam = fakeSteam({ popup, managers: [manager], status: STREAMED, keyState: true });
    boot.settings.keyboards = ['ko/korean', 'en/english', 'ja/romaji'];
    steam.g[BOOT_GLOBAL] = boot;
    const asked: SentRequest[] = [];
    const prepared: SentRequest[] = [];
    steam.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      if (req.op === 'suggest') (req.prepare ? prepared : asked).push(req);
      const reply = req.op === 'suggest' ? { ok: true, words: words[req.prefix ?? ''] ?? [] } : { ok: false, error: 'unknown-op' };
      setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    const api = installPolykey(steam.g);
    installed.push(api);
    const sent = () => manager.calls.map((c) => c[0]);
    const pre = () => shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null;
    const cands = () => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.comp.on .cand')].map((el) => el.textContent);
    const typeAll = async (keys: string) => { for (const k of Array.from(keys)) await tap(popup, k); };
    const pick = async (text: string) => {
      const el = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => c.textContent === text)!;
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(200);
    };
    return { popup, api, asked, prepared, sent, pre, cands, typeAll, pick };
  };
  const WORDS = { 학교: ['학교', '학교에서', '학교를'], 학: ['하고', '학교', '학교에서'], 가: ['가장', '가지'] };

  it('suggests for the word in the bar and the syllable composing, on the keys of the keyboard typed on', async () => {
    const { popup, asked, sent, pre, cands, typeAll } = setupWords(WORDS);
    await typeAll('ㅎㅏㄱㄱㅛ');
    expect(asked.map((r) => r.prefix)).toEqual(['ㅎ', '하', '학', '학ㄱ', '학교']); // 학 in the word, then 교 composing
    expect(asked.every((r) => r.lexicon === 'ko/words' && r.keyboard === 'ko/korean')).toBe(true);
    expect([sent(), pre(), cands()]).toEqual([[], '학교', ['학교', '학교에서', '학교를']]);
    await tap(popup, ' '); // the word ends: no suggestions until the next
    expect([sent(), cands()]).toEqual([['학교', ' '], []]);
    await typeAll('ㄱㅏ');
    expect(asked.at(-1)!.prefix).toBe('가');
    expect(cands()).toEqual(['가장', '가지']);
    expect(logged.join('\n')).not.toMatch(/학|교|가장/); // typed text and suggestions: never logged
  });

  it('a pick sends the word and a space in place of the bar\'s: nothing of it was sent, so nothing is deleted', async () => {
    const { popup, sent, pre, cands, typeAll, pick } = setupWords(WORDS);
    await typeAll('ㅎㅏㄱㄱㅛ');
    await pick('학교에서');
    expect(sent()).toEqual(['학교에서', ' ']);
    expect([pre(), cands()]).toEqual([null, []]);
    await tap(popup, '.'); // punctuation closes up to the picked word, as in English
    expect(sent().slice(-2)).toEqual(['Backspace', '.']);
    await typeAll('ㅎㅏㄱ'); // the picked word comes first for the rest of the session
    expect(cands()).toEqual(['학교에서', '하고', '학교']);
  });

  it('with nothing composed, the word in the bar keeps its suggestions, and a pick takes its place', async () => {
    const { popup, sent, pre, cands, typeAll, pick } = setupWords(WORDS);
    await typeAll('ㅎㅏㄱㄱㅛ');
    await tap(popup, 'Backspace'); // 교 → ㄱ
    await tap(popup, 'Backspace'); // nothing composed: 학 waits in the bar
    expect([sent(), pre(), cands()]).toEqual([[], '학', ['하고', '학교', '학교에서']]);
    await pick('학교');
    expect(sent()).toEqual(['학교', ' ']);
  });

  it('each draw of a keyboard asks the sidecar once to prepare the list its mode suggests from; typing asks for none', async () => {
    const { popup, prepared, typeAll } = setupWords(WORDS);
    const lists = () => prepared.map((r) => [r.lexicon, r.keyboard]);
    expect(lists()).toEqual([['ko/words', 'ko/korean']]); // 한글: for the hangul-2set speller
    await typeAll('ㅎㅏㄱ');
    await tap(popup, 'mode'); // ABC, a page of its own
    expect(lists()).toEqual([['ko/words', 'ko/korean'], ['en/words', undefined]]);
    await tap(popup, 'next-keyboard'); // English
    await tap(popup, 'next-keyboard'); // Japanese, in かな: no list
    expect(lists()).toEqual([['ko/words', 'ko/korean'], ['en/words', undefined], ['en/words', undefined]]);
    await tap(popup, 'eisu'); // 英数, the same keys drawn anew
    expect(lists().at(-1)).toEqual(['en/words', undefined]);
    expect(prepared).toHaveLength(4);
    expect(prepared.every((r) => r.prefix === undefined)).toBe(true); // no typed text
  });

  it('with suggestions off, no list is prepared', async () => {
    const boot = bundledBoot();
    boot.settings.suggestions = false;
    const { prepared } = setupWords(WORDS, boot);
    expect(prepared).toEqual([]);
  });

  it('ABC suggests English as before, and neither it nor the English keyboard names a keyboard; Japanese かな asks for none', async () => {
    const { popup, api, asked, typeAll } = setupWords({});
    await tap(popup, 'mode'); // ABC
    await tap(popup, 'h');
    expect(asked.at(-1)).toMatchObject({ prefix: 'h', lexicon: 'en/words' });
    expect(asked.at(-1)!.keyboard).toBeUndefined();
    await tap(popup, 'next-keyboard'); // English
    await tap(popup, 'e');
    expect(asked.at(-1)).toMatchObject({ prefix: 'e', lexicon: 'en/words' });
    expect(asked.at(-1)!.keyboard).toBeUndefined();
    const before = asked.length;
    api.debug.use('ja/romaji');
    await typeAll('ka');
    expect(asked.length).toBe(before);
  });
});

describe('Korean composed in the text field', () => {
  /** What the field holds after these calls: text at its end, a Backspace takes its last character, a named key shows as <Name>. */
  const fieldOf = (calls: readonly string[], start = '') => calls.reduce((field, k) => (k === 'Backspace' ? graphemes(field).slice(0, -1).join('')
    : /^[A-Z][A-Za-z]+$/.test(k) ? `${field}<${k}>` : field + k), start);
  /**
   * The Korean keyboard in a game (minimal) unless `status` says otherwise. With no `sidecar` there is
   * no bridge, so no paste route; with one, it answers the requests it knows (an unknown op gets
   * unknown-op, so desktop.prepare finds no desktop).
   */
  const setupField = ({ status = MINIMAL, sidecar }: { status?: VRKeyboardStatus; sidecar?: (req: SentRequest) => Record<string, unknown> | undefined } = {}) => {
    const popup = fakePopupWindow();
    const manager = fakeManager(true);
    const at: number[] = [];
    let failing = 0;
    manager.HandleVirtualKeyDown = (k, shift) => {
      if (failing > 0) {
        failing -= 1;
        throw new Error('gone');
      }
      manager.calls.push([k, shift]);
      at.push(Date.now());
    };
    const steam = fakeSteam({ popup, managers: [manager], status, keyState: true });
    const boot = bundledBoot();
    boot.settings.keyboards = ['ko/korean', 'en/english', 'ja/romaji'];
    steam.g[BOOT_GLOBAL] = boot;
    const asked: SentRequest[] = [];
    if (sidecar) {
      steam.g['polykeyBridge'] = (payload: string) => {
        const req = request(payload);
        asked.push(req);
        const reply = sidecar(req) ?? { ok: false, error: 'unknown-op' };
        setTimeout(() => (steam.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply }), 1);
      };
    }
    const api = installPolykey(steam.g);
    installed.push(api);
    const sent = () => manager.calls.map((c) => c[0]);
    const pre = () => shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent || null;
    const cands = () => [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.comp.on .cand')].map((el) => el.textContent);
    const typeAll = async (keys: string) => { for (const k of Array.from(keys)) await tap(popup, k); };
    /** The keyboard opened a moment ago: the sidecar has answered what it was asked then (where the focus is). */
    const opened = () => vi.advanceTimersByTimeAsync(10);
    /** Press without waiting: presses as fast as sends can go. */
    const press = (id: string) => {
      const el = key(popup, id);
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    };
    const pick = async (text: string) => {
      const el = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => c.textContent === text)!;
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(200);
    };
    return { ...steam, popup, manager, api, at, asked, sent, pre, cands, typeAll, press, pick, opened, failNext: (n = 1) => { failing = n; } };
  };
  type Field = ReturnType<typeof setupField>;
  /** A sidecar where Desktop Mode does not have the focus. */
  const notDesktop = (more: (req: SentRequest) => Record<string, unknown> | undefined = () => undefined) =>
    (req: SentRequest) => (req.op === 'desktop.focus' ? { ok: true, desktop: false } : more(req));

  it('in a game each jamo retypes the syllable in the field, only what changed; Space adds nothing to it', async () => {
    const { popup, sent, pre, typeAll } = setupField();
    await typeAll('ㅎㅏㄴㄱㅡㄹ');
    expect(sent()).toEqual(['ㅎ', 'Backspace', '하', 'Backspace', '한', 'ㄱ', 'Backspace', '그', 'Backspace', '글']);
    expect(fieldOf(sent())).toBe('한글');
    expect(pre()).toBeNull(); // the syllable is in the field, not the bar
    await tap(popup, ' ');
    expect(sent().slice(10)).toEqual([' ']);
    await typeAll('ㅎㅏㄴㅏ'); // the final moves on: 한 typed again without it, then 나
    expect(sent().slice(11)).toEqual(['ㅎ', 'Backspace', '하', 'Backspace', '한', 'Backspace', '하나']);
    expect(fieldOf(sent())).toBe('한글 하나');
  });

  it('typed faster than the keymap settles, each Backspace waits for the text before it, and the text follows it', async () => {
    const { press, sent, at } = setupField();
    for (const k of ['ㅎ', 'ㅏ', 'ㄴ']) press(k);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual(['ㅎ', 'Backspace', '하', 'Backspace', '한']);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(KEYMAP_SETTLE.key); // after ㅎ's keymap
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(KEYMAP_SETTLE.key); // after 하's
    expect(at[2]! - at[1]!).toBe(0); // the syllable after a Backspace goes at once
  });

  it('in Steam\'s own UI the same, one character per call, the buffer\'s gap between a text\'s characters', async () => {
    const { press, sent, at } = setupField({ status: BUFFERED });
    for (const k of ['ㅎ', 'ㅏ', 'ㄴ', 'ㅏ']) press(k);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent()).toEqual(['ㅎ', 'Backspace', '하', 'Backspace', '한', 'Backspace', '하', '나']);
    expect(fieldOf(sent())).toBe('하나');
    // 하나 is one text, two calls; a Backspace and the text after it are sends of their own, as a pick's are,
    // and Steam's own keyboard sends them back to back.
    expect(at[7]! - at[6]!).toBeGreaterThanOrEqual(BUFFERED_GAP_MS);
  });

  it('⌫ takes jamo off in the field, a compound vowel one part at a time; with nothing composed it is the field\'s own', async () => {
    const { popup, sent, typeAll } = setupField();
    await typeAll('ㄱㅗㅐㄴ');
    expect(fieldOf(sent(), 'ab ')).toBe('ab 괜');
    const mark = sent().length;
    for (let i = 0; i < 4; i++) await tap(popup, 'Backspace');
    expect(sent().slice(mark)).toEqual(['Backspace', '괘', 'Backspace', '고', 'Backspace', 'ㄱ', 'Backspace']);
    expect(fieldOf(sent(), 'ab ')).toBe('ab ');
    await tap(popup, 'Backspace'); // the user's own
    expect(fieldOf(sent(), 'ab ')).toBe('ab');
  });

  // Each of these ends the syllable where it is, in the field: what comes next never deletes it.
  const ends: [string, (t: Field) => Promise<void>][] = [
    ['Space', (t) => tap(t.popup, ' ')],
    ['punctuation', (t) => tap(t.popup, '.')],
    ['Enter', (t) => tap(t.popup, 'Enter')],
    ['an arrow', (t) => tap(t.popup, 'ArrowLeft')],
    ['Paste', (t) => tap(t.popup, 'paste')],
    ['Copy', (t) => tap(t.popup, 'copy')],
    ['한/영 and back', async (t) => { await tap(t.popup, 'mode'); await tap(t.popup, 'mode'); }],
    ['🌐 to another keyboard and back', async (t) => { await tap(t.popup, 'next-keyboard'); await tap(t.popup, 'next-keyboard'); await tap(t.popup, 'next-keyboard'); }],
    ['the emoji picker', async (t) => { await tap(t.popup, 'emoji'); await tap(t.popup, 'abc'); }],
    ['✕ (hide)', (t) => tap(t.popup, 'hide')],
    ['closing and opening the keyboard', async (t) => {
      t.state.status = { ...MINIMAL, bIsOpen: false };
      await vi.advanceTimersByTimeAsync(FIELD_CHECK_MS * 2); // seen at once, not at the next check
      t.state.status = MINIMAL;
      await vi.advanceTimersByTimeAsync(FIELD_CHECK_MS * 2);
    }],
    ['another window (target)', async (t) => { t.state.status = { ...MINIMAL, sOverlayKey: 'gamescope.gamescope-0.window.80' }; }],
    ['Steam moving to another text field', async (t) => { t.manager.OnActiveElementChanged.Dispatch({}); }],
    ['a click in the same field', async (t) => { t.manager.OnActiveElementClicked.Dispatch({}); }],
    ['the popup losing focus', async (t) => { t.popup.document.dispatchEvent(new Event('blur')); }],
    ['the popup hiding', async (t) => {
      Object.defineProperty(t.popup.document, 'visibilityState', { configurable: true, value: 'hidden' });
      t.popup.document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(t.popup.document, 'visibilityState', { configurable: true, value: 'visible' });
    }],
  ];
  for (const [name, end] of ends) {
    it(`${name}: the syllable stays in the field as it is, and the next starts afresh, without a Backspace`, async () => {
      const t = setupField();
      await t.typeAll('ㅎㅏ');
      const mark = t.sent().length;
      await end(t);
      await t.typeAll('ㄴ');
      const after = t.sent().slice(mark);
      expect(after).not.toContain('Backspace');
      expect(after.at(-1)).toBe('ㄴ');
      await tap(t.popup, 'Backspace'); // ⌫ takes ㄴ, and only ㄴ, off
      expect(t.sent().slice(mark).filter((k) => k === 'Backspace')).toHaveLength(1);
    });
  }

  it('a send that fails forgets what is in the field; sends planned before it are skipped, and nothing typed is logged', async () => {
    const { press, sent, failNext, typeAll } = setupField();
    await typeAll('ㅎ');
    failNext(); // ⌫ of ㅏ's retype fails
    press('ㅏ');
    press('ㄴ'); // planned against 하 before the failure is known
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual(['ㅎ']);
    expect(logged.join('\n')).toContain('a send into the field failed');
    await typeAll('ㄱ');
    expect(sent()).toEqual(['ㅎ', 'ㄱ']); // a new syllable, nothing deleted
    expect(logged.join('\n')).not.toMatch(/[ㄱ-ㅣ가-힣]/u);
  });

  it('a picked word keeps the syllables in the field it starts with, then sends the rest and a space', async () => {
    const WORDS: Record<string, string[]> = { 학교: ['학교', '학교에서', '학교를'] };
    const t = setupField({ sidecar: notDesktop((req) => (req.op === 'suggest' ? { ok: true, words: WORDS[req.prefix ?? ''] ?? [] } : undefined)) });
    await t.opened();
    await t.typeAll('ㅎㅏㄱㄱㅛ');
    expect(t.asked.filter((r) => r.op === 'suggest' && !r.prepare).map((r) => r.prefix)).toEqual(['ㅎ', '하', '학', '학ㄱ', '학교']);
    expect([t.sent(), t.pre(), t.cands()]).toEqual([['ㅎ', 'Backspace', '하', 'Backspace', '학', 'ㄱ', 'Backspace', '교'], null, ['학교', '학교에서', '학교를']]);
    await t.pick('학교에서');
    expect(t.sent().slice(8)).toEqual(['에서', ' ']); // 학 and 교, both in the field, stay
    expect(fieldOf(t.sent(), '내 ')).toBe('내 학교에서 ');
    expect(t.cands()).toEqual([]);
  });

  it('in Desktop Mode, where text goes by paste, the syllable waits in the bar as before', async () => {
    const pasted: string[] = [];
    const { popup, sent, pre, typeAll, asked, opened } = setupField({
      sidecar: (req) => {
        if (req.op === 'desktop.focus') return { ok: true, desktop: true };
        if (req.op === 'desktop.prepare') pasted.push(req.text!);
        return req.op === 'desktop.prepare' ? { ok: true } : req.op === 'desktop.wait' ? { ok: true, pasted: true } : undefined;
      },
    });
    expect(asked.filter((r) => r.op === 'desktop.focus')).toHaveLength(1); // asked as the keyboard opened
    await opened();
    await typeAll('ㅎㅏㄴ');
    expect([sent(), pre(), pasted]).toEqual([[], '한', []]);
    await tap(popup, ' ');
    expect([pasted, sent()]).toEqual([['한'], [' ']]);
  });

  it('in a game, once the sidecar has said so, Hangul goes straight in: no paste check before each text; a reopen asks again', async () => {
    const t = setupField({ sidecar: notDesktop() });
    await t.opened();
    await t.typeAll('ㅎㅏㄴ');
    expect(t.sent()).toEqual(['ㅎ', 'Backspace', '하', 'Backspace', '한']);
    const desktopOps = () => t.asked.map((r) => r.op).filter((op) => op.startsWith('desktop.'));
    expect(desktopOps()).toEqual(['desktop.focus']);
    t.state.status = { ...MINIMAL, bIsOpen: false };
    await t.typeAll('ㄱ'); // sees the close
    t.state.status = MINIMAL;
    await t.typeAll('ㄱ'); // and the reopen, which asks where the focus is again
    expect(desktopOps()).toEqual(['desktop.focus', 'desktop.focus']);
  });

  it('until the sidecar says where the focus is, the syllable waits in the bar, then moves into the field', async () => {
    let answer: (() => void) | null = null;
    const t = setupField({ sidecar: () => undefined });
    await t.opened(); // the window it opened on: no desktop there
    // Another window: its answer waits until the test lets it go.
    t.state.status = { ...MINIMAL, sOverlayKey: 'gamescope.gamescope-0.window.90' };
    t.g['polykeyBridge'] = (payload: string) => {
      const req = request(payload);
      const reply = req.op === 'desktop.focus' ? { ok: true, desktop: false } : { ok: false, error: 'unknown-op' };
      const send = () => (t.g[GLOBAL] as PolykeyApi).bridgeReply({ id: req.id, ...reply });
      if (req.op === 'desktop.focus') answer = send;
      else setTimeout(send, 1);
    };
    await t.typeAll('ㅎ');
    expect([t.sent(), t.pre()]).toEqual([[], 'ㅎ']);
    answer!();
    await vi.advanceTimersByTimeAsync(0);
    await t.typeAll('ㅏ');
    expect([t.sent(), t.pre()]).toEqual([['하'], null]);
  });

  it('an answer that does not say where the focus is (unknown, the paste route off) keeps the bar: nothing typed is deleted', async () => {
    for (const error of ['focus-unknown', 'desktop-paste-off']) {
      const prepared: string[] = [];
      const t = setupField({
        sidecar: (req) => {
          if (req.op === 'desktop.prepare') prepared.push(req.text!);
          return req.op === 'desktop.focus' || req.op === 'desktop.prepare' ? { ok: false, error } : undefined;
        },
      });
      await t.opened();
      await t.typeAll('ㅎㅏㄴ');
      expect([t.sent(), t.pre()]).toEqual([[], '한']); // in the bar, not retyped
      await tap(t.popup, ' ');
      expect(prepared).toEqual(['한']); // the paste route tried, and could not say either
      await t.typeAll('ㄱㅡ');
      expect(t.pre()).toBe('그'); // still the bar
      expect(t.sent()).not.toContain('Backspace');
      t.api.uninstall();
    }
  });

  it('a paste that finds no desktop there lets the field be composed in', async () => {
    const t = setupField({
      sidecar: (req) => (req.op === 'desktop.prepare' ? { ok: false, error: 'not-desktop' } : req.op === 'desktop.focus' ? { ok: false, error: 'focus-unknown' } : undefined),
    });
    await t.opened();
    await t.typeAll('ㅎㅏㄴ');
    await tap(t.popup, ' ');
    await t.typeAll('ㄱ');
    expect([t.sent(), t.pre()]).toEqual([['한', ' ', 'ㄱ'], null]); // typed as it is, then into the field
  });

  it('streamed (Steam Link), the bar as before', async () => {
    const { sent, pre, typeAll } = setupField({ status: STREAMED });
    await typeAll('ㅎㅏㄴ');
    expect([sent(), pre()]).toEqual([[], '한']);
  });

  it('Japanese keeps its reading in the bar: its composers do not compose in the field', async () => {
    const { popup, api, sent, typeAll } = setupField();
    api.debug.use('ja/romaji');
    await typeAll('ka');
    expect(sent()).toEqual([]);
    expect(shadowOf(popup)!.querySelector('.comp.on .pre')?.textContent).toBe('か');
  });

  it('says why it forgot a syllable in the field, never what it was', async () => {
    const t = setupField();
    await t.typeAll('ㅎㅏ');
    t.popup.document.dispatchEvent(new Event('blur'));
    await t.typeAll('ㄴ');
    t.manager.OnActiveElementChanged.Dispatch(null);
    t.popup.document.dispatchEvent(new Event('blur')); // nothing in the field: nothing to say
    const said = logged.filter((line) => line.includes('composing in the field'));
    expect(said).toEqual(['[polykey] composing in the field: the keyboard lost focus; what was composed stays as it is',
      '[polykey] composing in the field: a new field; what was composed stays as it is']);
  });

  it('never logs what is typed, the syllable in the field included', async () => {
    const { popup, typeAll } = setupField();
    await typeAll('ㅎㅏㄴㄱㅡㄹ');
    await tap(popup, 'Backspace');
    expect(logged.join('\n')).not.toMatch(/[ㄱ-ㅣ가-힣]/u);
  });
  describe('한자', () => {
    /**
     * A hanja converter on a tiny dictionary, as the sidecar's: from each place the longest word with Hanja,
     * not one inside a longer; the longest, nearest the caret; a resize goes to the word before or after.
     */
    const DICTIONARY: Record<string, [string, string][]> = {
      한국: [['寒國', ''], ['韓國', '대한민국']], 국: [['國', '나라 국'], ['局', '']], 학교: [['學校', '']], 서: [['西', '서녘 서']],
    };
    const hanja = (more: (req: SentRequest) => Record<string, unknown> | undefined = () => undefined) => (req: SentRequest) => {
      if (req.op === 'learn') return { ok: true };
      if (req.op !== 'convert') return more(req);
      const reading = req.reading!;
      const spans: [number, number][] = [];
      for (let start = 0; start < reading.length; start++) {
        let end = 0;
        for (let e = start + 1; e <= reading.length; e++) if (DICTIONARY[reading.slice(start, e)]) end = e;
        if (end && !(spans.length && spans.at(-1)![1] >= end)) spans.push([start, end]);
      }
      if (!spans.length) return { ok: true, segments: [] };
      let [start, end] = spans.reduce((a, b) => (b[1] - b[0] >= a[1] - a[0] ? b : a));
      if (req.lengths && req.resize) {
        const { lengths, resize: [index = 0, by = 0] } = req;
        const from = lengths.slice(0, index).reduce((a, b) => a + b, 0);
        const at = spans.findIndex(([s, e]) => s === from && e === from + (lengths[index] ?? 0));
        if (at >= 0) [start, end] = spans[at + by] ?? spans[at]!;
      }
      const entries = DICTIONARY[reading.slice(start, end)]!;
      return { ok: true, segments: [
        ...(start ? [{ reading: reading.slice(0, start), candidates: [] }] : []),
        { reading: reading.slice(start, end), candidates: entries.map(([value]) => value), notes: entries.map(([, note]) => note) },
        ...(end < reading.length ? [{ reading: reading.slice(end), candidates: [] }] : []),
      ] };
    };
    const shown = (t: Field) => [...shadowOf(t.popup)!.querySelectorAll<HTMLElement>('.comp.on .cand')]
      .map((el) => [el.querySelector('.text')?.textContent ?? el.textContent, el.querySelector('.note')?.textContent ?? '']);
    const segments = (t: Field) => [...shadowOf(t.popup)!.querySelectorAll('.comp.on .pre.converting .seg')].map((el) => el.textContent);
    const tapCandidate = async (t: Field, text: string) => {
      const el = [...shadowOf(t.popup)!.querySelectorAll<HTMLElement>('.cand')].find((c) => (c.querySelector('.text')?.textContent ?? c.textContent) === text)!;
      el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(200);
    };
    const converts = (t: Field) => t.asked.filter((r) => r.op === 'convert');

    it('in a game, converts the word before the caret; the pick deletes its syllables in the field and types the Hanja', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await t.typeAll('ㅎㅏㄴㄱㅜㄱ');
      const mark = t.sent().length;
      expect(fieldOf(t.sent())).toBe('한국');
      await tap(t.popup, 'convert');
      expect(converts(t)).toMatchObject([{ converter: 'hanja', reading: '한국' }]);
      expect(t.sent()).toHaveLength(mark); // the text stays as it is while the candidates show
      expect([segments(t), shown(t)]).toEqual([['寒國'], [['寒國', ''], ['韓國', '대한민국']]]); // the word as picked
      await tapCandidate(t, '韓國');
      expect(t.sent().slice(mark)).toEqual(['Backspace', 'Backspace', '韓國']); // 국 (the composition), then 한
      expect(fieldOf(t.sent())).toBe('韓國');
      expect(t.asked.filter((r) => r.op === 'learn')).toMatchObject([{ converter: 'hanja', reading: '한국', choices: [1], texts: ['韓國'] }]);
      await t.typeAll('ㅇㅓ'); // the word goes on after it
      expect(fieldOf(t.sent())).toBe('韓國어');
      expect(logged.join('\n')).not.toMatch(/[ㄱ-ㅣ가-힣一-龥]/u); // nothing typed or picked is logged
    });

    it('converts the longest word anywhere in the word: 학교에서 gives 學校에서, deleting back to 학 and typing the rest again', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await t.typeAll('ㅎㅏㄱㄱㅛㅇㅔㅅㅓ'); // 학교에서, 서 being composed
      const mark = t.sent().length;
      await tap(t.popup, 'convert');
      expect(converts(t).at(-1)).toMatchObject({ reading: '학교에서' });
      expect([segments(t), shown(t)]).toEqual([['學校', '에서'], [['學校', '']]]);
      await tap(t.popup, 'Enter');
      // 서 (the composition), then 에, 교 and 학; then 學校 and 에, and 서, still being composed.
      expect(t.sent().slice(mark)).toEqual(['Backspace', 'Backspace', 'Backspace', 'Backspace', '學校에', '서']);
      expect(fieldOf(t.sent())).toBe('學校에서');
      await t.typeAll('ㄴ'); // 서 + ㄴ: 선
      expect(fieldOf(t.sent())).toBe('學校에선');
    });

    it('← and → go to the word with Hanja before or after; Space goes on to the next candidate, Enter picks it', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await t.typeAll('ㅎㅏㄱㄱㅛㅇㅔㅅㅓ');
      const mark = t.sent().length;
      await tap(t.popup, 'convert');
      await tap(t.popup, 'ArrowLeft'); // none before 학교
      expect(converts(t).at(-1)).toMatchObject({ reading: '학교에서', lengths: [2, 2], resize: [0, -1] });
      expect(segments(t)).toEqual(['學校', '에서']);
      await tap(t.popup, 'ArrowRight');
      expect([segments(t), shown(t)]).toEqual([['학교에', '西'], [['西', '서녘 서']]]);
      await tap(t.popup, 'ArrowLeft');
      expect(segments(t)).toEqual(['學校', '에서']);
      await tap(t.popup, 'ArrowRight');
      await tap(t.popup, 'Enter'); // 西 for 서, the composition: no Backspace but its own
      expect(t.sent().slice(mark)).toEqual(['Backspace', '西']);
      expect(fieldOf(t.sent())).toBe('학교에西');
    });

    it('of words as long, the one nearest the caret; 오늘한국 converts 한국, and Space goes on', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await t.typeAll('ㅎㅏㄱㄱㅛㅎㅏㄴㄱㅜㄱ'); // 학교한국
      await tap(t.popup, 'convert');
      expect(segments(t)).toEqual(['학교', '寒國']);
      await tap(t.popup, 'Backspace');
      await tap(t.popup, ' ');
      await t.typeAll('ㅇㅗㄴㅡㄹㅎㅏㄴㄱㅜㄱ'); // 오늘한국
      const mark = t.sent().length;
      await tap(t.popup, 'convert');
      expect(segments(t)).toEqual(['오늘', '寒國']);
      await tap(t.popup, ' ');
      expect([segments(t), shadowOf(t.popup)!.querySelector('.cand.sel .text')!.textContent]).toEqual([['오늘', '韓國'], '韓國']);
      await tap(t.popup, 'Enter');
      expect(t.sent().slice(mark)).toEqual(['Backspace', 'Backspace', '韓國']); // 국, the composition, then 한
      expect(fieldOf(t.sent())).toBe('학교한국 오늘韓國');
    });

    it('한자 opens and closes it, marked while open, and Space says 다음 and goes on; ⌫ closes it too; typing ends it, then types', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await t.typeAll('ㅎㅏㄴㄱㅜㄱ');
      const mark = t.sent().length;
      const marked = () => key(t.popup, 'convert').classList.contains('on');
      const space = () => key(t.popup, ' ').querySelector('.lbl')!.textContent;
      expect([marked(), space()]).toEqual([false, 'Space']);
      await tap(t.popup, 'convert');
      expect([marked(), space()]).toEqual([true, '다음']);
      await tap(t.popup, ' ');
      expect(shadowOf(t.popup)!.querySelector('.cand.sel .text')!.textContent).toBe('韓國');
      // The composition shows the word as picked, focused; the field is untouched until a pick.
      expect([segments(t), shadowOf(t.popup)!.querySelector('.pre .seg.focus')!.textContent, t.sent().slice(mark)]).toEqual([['韓國'], '韓國', []]);
      await tap(t.popup, 'convert'); // closed, the text as it was
      expect([t.sent().slice(mark), shown(t), marked(), space()]).toEqual([[], [], false, 'Space']);
      await tap(t.popup, 'convert'); // and open again, from the first candidate
      expect(shadowOf(t.popup)!.querySelector('.cand.sel')!.textContent).toBe('寒國');
      await tap(t.popup, 'Backspace');
      expect([t.sent().slice(mark), shown(t), marked(), space()]).toEqual([[], [], false, 'Space']);
      await tap(t.popup, 'convert');
      await t.typeAll('ㅇ');
      expect(t.sent().slice(mark)).toEqual(['ㅇ']); // 국 stays, ㅇ starts the next syllable
      expect([fieldOf(t.sent()), marked()]).toEqual(['한국ㅇ', false]);
      await tap(t.popup, 'convert'); // 한국 is still in the word
      expect(segments(t)).toEqual(['寒國', 'ㅇ']);
      await tap(t.popup, 'Backspace');
      await tap(t.popup, ' ');
      await t.typeAll('ㅇㅓ'); // 어: no word with Hanja, so 한자 does nothing
      await tap(t.popup, 'convert');
      await tap(t.popup, 'convert');
      expect([marked(), shown(t), fieldOf(t.sent())]).toEqual([false, [], '한국ㅇ 어']);
    });

    for (const [name, change] of [
      ['Steam moving to another text field', (t: Field) => t.manager.OnActiveElementChanged.Dispatch({})],
      ['a click in the field', (t: Field) => t.manager.OnActiveElementClicked.Dispatch({})],
      ['the popup losing focus', (t: Field) => t.popup.document.dispatchEvent(new Event('blur'))],
    ] as const) {
      it(`${name} ends it, with no Backspace: its candidates go`, async () => {
        const t = setupField({ sidecar: notDesktop(hanja()) });
        await t.opened();
        await t.typeAll('ㅎㅏㄴㄱㅜㄱ');
        await tap(t.popup, 'convert');
        const mark = t.sent().length;
        change(t);
        await vi.advanceTimersByTimeAsync(200);
        expect(shown(t)).toEqual([]);
        await tap(t.popup, 'Enter'); // Enter as itself
        await t.typeAll('ㄱ');
        expect(t.sent().slice(mark)).toEqual(['Enter', 'ㄱ']);
      });
    }

    it('in Desktop Mode the word waits in the bar: the pick replaces it there and nothing is sent until Space', async () => {
      const pasted: string[] = [];
      const t = setupField({
        sidecar: hanja((req) => {
          if (req.op === 'desktop.focus') return { ok: true, desktop: true };
          if (req.op === 'desktop.prepare') pasted.push(req.text!);
          return req.op === 'desktop.prepare' ? { ok: true } : req.op === 'desktop.wait' ? { ok: true, pasted: true } : undefined;
        }),
      });
      await t.opened();
      await t.typeAll('ㅎㅏㄴㄱㅜㄱ');
      expect(t.pre()).toBe('한국');
      await tap(t.popup, 'convert');
      expect(converts(t)).toMatchObject([{ reading: '한국' }]);
      await tapCandidate(t, '韓國');
      expect([t.sent(), pasted, t.pre()]).toEqual([[], [], '韓國']);
      await tap(t.popup, ' ');
      expect(pasted).toEqual(['韓國']);
      expect(t.sent()).toEqual([' ']);
      // A word inside: replaced in the bar, what follows it kept, and 서 still being composed.
      await t.typeAll('ㅎㅏㄱㄱㅛㅇㅔㅅㅓ');
      await tap(t.popup, 'convert');
      await tap(t.popup, 'Enter');
      expect([t.sent(), pasted, t.pre()]).toEqual([[' '], ['韓國'], '學校에서']);
      await t.typeAll('ㄴ');
      expect(t.pre()).toBe('學校에선');
      await tap(t.popup, ' ');
      expect(pasted).toEqual(['韓國', '學校에선']);
    });

    it('after a Hanja the word starts again: 學校 then 에 suggests for 에, a pick replaces only 에, and 한자 asks about 에', async () => {
      const WORDS: Record<string, string[]> = { 에: ['에서', '에게'] };
      const suggest = (req: SentRequest) => (req.op === 'suggest' ? { ok: true, words: WORDS[req.prefix ?? ''] ?? [] } : undefined);
      const t = setupField({ sidecar: notDesktop(hanja(suggest)) });
      await t.opened();
      await t.typeAll('ㅎㅏㄱㄱㅛ');
      await tap(t.popup, 'convert');
      await tap(t.popup, 'Enter'); // 學校
      await t.typeAll('ㅇㅔ');
      expect(t.asked.filter((r) => r.op === 'suggest' && !r.prepare).at(-1)!.prefix).toBe('에');
      expect(t.cands()).toEqual(['에서', '에게']);
      await tap(t.popup, 'convert');
      expect(converts(t).at(-1)).toMatchObject({ reading: '에' });
      await tap(t.popup, 'convert'); // closed
      const mark = t.sent().length;
      await t.pick('에서');
      expect(t.sent().slice(mark)).toEqual(['서', ' ']); // 에 stays, and 學校 before it
      expect(fieldOf(t.sent())).toBe('學校에서 ');
    });

    it('in Desktop Mode too: with 學校 waiting in the bar, a pick for 에 keeps it and sends the word whole', async () => {
      const pasted: string[] = [];
      const t = setupField({
        sidecar: hanja((req) => {
          if (req.op === 'suggest') return { ok: true, words: req.prefix === '에' ? ['에서'] : [] };
          if (req.op === 'desktop.focus') return { ok: true, desktop: true };
          if (req.op === 'desktop.prepare') pasted.push(req.text!);
          return req.op === 'desktop.prepare' ? { ok: true } : req.op === 'desktop.wait' ? { ok: true, pasted: true } : undefined;
        }),
      });
      await t.opened();
      await t.typeAll('ㅎㅏㄱㄱㅛ');
      await tap(t.popup, 'convert');
      await tap(t.popup, 'Enter');
      await t.typeAll('ㅇㅔ');
      expect([t.pre(), t.cands()]).toEqual(['學校에', ['에서']]);
      await t.pick('에서');
      expect([pasted, t.sent()]).toEqual([['學校에서 '], []]);
    });

    it('in ABC, 한자 does nothing: the English word stays in the bar', async () => {
      const t = setupField({ sidecar: notDesktop(hanja()) });
      await t.opened();
      await tap(t.popup, 'mode');
      await t.typeAll('hi');
      await tap(t.popup, 'convert');
      expect([t.sent(), t.pre(), converts(t)]).toEqual([[], 'hi', []]);
    });

    it('without the dictionary it warns once, and typing goes on as before', async () => {
      const t = setupField({ sidecar: notDesktop((req) => (req.op === 'convert' ? { ok: false, error: 'unavailable' } : undefined)) });
      await t.opened();
      await t.typeAll('ㅎㅏㄴ');
      await tap(t.popup, 'convert');
      await tap(t.popup, 'convert');
      await t.typeAll('ㄱㅜㄱ');
      expect(fieldOf(t.sent())).toBe('한국');
      expect(logged.filter((line) => line.includes('conversion unavailable'))).toEqual([
        '[polykey] conversion unavailable (hanja did not load); what is typed is still sent as it is']);
    });
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
