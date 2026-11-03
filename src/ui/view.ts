// The keyboard as DOM inside our shadow root: built once per layout; update() changes labels, small
// Shift/Fn legends and modifier highlights. Gaps are transparent borders, so key positions follow
// the width weights exactly and columns line up across rows. The VR laser arrives as touch events
// (mouse clicks are the desktop fallback); hover comes from hoverAt() (laser) or mouseover.

import { normalizeFn, normalizeKey, type KeyDef, type Layout, type Theme } from '../core/catalog.js';
import { NO_MODS, alternates, charText, flickText, kanaSide, keyLabel, modState, type Mods } from '../core/keyboard.js';
import { DIRECTIONS, flickDirection } from '../core/kana.js';
import { HOLD_POPUP_CSS, openHoldPopup, type HoldPopup } from './hold-popup.js';
import { ICONS, type IconName } from './icons.js';

export const TOOLBAR_PX = 26;
const TOUCH_MOUSE_GUARD_MS = 600;
/** Hold this long for a key's alternates. */
export const LONG_PRESS_MS = 400;
/** Held Space, Backspace, Delete and arrows repeat: first after REPEAT_DELAY_MS, then every REPEAT_MS. */
export const REPEAT_DELAY_MS = 450;
export const REPEAT_MS = 60;
const REPEATING = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const repeats = (key: KeyDef): boolean => (key.type === 'key' && REPEATING.has(key.key)) || (key.type === 'char' && key.char === ' ');
/** Moving a press on the candidate list further than this scrolls it instead of picking. */
export const LIST_SLOP_PX = 12;
/** Flick guide cells when the key has no size yet (tests); otherwise square, as tall as the key (fjk). */
export const FLICK_CELL_PX = 30;
/** Alternate cells are a little smaller than the key. */
const POPUP_SCALE = 0.85;

