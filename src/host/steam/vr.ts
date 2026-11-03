// Laser hover and haptics through the keyboard popup's own SteamClient.OpenVR, as Steam's keyboard
// does: VROverlay.RegisterForCursorMovement((hand, flag, x, y)) — measured on the Frame 2026-11-03:
// hand 0 for the laser, x/y in popup CSS px — and TriggerOverlayHapticEffect(effect, hand) with
// Steam's effects (ButtonEnter 1, ButtonLeave 2, Snap 3).
// Both are optional: without them there is no hover or haptic, and nothing else changes.

import type { ThemeColors } from '../../core/catalog.js';

export const HAPTIC = { enter: 1, leave: 2, snap: 3 } as const;

type OpenVR = {
  TriggerOverlayHapticEffect?: (effect: number, hand: number) => void;
  VROverlay?: { RegisterForCursorMovement?: (fn: (hand: number, flag: unknown, x: number, y: number) => void) => { unregister?: () => void } };
};

const openVr = (win: Window): OpenVR | undefined => {
  try {
    return (win as unknown as { SteamClient?: { OpenVR?: OpenVR } }).SteamClient?.OpenVR;
  } catch {
    return undefined;
  }
};

export const haptic = (win: Window, effect: number, hand: number): void => {
  try {
    openVr(win)?.TriggerOverlayHapticEffect?.(effect, hand);
  } catch {
    // No haptics; nothing else depends on them.
  }
};

/** Follow the laser over the popup; returns the unsubscribe. */
export const onCursor = (win: Window, fn: (x: number, y: number, hand: number) => void): (() => void) => {
  try {
    const registration = openVr(win)?.VROverlay?.RegisterForCursorMovement?.((hand, _flag, x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) fn(x, y, hand);
    });
    return () => { try { registration?.unregister?.(); } catch { /* gone with the popup */ } };
  } catch {
    return () => {};
  }
};

const toHex = (css: string | undefined): string | undefined => {
  const m = css?.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return undefined;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
};

/** Colours and font of Steam's own keyboard (they follow the keyboard theme picked in Steam). */
export const steamKeyboardStyle = (win: Window): { colors: Partial<ThemeColors>; font?: string } => {
  const style = (selector: string): CSSStyleDeclaration | undefined => {
    try {
      const el = win.document.querySelector(selector);
      return el ? win.getComputedStyle(el) : undefined;
    } catch {
      return undefined;
    }
  };
  const panel = style('[class*="Layout_"]');
  const letter = style('[data-key="a"] > div');
  const modifier = style('[data-key="Shift"] > div');
  const colors: Partial<ThemeColors> = {};
  const set = (name: keyof ThemeColors, value: string | undefined): void => { if (value) colors[name] = value; };
  set('surface', toHex(panel?.backgroundColor));
  set('key', toHex(letter?.backgroundColor));
  set('keyText', toHex(letter?.color));
  set('modifier', toHex(modifier?.backgroundColor));
  const font = style('body')?.fontFamily;
  return font ? { colors, font } : { colors };
};
