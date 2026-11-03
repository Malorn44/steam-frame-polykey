// Key codes for Steam's key-state call: USB HID usage IDs for ordinary keys (US positions) and
// Steam's own codes (100+) for modifiers, as fjk uses them. Pure data.

export type KeyEvent = readonly [code: number, down: boolean];

/** Steam's modifier codes (super = 102 confirmed on the Frame: Frame+1 opens the first taskbar item). */
export const MODIFIER = { alt: 100, shift: 101, super: 102, ctrl: 103 } as const;

export const NAMED_CODES = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77,
  PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63, F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
} as const;
export type NamedKey = keyof typeof NAMED_CODES;

const PUNCTUATION: Readonly<Record<string, number>> = {
  ' ': 44, '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51, "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
};
const SHIFTED: Readonly<Record<string, string>> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
};

/** The US key that types a character, and whether Shift is part of it; null when none does. */
export const keyForChar = (ch: string): { code: number; shift: boolean } | null => {
  if (/^[a-z]$/.test(ch)) return { code: 4 + ch.charCodeAt(0) - 97, shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: 4 + ch.charCodeAt(0) - 65, shift: true };
  if (/^[1-9]$/.test(ch)) return { code: 30 + ch.charCodeAt(0) - 49, shift: false };
  if (ch === '0') return { code: 39, shift: false };
  if (ch in PUNCTUATION) return { code: PUNCTUATION[ch] as number, shift: false };
  const base = SHIFTED[ch];
  return base ? { code: (keyForChar(base) as { code: number }).code, shift: true } : null;
};

/** Modifiers down first, the key, then modifiers up in reverse. */
export const chord = (modifiers: readonly number[], key: number): KeyEvent[] => [
  ...modifiers.map((code): KeyEvent => [code, true]),
  [key, true],
  [key, false],
  ...[...modifiers].reverse().map((code): KeyEvent => [code, false]),
];

// Shift+Insert pastes in Qt, GTK, Chrome and Konsole (Ctrl+V is quoted-insert in a shell); the CUA
// keys Ctrl+Insert and Shift+Delete copy and cut in the same apps.
export const CLIPBOARD_CHORDS = {
  copy: chord([MODIFIER.ctrl], NAMED_CODES.Insert),
  cut: chord([MODIFIER.shift], NAMED_CODES.Delete),
  paste: chord([MODIFIER.shift], NAMED_CODES.Insert),
  // The context menu: Shift+F10 works in Qt, GTK and Chrome; Steam's codes 100-103 are its modifiers,
  // so the HID Menu key (101) can't be sent.
  menu: chord([MODIFIER.shift], NAMED_CODES.F10),
} as const;