const CSS = `
:host { all: initial; }
.kb { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; padding: 2px;
  --label: 17px; --legend-size: calc(var(--label) * 0.6);
  background: var(--surface); color: var(--text); font: 400 var(--label)/1 var(--font);
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.bar { height: ${TOOLBAR_PX}px; display: flex; flex: none; }
.bar .key { flex: none; width: 30px; font-size: 14px; }
.bar .key[data-k="hide"] { width: 24px; }
.cands { flex: 1; display: flex; min-width: 0; margin: 0 4px; }
/* Suggestions: text on the bar, not keys; thin dividers; the best (middle) in the accent colour. */
.sugg { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 0 6px;
  font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: var(--radius); }
.sugg:not(:empty) + .sugg:not(:empty) { border-left: 1px solid var(--mod); }
.sugg.best { color: var(--accent); font-weight: 600; }
.sugg.hover { background-color: var(--hover); }
/* The reading buffer (12-key): underlined, with a caret; while converting, the focused segment is
   marked. Then the candidates, the picked one in the accent colour. */
.comp { flex: 1; display: none; align-items: center; min-width: 0; margin: 0 4px; gap: 8px; }
.comp.on { display: flex; }
.pre { flex: none; max-width: 45%; overflow: hidden; white-space: nowrap; font-size: 16px;
  border-bottom: 1.5px solid var(--text); padding: 0 2px; }
.pre:empty { display: none; } /* no reading: no underline (it showed as a dot) */
.pre .seg { padding: 0 1px; }
.pre .seg.focus { background: var(--accent); color: var(--surface); border-radius: 3px; }
.pre.converting .seg:not(.focus) { color: var(--legend); }
.pre .caret { display: inline-block; width: 1.5px; height: 1em; margin: 0 1px; vertical-align: -2px; background: var(--accent); }
.list { flex: 1; display: flex; min-width: 0; overflow: hidden; height: 100%; }
.cand { flex: none; display: flex; align-items: center; padding: 0 10px; font-size: 16px; white-space: nowrap;
  border-radius: var(--radius); }
.cand + .cand { border-left: 1px solid var(--mod); }
.cand.sel { background: var(--accent); color: var(--surface); font-weight: 600; }
.cand.sel + .cand, .cand + .cand.sel { border-left-color: transparent; }
.cand.hover { background-color: var(--hover); }
.keys { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.row { flex: 1; display: flex; min-height: 0; }
/* Candidates on the left (fjk): a panel with the reading, a wrapping list that scrolls down, the toolbar. */
.kb.side { flex-direction: row; gap: 4px; }
.sidep { flex: 0 0 40%; display: flex; flex-direction: column; min-width: 0; border-radius: var(--radius);
  background: var(--key); padding: 4px; box-sizing: border-box; }
.kb.side .comp { flex: 1; flex-direction: column; align-items: stretch; margin: 0; gap: 4px; min-height: 0; }
.kb.side .pre { max-width: none; align-self: flex-start; font-size: 18px; }
.kb.side .list { flex-wrap: wrap; align-content: flex-start; gap: 2px; }
.kb.side .cand { height: 36px; font-size: 19px; }
.kb.side .cand + .cand { border-left: none; }
.hint { flex: 1 1 100%; align-self: stretch; display: flex; align-items: center; justify-content: center;
  text-align: center; color: var(--legend); font-size: 13px; }
.kb.side .list:has(.hint) { align-content: stretch; }
.kb.side .bar { border-top: 1px solid var(--mod); padding-top: 3px; }
.kb.side .bar .cands { visibility: hidden; }
.key { flex: 1 1 0; position: relative; display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; border: 1.5px solid transparent; background: var(--key); background-clip: padding-box;
  border-radius: var(--radius); overflow: hidden; min-width: 0; }
.key.mod, .key.named, .key.action { background-color: var(--mod); font-size: 13px; }
.key.gap { background: none; }
.key svg { font-size: 18px; }
.sh, .fn { position: absolute; top: 4px; font-size: var(--legend-size); line-height: 1; }
.sh { color: var(--legend); }
.fn { color: var(--fn); }
.key.tri .sh { left: 6px; }
.key.tri .fn { right: 6px; }
.key.stack .sh { left: 0; right: 0; text-align: center; }
.key.tri .lbl, .key.stack .lbl { position: absolute; bottom: 5px; left: 0; right: 0; text-align: center; }
.key[data-k="fn"] { color: var(--fn); }
.key[data-k="fn"].on { box-shadow: inset 0 0 0 2px var(--fn); }
.key[data-k="fn"].locked { background-color: var(--fn); color: var(--surface); }
.key.hover { background-color: var(--hover); }
.key.on { box-shadow: inset 0 0 0 2px var(--accent); }
.key.locked { background-color: var(--accent); color: var(--surface); }
.key.down { filter: brightness(1.5); }
/* A large layout (the 12-key): fjk's sizes, for keys read through the headset. */
.kb.large .key.flick { font-size: 26px; }
.kb.large .key.named, .kb.large .key.action, .kb.large .key.char { font-size: 20px; }
.kb.large .key[data-k="modify"] { font-size: 21px; container-type: inline-size; }
/* ゛゜小 on one line, shrinking on a narrow key (the 五十音 grid). */
.kb.large .key[data-k="modify"] .lbl { white-space: nowrap; font-size: min(21px, 27cqw); }
/* Flick hints (option): each direction's kana small at the key's left, top, right and bottom edge. */
.key .fh { position: absolute; font-size: 11px; line-height: 1; color: var(--legend); pointer-events: none; }
.key .fh.l { left: 5px; top: 50%; transform: translateY(-50%); }
.key .fh.u { top: 3px; left: 50%; transform: translateX(-50%); }
.key .fh.r { right: 5px; top: 50%; transform: translateY(-50%); }
.key .fh.d { bottom: 3px; left: 50%; transform: translateX(-50%); }
.kb.large .key svg { width: 1.35em; height: 1.35em; }
/* Text arrows as frame-jp-keyboard draws them (all four the same: Noto Sans CJK, 22px). */
.kb.large .key.named[data-k^="Arrow"]:not(:has(svg)) { font: 400 22px/1 "Noto Sans CJK JP", "Noto Sans JP", var(--font); }
.kb.large .bar .key { font-size: 14px; }
.kb.large .bar .key svg { width: 1em; height: 1em; }
/* The flick guide: the key's kana in a cross around it, in the hold popup's look; the pick in accent. */
.fl { position: absolute; z-index: 2; pointer-events: none; }
.fl div { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: var(--radius); font-size: inherit; background-color: var(--key);
  background-image: linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6); }
.fl div.pick { background-color: var(--accent); background-image: none; color: var(--surface); transform: scale(1.08); }
.fl div.empty { opacity: 0.35; }
/* A JIS key: Latin legends on the left, kana on the right (Shift above, plain below). The mode's side is
   bright, the character the key types now biggest; the other side is drawn like a Shift legend. */
.key.dual .q { position: absolute; line-height: 1; font-size: var(--legend-size); color: var(--legend); } /* as a Shift legend */
.key.dual .q.ls { top: 4px; left: 5px; }
.key.dual .q.ll { bottom: 5px; left: 5px; }
.key.dual .q.ks { top: 4px; right: 5px; }
.key.dual .q.kl { bottom: 5px; right: 5px; }
.key.dual .q.cur { color: var(--text); font-size: var(--label); } /* the English keys' sizes */
.key.dual .q.dot { outline: 1px dotted color-mix(in srgb, currentColor 60%, transparent); outline-offset: 0;
  line-height: 0.9; min-width: 0.8em; text-align: center; border-radius: 1px; } /* a tight square round the legend, as on a keycap */
/* The JIS Enter: two rows high, wider above; its halves meet across the row gap. */
/* Romaji input: no kana; the Latin legends sit in the middle like the English keys (Shift above, plain below;
   a letter alone in the middle). */
.kb.romaji .key.dual .q.ks, .kb.romaji .key.dual .q.kl { display: none; }
.kb.romaji .key.dual .q.ls, .kb.romaji .key.dual .q.ll { left: 50%; transform: translateX(-50%); }
.kb.romaji .key.dual:has(.q.ls:empty) .q.ll { bottom: auto; top: 50%; transform: translate(-50%, -50%); }
/* A long press's character, small in the top right (the QWERTY page's digits). */
.key .hn { position: absolute; top: 4px; right: 6px; font-size: var(--legend-size); line-height: 1; color: var(--legend); }
/* The ABC keys: the label with its digit small beneath. */
.key.subbed { flex-direction: column; }
.key .sub { font-size: 13px; line-height: 1; margin-top: 3px; color: var(--legend); }
.kb.large .key.mod.labelled { font-size: 20px; }
/* The 12-key's mode key: あ and a, the current mode's in bold. */
.key .pair { font-weight: 300; opacity: 0.7; }
.key .pair.now { font-weight: 700; opacity: 1; }
.key .pair + .pair { margin-left: 0.5px; font-size: 1.6em; line-height: 0.6; } /* a sits against あ, one glyph */
.kb .key.tall-top { border-bottom-width: 0; border-bottom-right-radius: 0; overflow: visible; z-index: 1; }
/* The label sits across both rows (the rows are the same height). */
.kb .key.tall-top > .lbl { position: relative; top: calc(50% + 1.5px); }
.kb .key.tall-bottom { border-top-width: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
`;

