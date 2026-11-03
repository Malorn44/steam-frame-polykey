// polykey in Steam's keyboard popup: renders the selected keyboard over the stock keys and sends what
// is typed through Steam. Fails safe: does nothing while required Steam objects are missing or fjk is
// active; never logs typed text; never leaves a key held. Idempotent: a re-injection replaces it.

import { createBridge } from './bridge/client.js';
import { readBoot, type ActionName, type Boot, type KeyDef, type Theme } from './core/catalog.js';
import { CLIPBOARD_CHORDS } from './core/keycodes.js';
import { NO_MODS, press, pressText, type Effect, type Mods } from './core/keyboard.js';
import { chooseDelivery } from './core/output/plan.js';
import { NO_WORD, matchCase, rank, replaceWord, slotOrder, suggestPrefix, trackWord, type WordState } from './core/suggest.js';
import { getKeyboardPopupWindow, pickKeyboardManager, type SteamGlobals } from './host/steam/globals.js';
import { classifyTarget, describeStatus, findStatusStore, keyboardMode, readStatus, type StatusStore } from './host/steam/diag.js';
import { createKeySender, getSetKeyState } from './host/steam/keys.js';
import { fjkActive, otherKeyboards } from './host/steam/others.js';
import { createOutput } from './host/steam/output.js';
import { mountSurface, overlayRect, type Surface } from './host/steam/popup.js';
import { missingPrerequisites } from './host/steam/probe.js';
import { createStockGuard } from './host/steam/stock-guard.js';
import { HAPTIC, haptic, onCursor, steamKeyboardStyle } from './host/steam/vr.js';
import { log, warn } from './log.js';
import { createView, type View } from './ui/view.js';

declare const __POLYKEY_VERSION__: string;
export const VERSION: string = typeof __POLYKEY_VERSION__ === 'string' ? __POLYKEY_VERSION__ : 'dev';

export const GLOBAL = '__polykey';
export const BOOT_GLOBAL = '__polykeyBoot';
/** Popup and open-state check; also picks up a recreated popup. */
export const CHECK_MS = 5000;
export const PREREQ_RETRY_MS = 1000;
export const PREREQ_TIMEOUT_MS = 120_000;
/** Gap between key-state events (TaiKeid: IBus reorders keys sent with no gap). */
export const KEY_GAP_MS = 8;
/** The stock keyboard's place in the 🌐 cycle. */
export const STOCK = 'steam/stock';
const NON_ASCII = /[^\x20-\x7e]/;

export type State = 'waiting' | 'blocked' | 'running' | 'inactive' | 'uninstalled';

