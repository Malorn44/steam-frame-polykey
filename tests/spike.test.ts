// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_ID } from '../src/host/steam/popup.js';
import { CHECK_MS, GLOBAL, PREREQ_RETRY_MS, PREREQ_TIMEOUT_MS, installSpike, type SpikeApi } from '../src/spike.js';
import { BUFFERED, MINIMAL, fakeManager, fakePopupWindow, fakeSteam, type FakePopupWindow } from './fake-steam.js';

const TEST_TEXT = 'テスト';

const boxIn = (popup: FakePopupWindow, route: 'text' | 'paste' = 'text'): HTMLElement | null =>
  popup.document.getElementById(SURFACE_ID)?.shadowRoot?.querySelector<HTMLElement>(`.box[data-route="${route}"]`) ?? null;

const touch = (el: HTMLElement): void => {
  el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
};

let logged: string[];
let installed: SpikeApi[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  installed = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
});

afterEach(() => {
  for (const api of installed) api.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const install = (g: Record<string, unknown>): SpikeApi => {
  const api = installSpike(g);
  installed.push(api);
  return api;
};

describe('when Steam objects are missing', () => {
  it('does nothing at all, then gives up and stays inactive', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    const { g } = fakeSteam({ popup, managers: [] });
    const api = install(g);
    expect(api.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(PREREQ_TIMEOUT_MS + PREREQ_RETRY_MS);
    expect(api.state).toBe('inactive');
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    expect(manager.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(logged.some((l) => l.includes('missing Steam objects'))).toBe(true);
  });

  it('starts once they appear', async () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup, popupManager: false });
    const api = install(g);
    expect(api.state).toBe('waiting');
    Object.assign(g, fakeSteam({ popup }).g);
    await vi.advanceTimersByTimeAsync(PREREQ_RETRY_MS);
    expect(api.state).toBe('running');
    expect(boxIn(popup)).not.toBeNull();
  });
});

describe('when everything is present', () => {
  it('draws the box in the keyboard popup', () => {
    const popup = fakePopupWindow();
    const api = install(fakeSteam({ popup, status: MINIMAL }).g);
    expect(api.state).toBe('running');
    expect(boxIn(popup)?.textContent).toContain(TEST_TEXT);
  });

  it('waits for the popup and mounts once it exists', async () => {
    const { g, state } = fakeSteam();
    install(g);
    const popup = fakePopupWindow();
    state.popup = popup;
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(boxIn(popup)).not.toBeNull();
  });

  it('a tap in minimal mode sends テスト as one call', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    install(fakeSteam({ popup, managers: [manager], status: MINIMAL }).g);
    touch(boxIn(popup)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.calls).toEqual([[TEST_TEXT, false]]);
  });

  it('a tap in buffered mode sends one character per call, spaced', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    install(fakeSteam({ popup, managers: [manager], status: BUFFERED }).g);
    touch(boxIn(popup)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.calls.map(([k]) => k)).toEqual(['テ']);
    await vi.advanceTimersByTimeAsync(80);
    expect(manager.calls.map(([k]) => k)).toEqual(['テ', 'ス', 'ト']);
  });

  it('without the status store, sends one character per call', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    install(fakeSteam({ popup, managers: [manager] }).g);
    boxIn(popup)!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.calls.map(([k]) => k)).toEqual(['テ', 'ス', 'ト']);
  });

  it('sends to the manager the VR keyboard is typing for', async () => {
    const popup = fakePopupWindow();
    const other = fakeManager();
    const typingFor = fakeManager(true);
    install(fakeSteam({ popup, managers: [other, typingFor], status: MINIMAL }).g);
    touch(boxIn(popup)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(other.calls).toEqual([]);
    expect(typingFor.calls).toEqual([[TEST_TEXT, false]]);
  });

  it('debug.split overrides the policy', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    const api = install(fakeSteam({ popup, managers: [manager], status: BUFFERED }).g);
    expect(api.debug.split('run')).toBe('split=run');
    await api.debug.tap();
    expect(manager.calls).toEqual([[TEST_TEXT, false]]);
    expect(api.debug.split('nonsense' as never)).toContain('unknown split');
  });

  it('a touch does not also count as a click', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    install(fakeSteam({ popup, managers: [manager], status: MINIMAL }).g);
    const box = boxIn(popup)!;
    touch(box);
    box.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.calls).toHaveLength(1);
  });

  it('moves the box when the popup is recreated', async () => {
    const first = fakePopupWindow();
    const { g, state } = fakeSteam({ popup: first });
    install(g);
    const second = fakePopupWindow();
    state.popup = second;
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(first.document.getElementById(SURFACE_ID)).toBeNull();
    expect(boxIn(second)).not.toBeNull();
  });
});