const ACTION_ICONS: Partial<Record<string, IconName>> = {
  settings: 'settings', emoji: 'emoji', dictate: 'dictate', copy: 'copy', cut: 'cut', paste: 'paste', menu: 'menu',
  hide: 'hide', 'next-keyboard': 'globe',
};

/** In a large layout (the 12-key), these keys draw icons too: font glyphs render tiny in the headset (fjk). */
const LARGE_ICONS: Partial<Record<string, IconName>> = {
  undo: 'undo', Backspace: 'backspaceTag', Enter: 'enter', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'space',
};

/** The icon a key shows, if any (Shift and Caps change icon when locked). */
const iconFor = (key: KeyDef, mods: Mods, large: boolean): IconName | undefined => {
  if ('label' in key && key.label) return undefined;
  const id = key.type === 'action' ? key.action : key.type === 'key' ? key.key : key.type === 'char' && key.char === ' ' ? ' ' : '';
  if (large && LARGE_ICONS[id]) return LARGE_ICONS[id];
  if (id === ' ') return 'space'; // a space key without a label: ⎵
  if (key.type === 'action') return ACTION_ICONS[key.action];
  if (key.type === 'key' && key.key === 'Backspace') return 'backspace';
  if (key.type !== 'mod') return undefined;
  if (key.mod === 'super') return 'frame';
  if (key.mod === 'shift') return mods.shift === 'locked' ? 'shiftLocked' : 'shift';
  if (key.mod === 'caps') return mods.caps ? 'capsOn' : 'caps';
  return undefined;
};

/** Which half of a two-row key this is (the JIS Enter, the 50-sound keyboard's あa and Enter). */
const tallOf = (key: KeyDef): 'top' | 'bottom' | undefined => ((key.type === 'key' || key.type === 'action') ? key.tall : undefined);

/** Small legends: the Shift character (not for letters) and the Fn variant. */
const legends = (key: KeyDef, mods: Mods): { sh: string; fn: string } => {
  if (key.type !== 'char' && key.type !== 'key') return { sh: '', fn: '' };
  const fnOn = mods.fn !== 'off' && key.fn;
  const fn = key.fn && !fnOn ? keyLabel(normalizeFn(key.fn), mods) : '';
  if (key.type !== 'char' || fnOn || !key.shift) return { sh: '', fn };
  const shown = charText(key, mods);
  return { sh: shown === key.shift ? key.char : key.shift, fn };
};

/** The reading buffer for the bar: typing (with the caret) or converting (segments, one focused). */
export type CompositionView = (
  | { readonly before: string; readonly after: string }
  | { readonly segments: readonly string[]; readonly focus: number }
) & { readonly candidates: readonly string[]; readonly selected: number };

