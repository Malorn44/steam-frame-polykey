// Key chords as [code, down] events for Steam's key-state call: USB HID usage IDs for ordinary
// keys, Steam's own codes (100+) for modifiers (as fjk uses them).

export type KeyEvent = readonly [code: number, down: boolean];

export const MODIFIER = { alt: 100, shift: 101, ctrl: 103 } as const;
export const HID_V = 25;
export const HID_INSERT = 73;

// Shift+Insert pastes in Qt, GTK, Chrome and Konsole; Ctrl+V is quoted-insert in a shell.
export type PasteChord = 'shift-insert' | 'ctrl-v' | 'ctrl-shift-v';
export const PASTE_CHORD_NAMES: readonly PasteChord[] = ['shift-insert', 'ctrl-v', 'ctrl-shift-v'];

/** Modifiers first, released last in reverse order. */
const chord = (modifiers: readonly number[], key: number): KeyEvent[] => [
  ...modifiers.map((code): KeyEvent => [code, true]),
  [key, true],
  [key, false],
  ...[...modifiers].reverse().map((code): KeyEvent => [code, false]),
];

export const PASTE_CHORDS: Readonly<Record<PasteChord, readonly KeyEvent[]>> = {
  'shift-insert': chord([MODIFIER.shift], HID_INSERT),
  'ctrl-v': chord([MODIFIER.ctrl], HID_V),
  'ctrl-shift-v': chord([MODIFIER.ctrl, MODIFIER.shift], HID_V),
};
