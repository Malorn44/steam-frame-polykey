// Read-only detection of other keyboards hooking the same popup (fjk, TaiKeid Full Keyboard).

import type { SteamGlobals } from './globals.js';

/** Global set by frame-jp-keyboard (fjk) when installed. */
const FJK_GLOBAL = '__fjk';
/** Global set by TaiKeid Full Keyboard's native-replacement bridge. */
const FULL_KEYBOARD_GLOBAL = '__fullKeyboardNativeV1';

const read = (value: unknown, key: string): unknown => {
  try {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
};

/** fjk is installed in the page and its overlay is enabled (it would cover the popup). */
export const fjkActive = (g: SteamGlobals): boolean => {
  const fjk = read(g, FJK_GLOBAL);
  if (typeof fjk !== 'object' || fjk === null) return false;
  const state = read(fjk, 'state');
  if (state === 'uninstalled' || state === 'failed') return false;
  return read(fjk, 'enabled') !== false;
};

/** Log-safe descriptions of the other keyboards present in the page. */
export const otherKeyboards = (g: SteamGlobals): string[] => {
  const found: string[] = [];
  const fjk = read(g, FJK_GLOBAL);
  if (typeof fjk === 'object' && fjk !== null) {
    const version = String(read(fjk, 'version') ?? '?').slice(0, 40);
    const state = String(read(fjk, 'state') ?? '?').slice(0, 20);
    found.push(`frame-jp-keyboard ${version} (state=${state}, enabled=${String(read(fjk, 'enabled'))})`);
  }
  if (read(g, FULL_KEYBOARD_GLOBAL) !== undefined) found.push('TaiKeid Full Keyboard replacement hooks');
  return found;
};