export interface View {
  update(mods: Mods): void;
  /** 英数 (true) or かな mode, for JIS keys' legends; shown at the next update(). */
  setMode(latin: boolean): void;
  /** Show the reading buffer and its candidates in the bar instead of word suggestions (null: hide). */
  setComposition(composition: CompositionView | null): void;
  /** Replace keys' labels by data-k id (空白 → 変換 while there is a reading); {} restores them. */
  setLabels(labels: Readonly<Record<string, string>>): void;
  /** Fill the three suggestion slots ([left, best, right]); undefined leaves a slot empty. */
  setSuggestions(words: readonly (string | undefined)[]): void;
  /** Hover the key at popup coordinates (the laser); returns true when the hovered key changed. */
  hoverAt(x: number, y: number): boolean;
  setBounds(rect: { top: number; left: number; width: number; height: number }): void;
  destroy(): void;
}

export const createView = (
  doc: Document,
  shadow: ShadowRoot,
  layout: Layout,
  theme: Theme,
  /** A tap, a long press that chose `alternate` (its text), or a repeat of a held key. */
  onKey: (key: KeyDef, alternate?: string, repeat?: boolean) => void,
  onSuggestion: (word: string) => void = () => {},
  /** A candidate picked in the bar: its text and its place in the list. */
  onCandidate: (text: string, index: number) => void = () => {},
  /**
   * side: the reading and candidates in a panel left of the keys (fjk), instead of in the top bar.
   * hints: each flick key's other kana at its edges. idleHint: shown where candidates appear, while empty.
   */
  { side = false, hints = false, idleHint = '', latin: startLatin = false, romaji = false }:
    { side?: boolean; hints?: boolean; idleHint?: string; latin?: boolean; romaji?: boolean } = {},
): View => {
  /** 英数 mode: JIS keys type their Latin legends; otherwise their kana. */
  let latin = startLatin;
  /** Romaji input: JIS keys type their Latin legends in かな mode too. */
  const latinKeys = (): boolean => latin || romaji;
  const dotted = new Set(Array.from(layout.dotted ?? ''));
  const style = doc.createElement('style');
  style.textContent = CSS + HOLD_POPUP_CSS;
  const root = doc.createElement('div');
  root.className = layout.large ? 'kb large' : 'kb';
  if (romaji) root.classList.add('romaji');
  const c = theme.colors;
  root.style.cssText = `--surface:${c.surface};--key:${c.key};--text:${c.keyText};--mod:${c.modifier};`
    + `--accent:${c.accent};--legend:${c.legend ?? c.keyText};--fn:${c.fnLegend ?? c.accent};`
    + `--hover:${c.hover ?? c.modifier};--radius:${theme.radius ?? 6}px;--font:${theme.font ?? 'system-ui, sans-serif'};`;

  /** A JIS key's four legends: Latin Shift and plain, kana Shift and plain. */
  type Quad = { ls: HTMLElement; ll: HTMLElement; ks: HTMLElement; kl: HTMLElement };
  type Entry = { el: HTMLElement; key: KeyDef; label: HTMLElement; sh: HTMLElement; fn: HTMLElement; quad?: Quad; twin?: Entry };
  const keys: Entry[] = [];
  const widthOf = (key: KeyDef): number => ('w' in key && key.w !== undefined ? key.w : 1);
  const makeKey = (key: KeyDef, rowUnits?: number): HTMLElement => {
    const el = doc.createElement('div');
    el.className = `key ${key.type === 'char' ? 'char' : key.type === 'key' ? 'named' : key.type}`;
    // An exact share of the row, so keys line up across rows whatever their count.
    if (rowUnits) el.style.flex = `0 0 ${(widthOf(key) / rowUnits) * 100}%`;
    el.dataset['k'] = key.type === 'char' ? key.char : key.type === 'key' ? key.key
      : key.type === 'mod' ? key.mod : key.type === 'action' ? key.action : key.type === 'flick' ? key.flick[0] : '';
    const label = doc.createElement('span');
    label.className = 'lbl';
    const sh = doc.createElement('span');
    sh.className = 'sh';
    const fn = doc.createElement('span');
    fn.className = 'fn';
    el.append(sh, label, fn);
    let quad: Quad | undefined;
    if (key.type === 'char' && key.kana) {
      el.classList.add('dual');
      const q = (cls: string): HTMLElement => Object.assign(doc.createElement('span'), { className: `q ${cls}` });
      quad = { ls: q('ls'), ll: q('ll'), ks: q('ks'), kl: q('kl') };
      el.append(quad.ls, quad.ll, quad.ks, quad.kl);
    }
    const tall = tallOf(key);
    if (tall) el.classList.add(`tall-${tall}`);
    if (key.type === 'char' && key.hint) el.append(Object.assign(doc.createElement('span'), { className: 'hn', textContent: key.hint }));
    if (key.type === 'mod' && key.label) el.classList.add('labelled'); // text, not an icon (a↔A)
    if (key.type === 'flick' && key.sub && !(hints || key.hints)) {
      el.classList.add('subbed');
      el.append(Object.assign(doc.createElement('span'), { className: 'sub', textContent: key.sub }));
    }
    if (key.type === 'flick' && (hints || key.hints)) {
      key.flick.slice(1).forEach((text, i) => {
        if (!text) return;
        const hint = doc.createElement('span');
        hint.className = `fh ${'lurd'[i]}`;
        hint.textContent = text;
        el.append(hint);
      });
      if (key.label) label.textContent = key.flick[0]; // the hints show the rest
    }
    keys.push({ el, key, label, sh, fn, ...(quad ? { quad } : {}) });
    return el;
  };

  const bar = doc.createElement('div');
  bar.className = 'bar';
  const toolbar = layout.toolbar ?? [];
  for (const key of toolbar.filter((k) => k.action !== 'hide')) bar.append(makeKey(key));
  const cands = doc.createElement('div');
  cands.className = 'cands';
  const slots = [0, 1, 2].map((i) => {
    const el = doc.createElement('div');
    el.className = i === 1 ? 'sugg best' : 'sugg';
    cands.append(el);
    return { el, word: undefined as string | undefined };
  });
  bar.append(cands);
  const comp = doc.createElement('div');
  comp.className = 'comp';
  const pre = doc.createElement('div');
  pre.className = 'pre';
  const list = doc.createElement('div');
  list.className = 'list';
  comp.append(pre, list);
  bar.append(comp);
  let candidates: { el: HTMLElement; text: string; index: number }[] = [];
  let labels: Readonly<Record<string, string>> = {};
  for (const key of toolbar.filter((k) => k.action === 'hide')) bar.append(makeKey(key)); // close sits at the right end
  const keysEl = doc.createElement('div');
  keysEl.className = 'keys';
  for (const row of layout.rows) {
    const rowEl = doc.createElement('div');
    rowEl.className = 'row';
    const defs = row.map(normalizeKey);
    const units = defs.reduce((sum, key) => sum + widthOf(key), 0);
    for (const key of defs) rowEl.append(makeKey(key, units));
    keysEl.append(rowEl);
  }
  // A two-row key's halves act as one: each hovers and presses with the other.
  for (const top of keys.filter((e) => tallOf(e.key) === 'top')) {
    const bottom = keys.find((e) => tallOf(e.key) === 'bottom' && !e.twin && e.el.dataset['k'] === top.el.dataset['k']);
    if (bottom) {
      top.twin = bottom;
      bottom.twin = top;
    }
  }
  const mark = (entry: Entry | undefined, cls: string, on: boolean): void => {
    entry?.el.classList.toggle(cls, on);
    entry?.twin?.el.classList.toggle(cls, on);
  };
  if (side && toolbar.length) {
    // fjk's arrangement: reading and candidates on the left above the toolbar, keys on the right.
    root.classList.add('side');
    const panel = doc.createElement('div');
    panel.className = 'sidep';
    comp.classList.add('on');
    panel.append(comp, bar);
    root.append(panel, keysEl);
  } else {
    if (toolbar.length) root.append(bar);
    root.append(keysEl);
  }

  const entryFor = (target: EventTarget | null): Entry | undefined =>
    keys.find(({ el }) => el === target || el.contains(target as Node));
  const slotFor = (target: EventTarget | null) => slots.find(({ el, word }) => word && (el === target || el.contains(target as Node)));
  const candFor = (target: EventTarget | null) => candidates.find(({ el }) => el === target || el.contains(target as Node));
  let hoveredCand: HTMLElement | undefined;
  const setCandHover = (el: HTMLElement | undefined): boolean => {
    if (el === hoveredCand) return false;
    hoveredCand?.classList.remove('hover');
    hoveredCand = el;
    el?.classList.add('hover');
    return true;
  };
  let hoveredSlot: (typeof slots)[number] | undefined;
  const setSlotHover = (slot: (typeof slots)[number] | undefined): boolean => {
    if (slot === hoveredSlot) return false;
    hoveredSlot?.el.classList.remove('hover');
    hoveredSlot = slot;
    slot?.el.classList.add('hover');
    return true;
  };
  let pressed: Entry | undefined;
  let hovered: Entry | undefined;
  let lastTouchAt = -Infinity;
  let mods: Mods = NO_MODS;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let repeated = false;
  let lastPoint: { x: number; y: number } | null = null;
  let popup: { hold: HoldPopup; texts: string[]; key: KeyDef } | null = null;
  // A held flick key: where the press started and its guide (one cell per direction that has a kana).
  let flick: { key: Extract<KeyDef, { type: 'flick' }>; start: { x: number; y: number }; el: HTMLElement;
    cells: HTMLElement[]; pick: number } | null = null;

  /**
   * Show the guide over the key: the tap kana in the middle, the flick kana left, above, right and below.
   * Sized like fjk's: square cells 94% of the key's height, one key height apart, kana at 62% of the
   * cell; a direction with nothing is shown faded. The cross moves inward where it would leave the keyboard.
   */
  const openFlick = (entry: Entry, start: { x: number; y: number }): void => {
    if (entry.key.type !== 'flick') return;
    const at = entry.el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const step = Math.min(at.width, at.height) || FLICK_CELL_PX;
    const size = Math.round(step * 0.94);
    const clamp = (v: number, max: number): number => Math.min(Math.max(v, step * 1.5), Math.max(step * 1.5, max - step * 1.5));
    const cx = clamp(at.left - box.left + at.width / 2, box.width);
    const cy = clamp(at.top - box.top + at.height / 2, box.height);
    const el = doc.createElement('div');
    el.className = 'fl';
    Object.assign(el.style, { left: `${cx - size / 2}px`, top: `${cy - size / 2}px`, fontSize: `${Math.round(size * 0.62)}px` });
    const place: [number, number][] = [[0, 0], [-1, 0], [0, -1], [1, 0], [0, 1]];
    const cells = entry.key.flick.map((text, i) => {
      const cell = doc.createElement('div');
      const [dx, dy] = place[i]!;
      Object.assign(cell.style, { left: `${dx * step}px`, top: `${dy * step}px`, width: `${size}px`, height: `${size}px` });
      if (!text) cell.className = 'empty';
      cell.textContent = flickText(text, mods); // capitals while a/A (Shift) is on
      el.append(cell);
      return cell;
    });
    root.append(el);
    flick = { key: entry.key, start, el, cells, pick: 0 };
    cells[0]?.classList.add('pick');
  };
  const moveFlick = (p: { x: number; y: number }): void => {
    if (!flick) return;
    const pick = DIRECTIONS.indexOf(flickDirection(p.x - flick.start.x, p.y - flick.start.y));
    if (pick === flick.pick) return;
    flick.cells[flick.pick]?.classList.remove('pick');
    flick.pick = pick;
    flick.cells[pick]?.classList.add('pick');
  };
  const closeFlick = (): void => {
    flick?.el.remove();
    flick = null;
  };

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    if (repeatTimer !== null) clearInterval(repeatTimer);
    repeatTimer = null;
  };
  const closePopup = (): void => {
    popup?.hold.close();
    popup = null;
  };
  /** A row of alternates above the held key (below it on the top row), starting on the key itself. */
  const openPopup = (entry: Entry, startX: number | null, startY: number | null): void => {
    const texts = alternates(kanaSide(entry.key, !latinKeys()), mods);
    if (texts.length < 2) return;
    const at = entry.el.getBoundingClientRect();
    const size = { width: at.width * POPUP_SCALE, height: at.height * POPUP_SCALE };
    const start = startX !== null && startY !== null ? { x: startX, y: startY } : null;
    popup = { hold: openHoldPopup(doc, shadow, root, at, texts, size, start), texts, key: entry.key };
  };
  const pickAt = (x: number, y: number): void => popup?.hold.pickAt(x, y);
  const setHover = (entry: Entry | undefined): boolean => {
    if (entry === hovered || (entry && entry === hovered?.twin)) return false;
    mark(hovered, 'hover', false);
    hovered = entry && entry.key.type !== 'gap' ? entry : undefined;
    mark(hovered, 'hover', true);
    return true;
  };
  // Dragging the candidate list scrolls it (across on top, down on the left); a press that does not
  // move past the slop picks the candidate under it on release.
  let listDrag: { x: number; y: number; left: number; top: number; moved: boolean; cand: ReturnType<typeof candFor> } | null = null;
  const scrollList = (dx: number, dy: number): void => {
    if (side) list.scrollTop += dy;
    else list.scrollLeft += Math.abs(dx) > Math.abs(dy) ? dx : dy;
  };
  root.addEventListener('wheel', (e) => {
    if (!list.contains(e.target as Node) && e.target !== list) return;
    e.preventDefault();
    scrollList(e.deltaX, e.deltaY);
  }, { passive: false });

  root.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (list.contains(e.target as Node) || e.target === list) {
      const t = (e as TouchEvent).changedTouches?.[0];
      listDrag = { x: t?.clientX ?? 0, y: t?.clientY ?? 0, left: list.scrollLeft, top: list.scrollTop, moved: false, cand: candFor(e.target) };
      return;
    }
    pressed = entryFor(e.target);
    mark(pressed, 'down', true);
    clearHold();
    const held = pressed;
    const start = (e as TouchEvent).changedTouches?.[0];
    lastPoint = start ? { x: start.clientX, y: start.clientY } : null;
    repeated = false;
    if (held?.key.type === 'flick') {
      openFlick(held, lastPoint ?? { x: 0, y: 0 });
      return;
    }
    if (held && repeats(held.key)) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        repeated = true;
        onKey(held.key, undefined, true);
        repeatTimer = setInterval(() => onKey(held.key, undefined, true), REPEAT_MS);
      }, REPEAT_DELAY_MS);
    } else if (held) holdTimer = setTimeout(() => {
      holdTimer = null;
      openPopup(held, lastPoint?.x ?? null, lastPoint?.y ?? null);
    }, LONG_PRESS_MS);
  }, { passive: false });
  root.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const touch = (e as TouchEvent).changedTouches?.[0];
    if (!touch) return;
    lastPoint = { x: touch.clientX, y: touch.clientY };
    if (listDrag) {
      const dx = touch.clientX - listDrag.x;
      const dy = touch.clientY - listDrag.y;
      if (Math.hypot(dx, dy) > LIST_SLOP_PX) listDrag.moved = true;
      if (listDrag.moved) {
        if (side) list.scrollTop = listDrag.top - dy;
        else list.scrollLeft = listDrag.left - dx;
      }
      return;
    }
    if (flick) moveFlick(lastPoint);
    else pickAt(touch.clientX, touch.clientY);
  }, { passive: false });
  root.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    lastTouchAt = Date.now();
    clearHold();
    const hit = pressed;
    pressed = undefined;
    mark(hit, 'down', false);
    if (listDrag) {
      const { moved, cand } = listDrag;
      listDrag = null;
      if (!moved && cand) onCandidate(cand.text, cand.index);
      return;
    }
    if (flick) {
      if (lastPoint) moveFlick(lastPoint);
      const { key, pick } = flick;
      closeFlick();
      if (pick === 0) onKey(key); // a tap: the 12-key decides (it may cycle)
      else if (key.flick[pick]) onKey(key, key.flick[pick]); // a direction with nothing types nothing
      return;
    }
    const slot = slotFor(e.target);
    if (slot?.word) {
      onSuggestion(slot.word);
      return;
    }
    const cand = candFor(e.target);
    if (cand) {
      onCandidate(cand.text, cand.index);
      return;
    }
    if (popup) {
      const chosen = popup.texts[popup.hold.pick];
      const key = popup.key;
      closePopup();
      if (chosen !== undefined) onKey(key, chosen);
      return;
    }
    if (repeated) return; // a held key already typed while held
    if (hit && hit.key.type !== 'gap') onKey(hit.key);
  }, { passive: false });
  root.addEventListener('touchcancel', () => {
    clearHold();
    closePopup();
    closeFlick();
    listDrag = null;
    mark(pressed, 'down', false);
    pressed = undefined;
  });
  root.addEventListener('mouseover', (e) => { setHover(entryFor(e.target)); setSlotHover(slotFor(e.target)); });
  root.addEventListener('mouseleave', () => setHover(undefined));
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - lastTouchAt < TOUCH_MOUSE_GUARD_MS) return;
    const slot = slotFor(e.target);
    if (slot?.word) {
      onSuggestion(slot.word);
      return;
    }
    const cand = candFor(e.target);
    if (cand) {
      onCandidate(cand.text, cand.index);
      return;
    }
    const hit = entryFor(e.target);
    if (hit && hit.key.type !== 'gap') onKey(hit.key);
  });

  /** Fill a JIS key's legends: the mode's side bright, the character it types now biggest. */
  const showQuad = (quad: Quad, key: Extract<KeyDef, { type: 'char' }>): void => {
    const letter = key.char.toLowerCase() !== key.char.toUpperCase();
    const shiftOn = mods.shift !== 'off';
    const latinNow = charText(key, mods);
    const set = (el: HTMLElement, text: string, active: boolean, current: boolean): void => {
      el.textContent = text;
      el.classList.toggle('act', active);
      el.classList.toggle('cur', active && current);
      el.classList.toggle('dot', dotted.has(text));
    };
    // A letter has one Latin legend, in the case it types now.
    const onLatin = latinKeys();
    set(quad.ll, letter ? latinNow : key.char, onLatin, letter || latinNow === key.char);
    set(quad.ls, letter ? '' : key.shift ?? '', onLatin, !letter && latinNow !== key.char);
    set(quad.kl, key.kana ?? '', !onLatin, !shiftOn || !key.kanaShift);
    set(quad.ks, key.kanaShift ?? '', !onLatin, shiftOn);
  };

  shadow.append(style, root);

  return {
    update: (next) => {
      mods = next;
      for (const { el, key, label, sh, fn, quad } of keys) {
        if (key.type === 'action' && (key.action === 'eisu' || key.action === 'kana')) {
          el.classList.toggle('on', (key.action === 'eisu') === latin); // the current mode's key
        }
        if (quad && key.type === 'char') {
          showQuad(quad, key);
          continue;
        }
        if (tallOf(key) === 'bottom') continue; // the label is on the top half
        if (key.type === 'mod') {
          const state = modState(mods, key.mod);
          el.classList.toggle('on', state.on);
          el.classList.toggle('locked', state.locked);
        }
        const id = el.dataset['k'] ?? '';
        const icon = labels[id] === undefined ? iconFor(key, mods, layout.large === true) : undefined;
        const pair = key.type === 'action' && (key.action === 'eisu' || key.action === 'kana' || key.action === 'symbols')
          && key.label?.includes(' ')
          ? key.label.split(' ') : null;
        if (labels[id] !== undefined) label.textContent = labels[id]!;
        else if (pair) {
          label.textContent = '';
          pair.forEach((text, i) => label.append(Object.assign(doc.createElement('span'), {
            className: (i === 1) === latin ? 'pair now' : 'pair', textContent: text })));
        }
        else if (key.type === 'flick' && (hints || key.hints)) label.textContent = key.flick[0];
        else if (icon) label.innerHTML = ICONS[icon];
        else label.textContent = keyLabel(key, mods);
        const small = legends(key, mods);
        sh.textContent = small.sh;
        fn.textContent = small.fn;
        // With an Fn legend: Shift top left, Fn top right, label bottom middle; with only a Shift legend:
        // Shift top middle, label bottom middle, like a keycap.
        el.classList.toggle('tri', small.fn !== '');
        el.classList.toggle('stack', small.fn === '' && small.sh !== '');
      }
    },
    setMode: (next) => {
      latin = next;
    },
    setComposition: (c) => {
      const showing = c !== null || side || idleHint !== '';
      comp.classList.toggle('on', showing);
      if (!side) cands.style.display = showing ? 'none' : '';
      pre.textContent = '';
      list.textContent = '';
      candidates = [];
      hoveredCand = undefined;
      if (!c) {
        if (idleHint) list.append(Object.assign(doc.createElement('div'), { className: 'hint', textContent: idleHint }));
        return;
      }
      const span = (text: string, cls: string): HTMLElement => {
        const el = doc.createElement('span');
        el.className = cls;
        el.textContent = text;
        return el;
      };
      pre.classList.toggle('converting', 'segments' in c);
      if ('segments' in c) c.segments.forEach((text, i) => pre.append(span(text, i === c.focus ? 'seg focus' : 'seg')));
      else pre.append(span(c.before, 'seg'), span('', 'caret'), span(c.after, 'seg'));
      c.candidates.forEach((text, index) => {
        const el = span(text, index === c.selected ? 'cand sel' : 'cand');
        list.append(el);
        candidates.push({ el, text, index });
      });
      // Keep the picked candidate in view; otherwise start from the top of the list.
      const sel = candidates[c.selected]?.el;
      list.scrollLeft = !side && sel && sel.offsetLeft + sel.offsetWidth > list.clientWidth ? sel.offsetLeft - 8 : 0;
      list.scrollTop = side && sel && sel.offsetTop + sel.offsetHeight > list.clientHeight ? sel.offsetTop - 4 : 0;
    },
    setLabels: (next) => {
      labels = next;
    },
    setSuggestions: (words) => {
      slots.forEach((slot, i) => {
        slot.word = words[i];
        slot.el.textContent = words[i] ?? '';
      });
      if (hoveredSlot && !hoveredSlot.word) setSlotHover(undefined);
    },
    hoverAt: (x, y) => {
      if (flick) return false; // a flick follows the touch alone
      if (popup) {
        pickAt(x, y);
        return false;
      }
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      const candChanged = setCandHover(hits.map(candFor).find(Boolean)?.el);
      const slotChanged = setSlotHover(hits.map(slotFor).find(Boolean)) || candChanged;
      return setHover(hits.map(entryFor).find(Boolean)) || slotChanged;
    },
    setBounds: ({ top, left, width, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    },
    destroy: () => { clearHold(); closePopup(); closeFlick(); style.remove(); root.remove(); },
  };
};
