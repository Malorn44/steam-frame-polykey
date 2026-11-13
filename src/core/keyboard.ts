// What a key press does: modifier state in, new state and effects out. Pure.
//
// Modifiers are sticky: tap = once (applies to the next key), tap again = locked, again = off.
// Caps toggles. Text goes out as text; anything with Ctrl/Alt/Super (or a key Steam's text entry
// point can't type, like Esc or F1) goes out as a key chord.

import { normalizeFn, type ActionName, type KeyDef, type ModName } from './catalog.js';
import { CLIPBOARD_CHORDS, MODIFIER, NAMED_CODES, chord, keyForChar, type KeyEvent, type NamedKey } from './keycodes.js';
import type { VkdKey } from './output/plan.js';

export type Latch = 'off' | 'once' | 'locked';
export interface Mods {
  readonly shift: Latch;
  readonly ctrl: Latch;
  readonly alt: Latch;
  readonly super: Latch;
  readonly fn: Latch;
  readonly caps: boolean;
}
export const NO_MODS: Mods = { shift: 'off', ctrl: 'off', alt: 'off', super: 'off', fn: 'off', caps: false };

export type Effect =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: VkdKey }
  | { readonly kind: 'chord'; readonly events: readonly KeyEvent[] }
  | { readonly kind: 'action'; readonly action: ActionName };

