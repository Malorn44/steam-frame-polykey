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

  it('🌐 rotates polykey\'s keyboards only; settings hands over to Steam\'s keyboard, with a way back', async () => {
    const { popup } = setup();
    await tap(popup, 'next-keyboard');
    expect(key(popup, 'あ')).toBeDefined(); // the 12-key
    await tap(popup, 'next-keyboard');
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5); // English again, not Steam's
    await tap(popup, 'settings');
    const stockButton = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .opt')].find((o) => o.textContent === 'Steam keyboard')!;
    stockButton.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    stockButton.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
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
    await pick(popup, 'Night Owl');
    expect(saved).toEqual([{ theme: 'themes/night-owl' }]);
    expect(shadowOf(popup)!.querySelector<HTMLElement>('.panel')!.style.getPropertyValue('--surface').trim()).toBe('#011627');
    await pick(popup, 'Off', 0); // haptics off
    expect(saved).toEqual([{ theme: 'themes/night-owl' }, { haptics: false }]);
    const before = haptics.length;
    const close = shadowOf(popup)!.querySelector<HTMLElement>('.panel .opt.close')!;
    close.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    close.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(shadowOf(popup)!.querySelectorAll('.row')).toHaveLength(5); // the keys are back
    await tap(popup, 'q');
    expect(haptics.length).toBe(before); // no tick with haptics off
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
    expect(asked).toEqual([]);
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
    hint: shadowOf(popup)!.querySelector('.comp.on .hint')?.textContent ?? null,
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
    expect(bar(popup).hint).toBe('入力すると、ここに変換候補が出ます'); // on top, too
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

  it('with "Next kana" chosen in settings, tapping again cycles in the buffer, and the choice is saved', async () => {
    const { popup, manager, g } = setup();
    const { saved } = withConverter(g);
    await tap(popup, 'next-keyboard');
    await tap(popup, 'settings');
    const opt = [...shadowOf(popup)!.querySelectorAll<HTMLElement>('.panel .opt')].find((o) => o.textContent === 'Next kana (→ moves on)')!;
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
