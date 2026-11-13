// Which layout a keyboard shows: its main layout, its 英数 page, or one of its symbols pages.

import type { KeyDef, KeyboardDef, LanguageDef } from './catalog.js';

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

/**
 * What the current mode's letters are called: the mode's own (ABC), else for the keyboard's own letters
 * its language's (あいう, 한글); otherwise none, and the back key has its own name. latin: in the
 * keyboard's Latin mode (英数).
 */
export const modeLetters = (keyboard: KeyboardDef | undefined, latin: boolean, language?: LanguageDef): string | undefined => {
  const modes = keyboard?.modes ?? [];
  const mode = modes.find((m) => !!m.latin === latin) ?? modes[0];
  if (mode?.letters) return mode.letters;
  return (mode ? !mode.latin : !latin) ? language?.letters : undefined;
};

/**
 * Where a key switches modes from this one: true, into the Latin mode (英数, or the mode key from the
 * keyboard's own letters); false, back to its own letters (かな in the Latin mode, or the mode key there);
 * undefined, not a switch (かな while typing kana changes the reading's form instead).
 */
export const latinTarget = (key: KeyDef, latin: boolean): boolean | undefined => {
  if (key.type !== 'action') return undefined;
  if (key.action === 'mode') return !latin;
  if (key.action === 'eisu') return true;
  return key.action === 'kana' && latin ? false : undefined;
};

/**
 * Labels that follow the page and mode, for keys without a label of their own: the keys back to the
 * letters (the symbols key on a symbols page, and the emoji row's abc) read the current mode's letters
 * (あいう, ABC); the mode key reads the letters it switches to (`other`: ABC, 한글); more-symbols on the
 * second page goes back to the first (123).
 */
export const pageLabel = (key: KeyDef, page: { readonly letters?: string | undefined; readonly other?: string | undefined; readonly symbols: 0 | 1 | 2 }): string | undefined => {
  if (key.type !== 'action' || key.label !== undefined) return undefined;
  if ((key.action === 'symbols' && page.symbols) || key.action === 'abc') return page.letters ?? 'ABC';
  if (key.action === 'mode') return page.other;
  if (key.action === 'more-symbols' && page.symbols === 2) return '123';
  return undefined;
};
