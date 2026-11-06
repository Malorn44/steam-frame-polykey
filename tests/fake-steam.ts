// A fake of the Steam objects polykey reads, for tests. Records every HandleVirtualKeyDown call.
import type { VRKeyboardStatus } from '../src/host/steam/diag.js';
import { KEYBOARD_OVERLAY_KEY } from '../src/host/steam/globals.js';

export interface FakeManager {
  calls: [string, boolean][];
  HandleVirtualKeyDown(key: string, shift: boolean): void;
  m_fnVROnTextEnteredOverride?: () => void;
}

export const fakeManager = (override = false): FakeManager => {
  const manager: FakeManager = {
    calls: [],
    HandleVirtualKeyDown(key, shift) {
      manager.calls.push([key, shift]);
    },
  };
  if (override) manager.m_fnVROnTextEnteredOverride = () => {};
  return manager;
};

export interface FakePopupWindow {
  document: Document;
  closed: boolean;
  innerWidth: number;
  innerHeight: number;
  addEventListener: Document['addEventListener'];
  removeEventListener: Document['removeEventListener'];
}

/** A popup window backed by its own document (jsdom environment, or pass a jsdom window's implementation). */
export const fakePopupWindow = (impl: DOMImplementation = document.implementation): FakePopupWindow => {
  const doc = impl.createHTMLDocument('SteamVR - Keyboard');
  return {
    document: doc,
    closed: false,
    innerWidth: 854,
    innerHeight: 280,
    addEventListener: doc.addEventListener.bind(doc),
    removeEventListener: doc.removeEventListener.bind(doc),
  };
};

/** A fake webpack chunk registry exposing one module with a VRKeyboardStatus store. */
export const fakeWebpack = (getStatus: () => VRKeyboardStatus) => {
  const store = {
    get VRKeyboardStatus() {
      return getStatus();
    },
  };
  const factory = function factory() {
    return 'get VRKeyboardStatus()';
  };
  const modules: Record<string, unknown> = { '17': () => 'unrelated', '42': factory };
  const req = Object.assign((id: string) => (id === '42' ? { a: store } : {}), { m: modules });
  return {
    push(chunk: [unknown, unknown, (r: typeof req) => void]) {
      chunk[2]?.(req);
    },
  };
};

export interface FakeSteamOptions {
  popupManager?: boolean;
  managers?: FakeManager[];
  popup?: FakePopupWindow | null;
  status?: VRKeyboardStatus | null;
  /** Provide SteamClient.Input.ControllerKeyboardSetKeyState, recording [code, down] events. */
  keyState?: boolean;
}

/** The global object as polykey sees it inside Steam. */
export const fakeSteam = (options: FakeSteamOptions = {}) => {
  const state = {
    popup: options.popup === undefined ? null : options.popup,
    status: options.status ?? null,
    managers: options.managers ?? [fakeManager()],
    keyEvents: [] as [number, boolean][],
  };
  const g: Record<string, unknown> = {
    SteamUIStore: { WindowStore: { SteamUIWindows: state.managers.map((m) => ({ VirtualKeyboardManager: m })) } },
  };
  if (options.keyState) {
    g['SteamClient'] = {
      Input: { ControllerKeyboardSetKeyState: (code: number, down: boolean) => state.keyEvents.push([code, down]) },
    };
  }
  if (options.popupManager !== false) {
    g['g_PopupManager'] = {
      GetPopupForVROverlayKey: (key: string) =>
        key === KEYBOARD_OVERLAY_KEY && state.popup ? { m_popup: state.popup } : undefined,
    };
  }
  if (state.status) g['webpackChunksteamui'] = fakeWebpack(() => state.status as VRKeyboardStatus);
  return { g, state };
};

export const MINIMAL: VRKeyboardStatus = {
  bIsOpen: true,
  bMinimal: true,
  sOverlayKey: 'gamescope.gamescope-0.window.72',
  unAppID: 0,
  bDispatchEventsToSteamVR: false,
};
export const BUFFERED: VRKeyboardStatus = {
  bIsOpen: true,
  bMinimal: false,
  sOverlayKey: 'valve.steam.gamepadui.main',
  unAppID: 0,
  bDispatchEventsToSteamVR: false,
};
export const STREAMED: VRKeyboardStatus = {
  bIsOpen: true,
  bMinimal: true,
  sOverlayKey: 'steamlink_openvr-overlay',
  unAppID: 0,
  bDispatchEventsToSteamVR: true,
};
