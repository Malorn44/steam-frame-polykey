// Lookups into Steam's private objects in SharedJSContext. Each returns null (or []) instead of
// throwing; each takes the global object so tests can pass a fake.

/** VR overlay key of the stock keyboard popup ("SteamVR - Keyboard"). */
export const KEYBOARD_OVERLAY_KEY = 'valve.steam.gamepadui.keyboard';

export interface VirtualKeyboardManager {
  HandleVirtualKeyDown(key: string, shift: boolean): void;
  m_fnVROnTextEnteredOverride?: unknown;
}

interface PopupManager {
  GetPopupForVROverlayKey(key: string): unknown;
}

/** The global object as Steam fills it. */
export type SteamGlobals = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Read a property without letting a throwing getter escape. */
const read = (value: unknown, key: string): unknown => {
  try {
    return isObject(value) || typeof value === 'function' ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
};

export const getPopupManager = (g: SteamGlobals): PopupManager | null => {
  const manager = read(g, 'g_PopupManager');
  return typeof read(manager, 'GetPopupForVROverlayKey') === 'function' ? (manager as PopupManager) : null;
};

/** Steam UI window instances; each one owns a VirtualKeyboardManager. */
export const getSteamUIWindows = (g: SteamGlobals): unknown[] => {
  const windows = read(read(read(g, 'SteamUIStore'), 'WindowStore'), 'SteamUIWindows');
  return Array.isArray(windows) ? windows : [];
};

export const isKeyboardManager = (value: unknown): value is VirtualKeyboardManager =>
  typeof read(value, 'HandleVirtualKeyDown') === 'function';

export const getKeyboardManagers = (g: SteamGlobals): VirtualKeyboardManager[] =>
  getSteamUIWindows(g)
    .map((w) => read(w, 'VirtualKeyboardManager'))
    .filter(isKeyboardManager);

/** The manager the VR keyboard types for (it has `m_fnVROnTextEnteredOverride` set), else the first. */
export const pickKeyboardManager = (g: SteamGlobals): VirtualKeyboardManager | null => {
  const managers = getKeyboardManagers(g);
  return managers.find((m) => typeof read(m, 'm_fnVROnTextEnteredOverride') === 'function') ?? managers[0] ?? null;
};

/** Steam's callback list (library.js): Register returns the way out. */
interface CallbackList { Register(fn: (...args: unknown[]) => void): { Unregister?: () => void } }

/**
 * The dispatches Steam's own keyboard resets its composition on: a Steam UI window's keyboard moving to
 * another text field or losing it (OnActiveElementChanged), or its field clicked again, which may move
 * the caret (OnActiveElementClicked). `fn` runs on each, from every manager that has them; it never
 * throws into Steam's dispatch. Returns the unregister.
 */
export const onFieldChange = (manager: VirtualKeyboardManager, fn: () => void): (() => void) => {
  const call = (): void => {
    try {
      fn();
    } catch {
      // Never into Steam's dispatch: its other callbacks still run.
    }
  };
  const ways = ['OnActiveElementChanged', 'OnActiveElementClicked'].map((name) => {
    const list = read(manager, name);
    try {
      return typeof read(list, 'Register') === 'function' ? (list as CallbackList).Register(call) : undefined;
    } catch {
      return undefined;
    }
  });
  return () => {
    for (const way of ways) {
      try {
        way?.Unregister?.();
      } catch {
        // Gone with its window.
      }
    }
  };
};

/** The stock keyboard popup's window, or null while it does not exist. */
export const getKeyboardPopupWindow = (g: SteamGlobals): Window | null => {
  const manager = getPopupManager(g);
  if (!manager) return null;
  try {
    const popup = manager.GetPopupForVROverlayKey(KEYBOARD_OVERLAY_KEY);
    const win = read(popup, 'm_popup') ?? read(popup, 'window');
    if (!isObject(win) || read(win, 'closed') === true || !isObject(read(win, 'document'))) return null;
    return win as unknown as Window;
  } catch {
    return null;
  }
};
