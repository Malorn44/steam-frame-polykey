// Read-only report of the Steam objects polykey relies on (`run.py probe`, after Steam updates).

import { getKeyboardManagers, getKeyboardPopupWindow, getSteamUIWindows, type SteamGlobals } from './host/steam/globals.js';
import { otherKeyboards } from './host/steam/others.js';
import { missingPrerequisites } from './host/steam/probe.js';

declare const __POLYKEY_VERSION__: string;

export const report = (g: SteamGlobals = globalThis) => {
  const win = getKeyboardPopupWindow(g);
  const polykey = g['__polykey'] as { version?: unknown; state?: unknown } | undefined;
  return {
    probeVersion: typeof __POLYKEY_VERSION__ === 'string' ? __POLYKEY_VERSION__ : 'dev',
    missing: missingPrerequisites(g),
    steamUIWindows: getSteamUIWindows(g).length,
    keyboardManagers: getKeyboardManagers(g).length,
    webpackRegistry: typeof (g['webpackChunksteamui'] as { push?: unknown } | undefined)?.push === 'function',
    keyboardPopup: win
      ? { width: win.innerWidth, height: win.innerHeight, visibility: win.document.visibilityState }
      : null,
    otherKeyboards: otherKeyboards(g),
    polykey: polykey ? `${String(polykey.version)} (${String(polykey.state)})` : null,
  };
};
