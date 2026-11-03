// Milestone 1 spike: two boxes in Steam's keyboard popup.
//   text   テスト through HandleVirtualKeyDown (works in Steam UI and gamescope apps)
//   paste  テスト via the KDE desktop clipboard + Shift+Insert (Desktop Mode, where text gives "123")
// Fails safe: does nothing while required Steam objects are missing or fjk is active; never logs text.

import { createBridge } from './bridge/client.js';
import { PASTE_CHORDS, PASTE_CHORD_NAMES, type PasteChord } from './core/output/chords.js';
import { chooseDelivery, graphemes, type SplitSetting } from './core/output/plan.js';
import { getKeyboardManagers, getKeyboardPopupWindow, pickKeyboardManager, type SteamGlobals } from './host/steam/globals.js';
import { classifyTarget, describeStatus, findStatusStore, keyboardMode, readStatus, type StatusStore } from './host/steam/diag.js';
import { createKeySender, getSetKeyState } from './host/steam/keys.js';
import { fjkActive, otherKeyboards } from './host/steam/others.js';
import { createOutput } from './host/steam/output.js';
import { mountSurface, type Surface } from './host/steam/popup.js';
import { missingPrerequisites } from './host/steam/probe.js';
import { log, warn } from './log.js';

declare const __POLYKEY_VERSION__: string;
export const VERSION: string = typeof __POLYKEY_VERSION__ === 'string' ? __POLYKEY_VERSION__ : 'dev';

export const GLOBAL = '__polykey';
/** Popup and open-state check while running; also picks up a recreated popup. */
export const CHECK_MS = 5000;
export const PREREQ_RETRY_MS = 1000;
export const PREREQ_TIMEOUT_MS = 120_000;
/** Gap between key events (TaiKeid: IBus reorders keys sent with no gap). */
export const KEY_GAP_MS = 8;
const TEST_TEXT = 'テスト';
const TOUCH_MOUSE_GUARD_MS = 600;
const FEEDBACK_MS = 1500;
const SPLIT_SETTINGS: readonly SplitSetting[] = ['auto', 'run', 'chars'];

export type SpikeState = 'starting' | 'waiting' | 'blocked' | 'running' | 'inactive' | 'uninstalled';
export type Route = 'text' | 'paste';

export interface SpikeApi {
  readonly version: string;
  state: SpikeState;
  uninstall(): void;
  /** The sidecar answers bridge requests through this. */
  bridgeReply(reply: unknown): void;
  readonly debug: {
    /** Force a split policy ('auto' | 'run' | 'chars') and optionally the gap between calls. */
    split(setting: SplitSetting, gapMs?: number): string;
    /** Gap between paste-chord key events (default KEY_GAP_MS). */
    keyGap(ms: number): string;
    /** Paste chord for the 📋 box: 'shift-insert' (default) | 'ctrl-v' | 'ctrl-shift-v'. */
    pasteChord(name: PasteChord): string;
    /** One line: keyboard status, popup size and visibility, spike state. */
    status(): string;
    /** Send テスト as if a box were tapped (it goes to whatever has focus). */
    tap(route?: Route): Promise<string>;
  };
}

interface Outcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly error?: string;
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const BOX_CSS = `
.box {
  position: fixed; bottom: 53px; width: 210px; height: 64px; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  background: #f78c6c; color: #011627; border: 2px solid #011627; border-radius: 12px;
  font: 600 20px/1.2 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
}
.box[data-route="text"] { left: 12px; }
.box[data-route="paste"] { left: 234px; background: #21c7a8; }
.box.down { filter: brightness(0.8); transform: scale(0.97); }
.box.ok { background: #addb67; }
.box.fail { background: #ef5350; color: #fff; }
.hint { font-size: 12px; font-weight: 500; opacity: 0.85; }
`;

const BOXES: readonly { route: Route; title: string; hint: string }[] = [
  { route: 'text', title: `polykey → ${TEST_TEXT}`, hint: 'tap to send' },
  { route: 'paste', title: `📋 → ${TEST_TEXT}`, hint: 'for KDE Desktop' },
];