/** Keys HandleVirtualKeyDown takes by name; every other named key is sent as a chord. */
const VKD_KEYS = new Set<NamedKey>(['Backspace', 'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const CHORD_MODS = ['ctrl', 'alt', 'super'] as const;
const z = keyForChar('z');
/** Ctrl+Z. */
export const UNDO: Effect = { kind: 'chord', events: chord([MODIFIER.ctrl], z ? z.code : 29) };

const on = (latch: Latch): boolean => latch !== 'off';
const nextLatch = (latch: Latch): Latch => (latch === 'off' ? 'once' : latch === 'once' ? 'locked' : 'off');
const releaseOnce = (mods: Mods): Mods => ({
  ...mods,
  shift: mods.shift === 'once' ? 'off' : mods.shift,
  ctrl: mods.ctrl === 'once' ? 'off' : mods.ctrl,
  alt: mods.alt === 'once' ? 'off' : mods.alt,
  super: mods.super === 'once' ? 'off' : mods.super,
  fn: mods.fn === 'once' ? 'off' : mods.fn,
});

/** The key as it acts right now: its Fn variant while Fn is on. */
export const resolveKey = (key: KeyDef, mods: Mods): KeyDef =>
  (on(mods.fn) && (key.type === 'char' || key.type === 'key') && key.fn ? normalizeFn(key.fn) : key);

/** A JIS key as it types in かな mode: its kana legends (Shift: kanaShift, else the kana again). */
export const kanaSide = (key: KeyDef, kanaMode: boolean): KeyDef =>
  (kanaMode && key.type === 'char' && key.kana
    ? { type: 'char', char: key.kana, shift: key.kanaShift ?? key.kana, ...(key.w !== undefined ? { w: key.w } : {}) }
    : key);

/** A flicked character with Shift and Caps (a letter on the 12-key's ABC keys: a/A is Shift). */
export const flickText = (text: string, mods: Mods): string => charText({ char: text }, mods);

/** The text a char key types with the current Shift and Caps. */
export const charText = (key: { char: string; shift?: string }, mods: Mods): string => {
  const letter = key.char.toLowerCase() !== key.char.toUpperCase();
  const upper = letter ? on(mods.shift) !== mods.caps : on(mods.shift);
  return upper ? key.shift ?? key.char.toUpperCase() : key.char;
};

const heldModifiers = (mods: Mods, withShift: boolean): number[] => [
  ...(on(mods.ctrl) ? [MODIFIER.ctrl] : []),
  ...(on(mods.alt) ? [MODIFIER.alt] : []),
  ...(on(mods.super) ? [MODIFIER.super] : []),
  ...(withShift ? [MODIFIER.shift] : []),
];

export const press = (mods: Mods, pressed: KeyDef): { mods: Mods; effects: Effect[] } => {
  const key = resolveKey(pressed, mods);
  switch (key.type) {
    case 'gap':
      return { mods, effects: [] };
    case 'flick': // a tap outside a reading buffer (core/ime.ts handles the 12-key kana): the key's own character
      return { mods: releaseOnce(mods), effects: key.flick[0] ? [{ kind: 'text', text: flickText(key.flick[0], mods) }] : [] };
    case 'mod':
      if (key.mod === 'super' && mods.super === 'once') {
        // Super never locks: a second tap sends Super on its own (KDE opens its launcher).
        return { mods: { ...mods, super: 'off' }, effects: [{ kind: 'chord', events: chord([], MODIFIER.super) }] };
      }
      return { mods: pressMod(mods, key.mod), effects: [] };
    case 'action': {
      const chorded = key.action === 'copy' || key.action === 'cut' || key.action === 'paste' || key.action === 'menu';
      const effect: Effect = chorded
        ? { kind: 'chord', events: CLIPBOARD_CHORDS[key.action as 'copy' | 'cut' | 'paste' | 'menu'] }
        : key.action === 'undo' ? UNDO // ↶ outside a reading buffer: undo in the app
          : { kind: 'action', action: key.action };
      return { mods: releaseOnce(mods), effects: [effect] };
    }
    case 'char': {
      const chording = CHORD_MODS.some((m) => on(mods[m]));
      if (!chording) return { mods: releaseOnce(mods), effects: [{ kind: 'text', text: charText(key, mods) }] };
      const target = keyForChar(key.char);
      const effects: Effect[] = target
        ? [{ kind: 'chord', events: chord(heldModifiers(mods, on(mods.shift) || target.shift), target.code) }]
        : [];
      return { mods: releaseOnce(mods), effects };
    }
    case 'key': {
      const plain = !CHORD_MODS.some((m) => on(mods[m])) && !on(mods.shift) && VKD_KEYS.has(key.key);
      const effect: Effect = plain
        ? { kind: 'key', key: key.key as VkdKey }
        : { kind: 'chord', events: chord(heldModifiers(mods, on(mods.shift)), NAMED_CODES[key.key]) };
      return { mods: releaseOnce(mods), effects: [effect] };
    }
  }
};

/**
 * What a long press offers: the key's own text, its Shift character (not for letters: their capital is
 * not a variant), then its listed variants, all in the current case. Fewer than two: nothing to choose.
 */
export const alternates = (pressed: KeyDef, mods: Mods): string[] => {
  const key = resolveKey(pressed, mods);
  if (key.type !== 'char') return [];
  const main = charText(key, mods);
  const letter = key.char.toLowerCase() !== key.char.toUpperCase();
  const shifted = key.shift ?? key.char.toUpperCase();
  const upper = main === shifted && main !== key.char;
  const other = letter ? [] : [main === shifted ? key.char : shifted];
  const variants = (key.long ?? []).map((v) => (upper ? v.toUpperCase() : v));
  return [...new Set([main, ...other, ...variants])];
};

/** Typing a chosen alternate: plain text, and one-shot modifiers are used up. */
export const pressText = (mods: Mods, text: string): { mods: Mods; effects: Effect[] } =>
  ({ mods: releaseOnce(mods), effects: [{ kind: 'text', text }] });

const pressMod = (mods: Mods, mod: ModName): Mods =>
  (mod === 'caps' ? { ...mods, caps: !mods.caps } : { ...mods, [mod]: nextLatch(mods[mod]) });

/** Whether a modifier key shows as on, and as locked. */
export const modState = (mods: Mods, mod: ModName): { on: boolean; locked: boolean } =>
  (mod === 'caps' ? { on: mods.caps, locked: mods.caps } : { on: on(mods[mod]), locked: mods[mod] === 'locked' });

const NAMED_LABELS: Partial<Record<NamedKey, string>> = {
  Backspace: '⌫', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp',
  PageDown: 'PgDn', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
const MOD_LABELS: Record<ModName, string> = { shift: '⇧', caps: 'Caps', ctrl: 'Ctrl', alt: 'Alt', super: '', fn: 'Fn' };
const ACTION_LABELS: Record<ActionName, string> = {
  hide: '✕', abc: 'ABC', eisu: '英数', kana: 'かな', symbols: '?123', 'more-symbols': '=\\<', modify: '゛゜小', undo: '↶', 'next-keyboard': '🌐', copy: '⧉', cut: '✂', paste: '📋', menu: '☰', settings: '⚙', emoji: '😀', 'next-set': '⇄', dictate: '🎤',
};

/** What a key shows right now (empty for the Super key, which shows an icon). */
export const keyLabel = (pressed: KeyDef, mods: Mods): string => {
  const key = resolveKey(pressed, mods);
  switch (key.type) {
    case 'gap': return '';
    case 'flick': return flickText(key.label ?? key.flick[0], mods);
    case 'mod': return key.label ?? MOD_LABELS[key.mod];
    case 'action': return key.label ?? ACTION_LABELS[key.action];
    case 'key': return key.label ?? NAMED_LABELS[key.key] ?? key.key;
    case 'char': return key.label ?? charText(key, mods);
  }
};