export interface PolykeyApi {
  readonly version: string;
  state: State;
  uninstall(): void;
  bridgeReply(reply: unknown): void;
  readonly debug: {
    status(): string;
    /** Switch keyboard by id (or 'steam/stock'). */
    use(id: string): string;
  };
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export const installPolykey = (g: SteamGlobals = globalThis as unknown as SteamGlobals): PolykeyApi => {
  const previous = g[GLOBAL] as Partial<PolykeyApi> | undefined;
  if (typeof previous?.uninstall === 'function') {
    try {
      previous.uninstall();
    } catch (error) {
      warn('previous instance failed to uninstall:', errorKind(error));
    }
  }

  const boot: Boot | null = readBoot(g[BOOT_GLOBAL]);
  const ring = [...(boot?.settings.keyboards ?? []).filter((id) => boot?.catalog.keyboards[id]), STOCK];
  let current = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let surface: Surface | null = null;
  let view: View | null = null;
  let guard: ReturnType<typeof createStockGuard> | null = null;
  let returnButton: HTMLElement | null = null;
  let stopCursor: (() => void) | null = null;
  let hand = 0;
  let statusStore: StatusStore | null = null;
  let mods: Mods = NO_MODS;
  let wasOpen = false;
  let waitingSince = 0;
  let queue: Promise<unknown> = Promise.resolve();
  // Suggestions: the word being typed, words used this session (memory only), and a generation so a
  // slow reply never shows suggestions for an older word.
  let word: WordState = NO_WORD;
  const session = new Map<string, number>();
  let suggestGeneration = 0;

  const output = createOutput({
    getManager: () => pickKeyboardManager(g),
    getDelivery: () => chooseDelivery(keyboardMode(readStatus(statusStore)), 'auto'),
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

  /** Non-ASCII into KDE Desktop Mode goes by paste; the sidecar refuses unless the desktop has focus. */
  const sendText = async (text: string): Promise<void> => {
    if (NON_ASCII.test(text) && classifyTarget(readStatus(statusStore)) === 'local-app' && bridge.available()) {
      const prepared = await bridge.call('desktop.prepare', { text });
      if (prepared.ok) {
        const pressed = await keys.send(CLIPBOARD_CHORDS.paste, KEY_GAP_MS);
        await bridge.call('desktop.wait', { timeoutMs: pressed.ok ? 2000 : 0 }, 4000);
        return;
      }
    }
    const result = await output([{ text }]);
    if (!result.ok) warn(`text not sent: ${result.error ?? '?'}`);
  };

  const runAction = (action: ActionName): void => {
    if (action === 'hide') void output([{ key: 'VKClose' }]);
    else if (action === 'next-keyboard') switchTo((current + 1) % ring.length);
    else log(`${action}: not available yet`);
  };

  const apply = async (effect: Effect): Promise<void> => {
    if (effect.kind === 'text') await sendText(effect.text);
    else if (effect.kind === 'key') await output([{ key: effect.key }]);
    else if (effect.kind === 'chord') {
      const result = await keys.send(effect.events, KEY_GAP_MS);
      if (!result.ok) warn(`key chord not sent: ${result.error ?? '?'}`);
    } else runAction(effect.action);
  };

  const enqueue = (effects: readonly Effect[]): void => {
    // In order, one press after another, so fast typing never interleaves.
    queue = queue.then(async () => {
      for (const effect of effects) await apply(effect);
    }).catch((error) => warn('key failed:', errorKind(error)));
  };

  const boost = (used: string): void => { session.set(used.toLowerCase(), (session.get(used.toLowerCase()) ?? 0) + 1); };

  const lexiconId = (): string | undefined => boot?.catalog.keyboards[ring[current] as string]?.lexicon;

  const refreshSuggestions = (): void => {
    const generation = ++suggestGeneration;
    const prefix = suggestPrefix(word);
    const lexicon = lexiconId();
    if (!prefix || !lexicon || !bridge.available()) {
      view?.setSuggestions([]);
      return;
    }
    void bridge.call('suggest', { prefix, lexicon, limit: 8 }).then((reply) => {
      if (generation !== suggestGeneration) return;
      const words = reply.ok && Array.isArray(reply['words']) ? (reply['words'] as string[]) : [];
      view?.setSuggestions(slotOrder(rank(words, session).map((w) => matchCase(w, prefix))));
    });
  };

  const setWord = (next: WordState): void => {
    word = next;
    refreshSuggestions();
  };

  const onKey = (key: KeyDef, alternate?: string): void => {
    if (surface) haptic(surface.win, HAPTIC.enter, hand);
    const result = alternate === undefined ? press(mods, key) : pressText(mods, alternate);
    mods = result.mods;
    view?.update(mods);
    const tracked = trackWord(word, result.effects);
    if (tracked.ended) boost(tracked.ended);
    setWord(tracked.state);
    enqueue(result.effects);
  };

  const onSuggestion = (chosen: string): void => {
    if (surface) haptic(surface.win, HAPTIC.enter, hand);
    const typed = word.word;
    boost(chosen);
    setWord(NO_WORD);
    enqueue(replaceWord(typed, chosen));
  };

  const unmountView = (): void => {
    stopCursor?.();
    stopCursor = null;
    view?.destroy();
    view = null;
    returnButton?.remove();
    returnButton = null;
  };

  /** Show the current ring entry: one of our keyboards, or the stock one with a way back. */
  const render = (): void => {
    if (!surface || !boot) return;
    unmountView();
    const id = ring[current] as string;
    if (id === STOCK) {
      guard?.setActive(false);
      const button = surface.doc.createElement('div');
      button.textContent = '🌐 polykey';
      button.style.cssText = 'position:fixed;top:4px;right:4px;padding:6px 10px;border-radius:8px;background:#011627;'
        + 'color:#d6deeb;font:600 14px system-ui,sans-serif;pointer-events:auto;';
      const back = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        switchTo(0);
      };
      button.addEventListener('touchend', back);
      button.addEventListener('click', back);
      surface.shadow.append(button);
      returnButton = button;
      return;
    }
    const keyboard = boot.catalog.keyboards[id];
    const layout = keyboard && boot.catalog.layouts[keyboard.layout];
    const theme = themeFor(surface.win);
    if (!layout || !theme) {
      warn(`keyboard ${id} has no layout or theme; showing Steam's keyboard`);
      return;
    }
    guard?.setActive(true);
    view = createView(surface.doc, surface.shadow, layout, theme, onKey, onSuggestion);
    view.setBounds(overlayRect(surface.win));
    view.update(mods);
    const win = surface.win;
    stopCursor = onCursor(win, (x, y, which) => {
      hand = which;
      if (view?.hoverAt(x, y)) haptic(win, HAPTIC.enter, which); // a tick as the laser crosses keys
    });
  };

  /** The selected theme; a followSteam theme takes Steam's own keyboard colours where it can read them. */
  const themeFor = (win: Window): Theme | undefined => {
    const theme = boot?.catalog.themes[boot.settings.theme] ?? Object.values(boot?.catalog.themes ?? {})[0];
    if (!theme?.followSteam) return theme;
    const steam = steamKeyboardStyle(win);
    return { ...theme, ...(steam.font ? { font: steam.font } : {}), colors: { ...theme.colors, ...steam.colors } };
  };

  const switchTo = (index: number): void => {
    keys.releaseAll();
    mods = NO_MODS;
    current = index;
    render();
    log(`keyboard: ${ring[current]}`);
  };

  const unmount = (): void => {
    unmountView();
    guard?.setActive(false);
    guard = null;
    surface?.destroy();
    surface = null;
  };

  const mount = (win: Window): void => {
    surface = mountSurface(win);
    guard = createStockGuard(win);
    render();
    log(`mounted in keyboard popup (${win.innerWidth}x${win.innerHeight}), keyboard ${ring[current]}`);
  };

  const onOpenChange = (): void => {
    const status = readStatus(statusStore);
    const open = status?.bIsOpen === true;
    if (open !== wasOpen) {
      setWord(NO_WORD); // a new field: we only ever replace letters we typed after this
      if (!open) {
        keys.releaseAll(); // closing must never leave a key held
        mods = { ...NO_MODS, caps: mods.caps };
        view?.update(mods);
      }
      log(`keyboard ${open ? 'opened' : 'closed'}: ${describeStatus(status)}`);
    }
    wasOpen = open;
  };

  /** Keep the keyboard in the current popup; runs every CHECK_MS. */
  const check = (): void => {
    try {
      if (fjkActive(g)) {
        if (surface) unmount();
        if (api.state !== 'blocked') {
          api.state = 'blocked';
          log('frame-jp-keyboard is active, so polykey is not drawn; stop it to use polykey');
        }
        return;
      }
      if (api.state === 'blocked') api.state = 'running';
      const win = getKeyboardPopupWindow(g);
      // Compare documents, not windows: the document is what changes when Steam recreates the popup.
      if (surface && (surface.doc !== win?.document || !surface.isLive())) {
        unmount();
        log('keyboard popup changed; removed');
      }
      if (!surface && win?.document?.body) mount(win);
      if (view && surface) view.setBounds(overlayRect(surface.win));
      onOpenChange();
    } catch (error) {
      warn('check failed:', errorKind(error));
    }
  };

  const tryRun = (): boolean => {
    if (missingPrerequisites(g).length > 0) return false;
    statusStore = findStatusStore(g);
    if (!statusStore) log('VR keyboard status not found; one character per call');
    api.state = 'running';
    startTimer(check, CHECK_MS);
    check();
    log(`running ${VERSION}`);
    return true;
  };

  const start = (): void => {
    if (!boot) {
      api.state = 'inactive';
      warn('no packs from the sidecar; leaving the stock keyboard alone');
      return;
    }
    for (const error of boot.errors) warn(`pack: ${error}`);
    const others = otherKeyboards(g);
    if (others.length) log(`other keyboards in Steam: ${others.join('; ')}`);
    if (tryRun()) return;
    waitingSince = Date.now();
    log(`waiting for Steam objects: ${missingPrerequisites(g).join(', ')}`);
    startTimer(() => {
      if (tryRun()) return;
      if (Date.now() - waitingSince < PREREQ_TIMEOUT_MS) return;
      stopTimer();
      api.state = 'inactive';
      warn(`missing Steam objects: ${missingPrerequisites(g).join(', ')}; leaving the stock keyboard alone`);
    }, PREREQ_RETRY_MS);
  };

  const api: PolykeyApi = {
    version: VERSION,
    state: 'waiting',
    uninstall: () => {
      stopTimer();
      keys.releaseAll();
      bridge.close();
      unmount();
      api.state = 'uninstalled';
      log(`uninstalled ${VERSION}`);
    },
    bridgeReply: (reply) => bridge.receive(reply),
    debug: {
      status: () => `${api.state} keyboard=${ring[current]} ${describeStatus(readStatus(statusStore))} `
        + `popup=${surface ? `${surface.win.innerWidth}x${surface.win.innerHeight}` : '-'}`,
      use: (id) => {
        const index = ring.indexOf(id);
        if (index < 0) return `unknown keyboard ${id}; have ${ring.join(', ')}`;
        switchTo(index);
        return `keyboard ${id}`;
      },
    },
  };
  g[GLOBAL] = api;
  start();
  return api;
};
