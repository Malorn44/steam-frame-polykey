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

/** A page value as short log text: a string or number as it is, anything else '?'. */
const text = (value: unknown, max: number): string =>
  (typeof value === 'string' || typeof value === 'number' ? String(value) : '?').slice(0, max);

/** Log-safe descriptions of the other keyboards present in the page. */
export const otherKeyboards = (g: SteamGlobals): string[] => {
  const found: string[] = [];
  const fjk = read(g, FJK_GLOBAL);
  if (typeof fjk === 'object' && fjk !== null) {
    const version = text(read(fjk, 'version'), 40);
    const state = text(read(fjk, 'state'), 20);
    found.push(`frame-jp-keyboard ${version} (state=${state}, enabled=${String(read(fjk, 'enabled'))})`);
  }
  if (read(g, FULL_KEYBOARD_GLOBAL) !== undefined) found.push('TaiKeid Full Keyboard replacement hooks');
  return found;
};
