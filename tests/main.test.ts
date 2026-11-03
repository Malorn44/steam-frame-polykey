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

  it('🌐 switches to the stock keyboard and back', async () => {
    const { popup } = setup();
    await tap(popup, 'next-keyboard');
    expect(shadowOf(popup)!.querySelector('.kb')).toBeNull();
    expect(popup.document.getElementById('polykey-stock-guard')).toBeNull();
    const back = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('div')].find((el) => el.textContent === '🌐 polykey')!;
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
      asked.push(req.prefix);
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
