// Required Steam objects. If any is missing, polykey does nothing and the stock keyboard stays.

import { getPopupManager, getKeyboardManagers, type SteamGlobals } from './globals.js';

export const REQUIRED = {
  popupManager: 'g_PopupManager.GetPopupForVROverlayKey',
  keyboardManager: 'SteamUIStore.WindowStore.SteamUIWindows[].VirtualKeyboardManager.HandleVirtualKeyDown',
} as const;

/** Names of the required objects that are missing; empty means it is safe to run. */
export const missingPrerequisites = (g: SteamGlobals): string[] => {
  const missing: string[] = [];
  if (!getPopupManager(g)) missing.push(REQUIRED.popupManager);
  if (getKeyboardManagers(g).length === 0) missing.push(REQUIRED.keyboardManager);
  return missing;
};