export const installSpike = (g: SteamGlobals = globalThis as unknown as SteamGlobals): SpikeApi => {
  const previous = g[GLOBAL] as Partial<SpikeApi> | undefined;
  if (previous && typeof previous.uninstall === 'function') {
    try {
      previous.uninstall();
    } catch (error) {
      warn('previous instance failed to uninstall:', errorKind(error));
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const feedbackTimers = new Map<Route, ReturnType<typeof setTimeout>>();
  const boxes = new Map<Route, { el: HTMLElement; hint: HTMLElement; idle: string }>();
  let surface: Surface | null = null;
  let removeListeners: (() => void) | null = null;
  let statusStore: StatusStore | null = null;
  let splitSetting: SplitSetting = 'auto';
  let gapOverrideMs: number | undefined;
  let keyGapMs = KEY_GAP_MS;
  let pasteChord: PasteChord = 'shift-insert';
  let lastStateLine = '';
  let waitingSince = 0;
  let wasOpen = false;

  const output = createOutput({
    getManager: () => pickKeyboardManager(g),
    getDelivery: () => chooseDelivery(keyboardMode(readStatus(statusStore)), splitSetting, gapOverrideMs),
  });
  const keys = createKeySender({ getSetKeyState: () => getSetKeyState(g) });
  const bridge = createBridge(g);

  const stopTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const startTimer = (fn: () => void, ms: number): void => {
    stopTimer();
    timer = setInterval(fn, ms);
  };

  const stateLine = (): string => {
    const status = statusStore ? readStatus(statusStore) : null;
    const popup = surface ? `${surface.win.innerWidth}x${surface.win.innerHeight}` : '-';
    const visibility = surface ? surface.doc.visibilityState : 'no-popup';
    return `${describeStatus(status)} popup=${popup} visibility=${visibility}`;
  };
  const onStateMaybeChanged = (): void => {
    const open = readStatus(statusStore)?.bIsOpen === true;
    if (wasOpen && !open) keys.releaseAll(); // closing must never leave a key held
    wasOpen = open;
    const line = stateLine();
    if (line === lastStateLine) return;
    lastStateLine = line;
    log(`keyboard: ${line}`);
  };

  const managerInfo = (): string => {
    const managers = getKeyboardManagers(g);
    const picked = pickKeyboardManager(g);
    const index = picked ? managers.indexOf(picked) : -1;
    const override = typeof picked?.m_fnVROnTextEnteredOverride === 'function';
    return `#${index}/${managers.length} override=${override}`;
  };

  const clearFeedback = (): void => {
    for (const id of feedbackTimers.values()) clearTimeout(id);
    feedbackTimers.clear();
  };
  const showFeedback = (route: Route, outcome: Outcome): void => {
    const box = boxes.get(route);
    if (!box) return;
    const pending = feedbackTimers.get(route);
    if (pending !== undefined) clearTimeout(pending);
    box.el.classList.remove('ok', 'fail');
    box.el.classList.add(outcome.ok ? 'ok' : 'fail');
    box.hint.textContent = outcome.ok ? `sent ✓ (${outcome.detail})` : `failed: ${outcome.error ?? '?'}`;
    feedbackTimers.set(route, setTimeout(() => {
      feedbackTimers.delete(route);
      box.el.classList.remove('ok', 'fail');
      box.hint.textContent = box.idle;
    }, FEEDBACK_MS));
  };

  /** Text through HandleVirtualKeyDown. */
  const sendText = async (): Promise<Outcome & { split: string }> => {
    const result = await output([{ text: TEST_TEXT }]);
    return {
      ok: result.ok,
      detail: `${result.calls} call${result.calls === 1 ? '' : 's'}`,
      split: `split=${result.delivery.policy} gap=${result.delivery.gapMs}ms setting=${splitSetting}`,
      ...(result.error ? { error: result.error } : {}),
    };
  };

  /** Paste into Desktop Mode; the sidecar refuses unless the nested desktop has focus. */
  const sendPaste = async (): Promise<Outcome> => {
    const prepared = await bridge.call('desktop.prepare', { text: TEST_TEXT });
    if (!prepared.ok) {
      const process = typeof prepared['process'] === 'string' && prepared['process'] ? ` focused=${prepared['process']}` : '';
      return { ok: false, detail: '', error: `${prepared.error ?? 'prepare-failed'}${process}` };
    }
    const pressed = await keys.send(PASTE_CHORDS[pasteChord], keyGapMs);
    // Always ask: wait() is also what puts the previous clipboard back.
    const done = await bridge.call('desktop.wait', { timeoutMs: pressed.ok ? 2000 : 0 }, 4000);
    if (!pressed.ok) return { ok: false, detail: '', error: pressed.error ?? 'keys-failed' };
    if (!done.ok) return { ok: false, detail: '', error: done.error ?? 'wait-failed' };
    return done['pasted'] === true
      ? { ok: true, detail: `pasted, ${pasteChord}` }
      : { ok: false, detail: pasteChord, error: 'not-pasted' };
  };

  const tap = async (route: Route, source: 'touch' | 'mouse' | 'debug'): Promise<string> => {
    const status = readStatus(statusStore);
    let outcome: Outcome;
    let extra = '';
    if (route === 'text') {
      const result = await sendText();
      outcome = result;
      extra = result.split;
    } else {
      outcome = await sendPaste();
      extra = `chord=${pasteChord} gap=${keyGapMs}ms`;
    }
    const line = [
      `tap ${route}(${source}): ${outcome.ok ? 'sent' : 'failed'}`,
      `${graphemes(TEST_TEXT).length} graphemes, ${outcome.detail || '-'}`,
      extra,
      `mode=${keyboardMode(status)} target=${classifyTarget(status)} manager=${managerInfo()}`,
      ...(outcome.error ? [`error=${outcome.error}`] : []),
    ].join(', ');
    log(line);
    showFeedback(route, outcome);
    return line;
  };

  const drawBoxes = (s: Surface): void => {
    const style = s.doc.createElement('style');
    style.textContent = BOX_CSS;
    s.shadow.append(style);
    for (const spec of BOXES) {
      const el = s.doc.createElement('div');
      el.className = 'box';
      el.dataset['route'] = spec.route;
      el.setAttribute('role', 'button');
      const title = s.doc.createElement('div');
      title.textContent = spec.title;
      const hint = s.doc.createElement('div');
      hint.className = 'hint';
      hint.textContent = spec.hint;
      el.append(title, hint);

      // The VR laser arrives as touch events; mouse clicks are the desktop fallback.
      let pressed = false;
      let lastTouchAt = -Infinity;
      const swallow = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      el.addEventListener('touchstart', (e) => {
        swallow(e);
        pressed = true;
        el.classList.add('down');
      }, { passive: false });
      el.addEventListener('touchmove', swallow, { passive: false });
      el.addEventListener('touchend', (e) => {
        swallow(e);
        lastTouchAt = Date.now();
        el.classList.remove('down');
        if (!pressed) return;
        pressed = false;
        void tap(spec.route, 'touch');
      }, { passive: false });
      el.addEventListener('touchcancel', (e) => {
        e.stopPropagation();
        pressed = false;
        el.classList.remove('down');
      });
      el.addEventListener('mousedown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        swallow(e);
        if (Date.now() - lastTouchAt < TOUCH_MOUSE_GUARD_MS) return;
        void tap(spec.route, 'mouse');
      });

      s.shadow.append(el);
      boxes.set(spec.route, { el, hint, idle: spec.hint });
    }
  };

  const unmount = (): void => {
    removeListeners?.();
    removeListeners = null;
    clearFeedback();
    surface?.destroy();
    surface = null;
    boxes.clear();
  };

  const mount = (win: Window): void => {
    const s = mountSurface(win);
    surface = s;
    drawBoxes(s);
    const onVisibility = (): void => onStateMaybeChanged();
    s.doc.addEventListener('visibilitychange', onVisibility);
    removeListeners = () => s.doc.removeEventListener('visibilitychange', onVisibility);
    log(`boxes mounted in keyboard popup (${win.innerWidth}x${win.innerHeight}); key-state call ${getSetKeyState(g) ? 'present' : 'missing'}, sidecar bridge ${bridge.available() ? 'present' : 'missing'}`);
    onStateMaybeChanged();
  };

  /** Keep the boxes in the current popup; runs every CHECK_MS and on demand. */
  const ensureMounted = (): void => {
    try {
      if (fjkActive(g)) {
        if (surface) unmount();
        if (api.state !== 'blocked') {
          api.state = 'blocked';
          log('frame-jp-keyboard is active, so the boxes are not drawn. Stop it with `systemctl --user stop frame-jp-keyboard`, then `__fjk.uninstall()`.');
        }
        return;
      }
      if (api.state === 'blocked') {
        api.state = 'running';
        log('frame-jp-keyboard is gone; drawing the boxes');
      }
      const win = getKeyboardPopupWindow(g);
      // Compare documents, not windows: the document is what changes when Steam recreates the popup.
      if (surface && (surface.doc !== win?.document || !surface.isLive())) {
        unmount();
        log('keyboard popup changed; boxes removed');
      }
      if (!surface && win?.document?.body) mount(win);
      if (surface) onStateMaybeChanged();
    } catch (error) {
      warn('check failed:', errorKind(error));
    }
  };

  /** True once every required Steam object exists and the spike is running. */
  const tryRun = (): boolean => {
    if (missingPrerequisites(g).length > 0) return false;
    statusStore = findStatusStore(g);
    log(statusStore
      ? 'VR keyboard status found; diagnostics on'
      : 'VR keyboard status not found; diagnostics off (mode unknown, so one character per call)');
    api.state = 'running';
    startTimer(ensureMounted, CHECK_MS);
    ensureMounted();
    log(`running ${VERSION}`);
    return true;
  };

  const start = (): void => {
    const others = otherKeyboards(g);
    if (others.length) log(`other keyboards in Steam: ${others.join('; ')}`);
    if (tryRun()) return;
    api.state = 'waiting';
    waitingSince = Date.now();
    log(`waiting for Steam objects: ${missingPrerequisites(g).join(', ')}`);
    startTimer(() => {
      if (tryRun()) return;
      if (Date.now() - waitingSince < PREREQ_TIMEOUT_MS) return;
      stopTimer();
      api.state = 'inactive';
      warn(`missing Steam objects: ${missingPrerequisites(g).join(', ')}; doing nothing and leaving the stock keyboard alone`);
    }, PREREQ_RETRY_MS);
  };

  const uninstall = (): void => {
    stopTimer();
    keys.releaseAll();
    bridge.close();
    unmount();
    api.state = 'uninstalled';
    log(`uninstalled ${VERSION}`);
  };

  const api: SpikeApi = {
    version: VERSION,
    state: 'starting',
    uninstall,
    bridgeReply: (reply) => bridge.receive(reply),
    debug: {
      split: (setting, gapMs) => {
        if (!SPLIT_SETTINGS.includes(setting)) return `unknown split "${String(setting)}"; use ${SPLIT_SETTINGS.join(', ')}`;
        splitSetting = setting;
        gapOverrideMs = typeof gapMs === 'number' && Number.isFinite(gapMs) ? Math.max(0, gapMs) : undefined;
        const line = `split=${setting}${gapOverrideMs !== undefined ? ` gap=${gapOverrideMs}ms` : ''}`;
        log(`debug: ${line}`);
        return line;
      },
      keyGap: (ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 200) return 'keyGap takes 0..200 ms';
        keyGapMs = ms;
        log(`debug: key gap=${ms}ms`);
        return `key gap=${ms}ms`;
      },
      pasteChord: (name) => {
        if (!PASTE_CHORD_NAMES.includes(name)) return `unknown chord "${String(name)}"; use ${PASTE_CHORD_NAMES.join(', ')}`;
        pasteChord = name;
        log(`debug: paste chord=${name}`);
        return `paste chord=${name}`;
      },
      status: () => `${stateLine()} state=${api.state}`,
      tap: (route = 'text') => tap(route, 'debug'),
    },
  };
  g[GLOBAL] = api;
  start();
  return api;
};
