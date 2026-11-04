// Which layout a keyboard shows: its main layout, its 英数 page, or one of its symbols pages.

import type { KeyboardDef } from './catalog.js';

/** What the keyboard is showing: 英数 mode, which symbols page (0: none), and the qwertyLatin option. */
export interface PageState { readonly latin: boolean; readonly symbols: 0 | 1 | 2; readonly qwerty: boolean }

/** The keyboard's 英数 page, if it has its own (the 12-key's ABC keys, flick or QWERTY). */
export const latinPage = (keyboard: KeyboardDef, qwerty: boolean): string | undefined => {
  const latin = keyboard.pages?.latin;
  return typeof latin === 'object' ? (qwerty ? latin.qwerty : latin.flick) : latin;
};

/** The layout shown now: a symbols page over everything, then the 英数 page in 英数 mode, then the main one. */
export const pageLayout = (keyboard: KeyboardDef, state: PageState): string => {
  const symbols = keyboard.pages?.symbols ?? [];
  if (state.symbols) return symbols[state.symbols - 1] ?? symbols[0] ?? keyboard.layout;
  return (state.latin && latinPage(keyboard, state.qwerty)) || keyboard.layout;
};