describe('📋 box (paste into KDE Desktop, spike 1c)', () => {
  type Request = { id: number; op: string; text?: string; timeoutMs?: number };

  /** A fake sidecar behind the polykeyBridge binding; `answer` decides each reply. */
  const fakeSidecar = (g: Record<string, unknown>, answer: (req: Request) => Record<string, unknown> | null) => {
    const requests: Request[] = [];
    g['polykeyBridge'] = (payload: string) => {
      const req = JSON.parse(payload) as Request;
      requests.push(req);
      const reply = answer(req);
      if (reply) setTimeout(() => (g[GLOBAL] as SpikeApi).bridgeReply({ id: req.id, ...reply }), 1);
    };
    return requests;
  };
  const happy = (req: Request) => (req.op === 'desktop.prepare' ? { ok: true } : { ok: true, pasted: true });

  it('prepares the clipboard, presses Shift+Insert, waits, and never logs the text', async () => {
    const popup = fakePopupWindow();
    const manager = fakeManager();
    const { g, state } = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
    const requests = fakeSidecar(g, happy);
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.map((r) => r.op)).toEqual(['desktop.prepare', 'desktop.wait']);
    expect(requests[0]!.text).toBe(TEST_TEXT);
    expect(state.keyEvents).toEqual([[101, true], [73, true], [73, false], [101, false]]);
    expect(manager.calls).toEqual([]);
    expect(boxIn(popup, 'paste')!.classList.contains('ok')).toBe(true);
    expect(logged.some((l) => l.includes('tap paste(touch): sent'))).toBe(true);
    for (const line of logged) expect(line).not.toMatch(/[テスト]/);
  });

  it('presses nothing when the sidecar refuses (focus is not the desktop)', async () => {
    const popup = fakePopupWindow();
    const { g, state } = fakeSteam({ popup, status: MINIMAL, keyState: true });
    const requests = fakeSidecar(g, () => ({ ok: false, error: 'not-desktop' }));
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.map((r) => r.op)).toEqual(['desktop.prepare']);
    expect(state.keyEvents).toEqual([]);
    expect(boxIn(popup, 'paste')!.classList.contains('fail')).toBe(true);
    expect(logged.some((l) => l.includes('error=not-desktop'))).toBe(true);
  });

  it('fails cleanly without the sidecar bridge', async () => {
    const popup = fakePopupWindow();
    const { g, state } = fakeSteam({ popup, status: MINIMAL, keyState: true });
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.keyEvents).toEqual([]);
    expect(logged.some((l) => l.includes('error=no-bridge'))).toBe(true);
  });

  it('times out when the sidecar does not answer', async () => {
    const popup = fakePopupWindow();
    const { g, state } = fakeSteam({ popup, status: MINIMAL, keyState: true });
    fakeSidecar(g, () => null);
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(3500);
    expect(state.keyEvents).toEqual([]);
    expect(logged.some((l) => l.includes('error=timeout'))).toBe(true);
  });

  it('reports when no app fetched the text', async () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup, status: MINIMAL, keyState: true });
    fakeSidecar(g, (req) => (req.op === 'desktop.prepare' ? { ok: true } : { ok: true, pasted: false }));
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(500);
    expect(logged.some((l) => l.includes('error=not-pasted'))).toBe(true);
  });

  it('still asks the sidecar to restore when the key presses fail', async () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup, status: MINIMAL }); // no key-state call
    const requests = fakeSidecar(g, happy);
    install(g);
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.map((r) => r.op)).toEqual(['desktop.prepare', 'desktop.wait']);
    expect(requests[1]!.timeoutMs).toBe(0);
    expect(logged.some((l) => l.includes('error=no-key-state-call'))).toBe(true);
  });

  it('debug.pasteChord switches the chord', async () => {
    const popup = fakePopupWindow();
    const { g, state } = fakeSteam({ popup, status: MINIMAL, keyState: true });
    fakeSidecar(g, happy);
    const api = install(g);
    expect(api.debug.pasteChord('ctrl-shift-v')).toBe('paste chord=ctrl-shift-v');
    expect(api.debug.pasteChord('alt-f4' as never)).toContain('unknown chord');
    touch(boxIn(popup, 'paste')!);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.keyEvents).toEqual([[103, true], [101, true], [25, true], [25, false], [101, false], [103, false]]);
  });
});

describe('next to frame-jp-keyboard', () => {
  it('does not draw while fjk is active, and draws once it is gone', async () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup });
    const fjk = { version: '0.9.3', state: 'running', enabled: true };
    g['__fjk'] = fjk;
    const api = install(g);
    expect(api.state).toBe('blocked');
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    fjk.state = 'uninstalled';
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(api.state).toBe('running');
    expect(boxIn(popup)).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('re-injection replaces the previous instance', () => {
    const popup = fakePopupWindow();
    const { g } = fakeSteam({ popup });
    const first = install(g);
    const second = install(g);
    expect(first.state).toBe('uninstalled');
    expect(g[GLOBAL]).toBe(second);
    expect(popup.document.querySelectorAll(`#${SURFACE_ID}`)).toHaveLength(1);
  });

  it('uninstall removes the box and every timer', async () => {
    const popup = fakePopupWindow();
    const api = install(fakeSteam({ popup, status: MINIMAL }).g);
    touch(boxIn(popup)!);
    await vi.advanceTimersByTimeAsync(0);
    api.uninstall();
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('privacy', () => {
  it('never logs the text it sends', async () => {
    const popup = fakePopupWindow();
    const api = install(fakeSteam({ popup, status: BUFFERED }).g);
    touch(boxIn(popup)!);
    await vi.advanceTimersByTimeAsync(200);
    const debugTap = api.debug.tap();
    await vi.advanceTimersByTimeAsync(200);
    await debugTap;
    expect(logged.some((l) => l.includes('tap text(touch): sent'))).toBe(true);
    expect(logged.some((l) => l.includes('tap text(debug): sent'))).toBe(true);
    for (const line of logged) {
      expect(line).not.toMatch(/[テスト]/);
    }
  });
});
