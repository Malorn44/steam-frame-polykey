// The keyboard as DOM inside our shadow root: built once per layout; update() changes labels, small
// Shift/Fn legends and modifier highlights. Gaps are transparent borders, so key positions follow
// the width weights exactly and columns line up across rows. The VR laser arrives as touch events
// (mouse clicks are the desktop fallback); hover comes from hoverAt() (laser) or mouseover.

import { normalizeKey, type KeyDef, type Layout, type Tall, type Theme } from '../core/catalog.js';
import type { MicState } from '../core/dictation.js';
import { NO_MODS, alternates, flickText, kanaSide, modState, type Mods } from '../core/keyboard.js';
import { HOLD_MS, RELEASE_LOST_MS, REPEAT_DELAY_MS, REPEAT_MS, SLOP_PX, touchGuard } from '../core/interaction.js';
import { DIRECTIONS, flickDirection } from '../core/kana.js';
import { keyLegends, type KeyLegends, type Legend, type SlotName } from '../core/legends.js';
import { SWIPE_MAX_POINTS, leftKey, resample, swipeLetter, type Point } from '../core/swipe.js';
import { HOLD_POPUP_CSS, openHoldPopup, type HoldPopup } from './hold-popup.js';
import { ICONS, defaultIcon, type IconName, type IconSet } from './icons.js';
import { dragScroll, listenTouch, type DragScroll, type TouchPoint } from './gesture.js';
import { MIC_CSS, micKey, type MicKey } from './mic.js';
import { sizeVars } from './sizes.js';
import { themeVars } from './theme.js';

const REPEATING = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const repeats = (key: KeyDef): boolean => (key.type === 'key' && REPEATING.has(key.key)) || (key.type === 'char' && key.char === ' ');
/** Flick guide cells when the key has no size yet (tests); otherwise square, as tall as the key (fjk). */
export const FLICK_CELL_PX = 30;
/** Full width: kana, CJK punctuation and ideographs, full-width forms (one character). */
const isWide = (text: string): boolean => /^[\u3000-\u30ff\u3400-\u9fff\uff01-\uff60\uffe0-\uffe6]$/u.test(text);
/** ゛゜ as combining marks on a full-width space: drawn where they sit on a kana (high right), not
 * where the spacing forms sit in their own cell (high left). */
const CELL_TEXT: Record<string, string> = { '゛': '\u3000\u3099', '゜': '\u3000\u309a' };
const cellText = (text: string): string => (isWide(text) && CELL_TEXT[text]) || text;
const isMark = (text: string): boolean => text === '゛' || text === '゜';

/** A dotted box's outline: a rectangle (rounded 2px) that fills whatever box it is drawn in, stroked
 * with dots 1px long, 2px apart. The stroke is 2px on the edge; the image's edge clips its outer half,
 * leaving 1px. */
const DOT_BOX = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%'><rect width='100%' height='100%' rx='2'"
  + " fill='none' stroke='black' stroke-width='2' stroke-dasharray='1 2'/></svg>")}")`;

/** The small legends' slots round the label (c). */
const SLOTS = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'] as const;

/** Alternate cells are a little smaller than the key. */
const POPUP_SCALE = 0.85;
/** The swipe trail fades out this long after the release. */
const TRAIL_FADE_MS = 250;
const SVG_NS = 'http://www.w3.org/2000/svg';

const CSS = `
:host { all: initial; }
.kb { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; padding: 2px;
  background: var(--surface); color: var(--text); font: 400 var(--size-base)/1 var(--font);
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.bar { height: var(--bar-height); display: flex; flex: none; }
.bar .key { flex: none; width: 30px; font-size: var(--size-bar-key); }
.bar .key[data-k="hide"] { width: 48px; font-size: calc(var(--size-bar-key) * 1.2); } /* a wide icon, and an easy target */
.cands { flex: 1; display: flex; min-width: 0; margin: 0 4px; }
/* Suggestions: text on the bar, not keys; thin dividers; the best (middle) in the accent colour. */
.sugg { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 0 6px;
  font-size: var(--size-suggestion); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: var(--radius); }
.sugg:not(:empty) + .sugg:not(:empty) { border-left: 1px solid var(--divider); }
.sugg.best { color: var(--accent); font-weight: 600; }
.sugg.hover { background-color: var(--hover); }
/* The reading buffer (12-key): underlined, with a caret; while converting, the focused segment is
   marked. Then the candidates, the picked one in the accent colour. */
.comp { flex: 1; display: none; align-items: center; min-width: 0; margin: 0 4px; gap: 8px; }
.comp.on { display: flex; }
.pre { flex: none; max-width: 45%; overflow: hidden; white-space: nowrap; font-size: var(--size-candidate);
  border-bottom: 1.5px solid var(--text); padding: 0 2px; }
.pre:empty { display: none; } /* no reading: no underline (it showed as a dot) */
.pre .seg { padding: 0 1px; }
.pre .seg.focus { background: var(--accent); color: var(--accent-text); border-radius: var(--radius-sm); }
.pre.converting .seg:not(.focus) { color: var(--legend); }
.pre .caret { display: inline-block; width: 1.5px; height: 1em; margin: 0 1px; vertical-align: -2px; background: var(--accent); }
.list { flex: 1; display: flex; min-width: 0; overflow: hidden; height: 100%; }
.cand { flex: none; display: flex; align-items: center; padding: 0 10px; font-size: var(--size-candidate); white-space: nowrap;
  border-radius: var(--radius); }
.cand + .cand { border-left: 1px solid var(--divider); }
.cand.sel { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.cand.sel + .cand, .cand + .cand.sel { border-left-color: transparent; }
.cand.hover { background-color: var(--hover); }
.keys { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.row { flex: 1; display: flex; min-height: 0; }
/* Candidates on the left (fjk): a panel with the reading, a wrapping list that scrolls down, the toolbar. */
.kb.side { flex-direction: row; gap: 4px; }
.sidep { flex: 0 0 40%; display: flex; flex-direction: column; min-width: 0; border-radius: var(--radius);
  background: var(--key); padding: 4px; box-sizing: border-box; }
.kb.side .comp { flex: 1; flex-direction: column; align-items: stretch; margin: 0; gap: 4px; min-height: 0; }
.kb.side .pre { max-width: none; align-self: flex-start; font-size: var(--size-side-reading); }
.kb.side .list { flex-wrap: wrap; align-content: flex-start; gap: 2px; }
.kb.side .cand { height: 36px; font-size: var(--size-side-candidate); }
.kb.side .cand + .cand { border-left: none; }
.list > .placeholder { flex: 1 1 100%; align-self: stretch; display: flex; align-items: center; justify-content: center;
  text-align: center; color: var(--legend); font-size: var(--size-placeholder); }
.kb.side .list:has(> .placeholder) { align-content: stretch; }
.kb.side .bar { border-top: 1px solid var(--divider); padding-top: 3px; }
.kb.side .bar .cands { visibility: hidden; }
.key { flex: 1 1 0; position: relative; display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; border: 1.5px solid transparent; background: var(--key); background-clip: padding-box;
  border-radius: var(--radius); overflow: hidden; min-width: 0; }
.key.mod, .key.named, .key.action { background-color: var(--mod); font-size: var(--size-mod); }
.key.gap { background: none; }
.key svg { font-size: var(--size-icon); }
.bar .key svg { font-size: var(--size-bar-icon); }
/* Legends round the label (src/core/legends.ts), by slot: tl t tr / l r / bl b br, inset by arrangement
   (plain and tri, the long-press character and Shift/Fn: 6px across; quad, a JIS key's four legends:
   5px; edges, flick hints: 5px across, 3px down). The label (c) is in the flow, in the middle, except
   under Shift (stack) or Shift and Fn (tri) legends, where it sits at the bottom. */
.key { --lg-x: 6px; --lg-top: 4px; --lg-bottom: 5px; }
.key.quad, .key.edges { --lg-x: 5px; }
.key.edges { --lg-top: 3px; --lg-bottom: 3px; }
.key .lg { position: absolute; line-height: 1; pointer-events: none; }
.lg.tl { top: var(--lg-top); left: var(--lg-x); }
.lg.tr { top: var(--lg-top); right: var(--lg-x); }
.lg.bl { bottom: var(--lg-bottom); left: var(--lg-x); }
.lg.br { bottom: var(--lg-bottom); right: var(--lg-x); }
.lg.t { top: var(--lg-top); left: 50%; transform: translateX(-50%); }
.lg.b { bottom: var(--lg-bottom); left: 50%; transform: translateX(-50%); }
.lg.l { left: var(--lg-x); top: 50%; transform: translateY(-50%); }
.lg.r { right: var(--lg-x); top: 50%; transform: translateY(-50%); }
.key .s-legend { font-size: var(--size-legend); }
.key .s-hint { font-size: var(--size-hint); }
.key .s-dual { font-size: var(--size-dual); }
.key .s-dual .mark { --mark-size: var(--size-mark); }
.key .t-legend { color: var(--legend); }
.key .t-fn { color: var(--fn); }
.key .t-text { color: var(--text); }
.key.tri .lbl, .key.stack .lbl { position: absolute; bottom: 5px; left: 0; right: 0; text-align: center; }
.key[data-k="fn"] { color: var(--fn); }
.key[data-k="fn"].on { box-shadow: inset 0 0 0 2px var(--fn); }
.key[data-k="fn"].locked { background-color: var(--fn); color: var(--fn-text); }
.key.hover { background-color: var(--hover); }
.key.on { box-shadow: inset 0 0 0 2px var(--ring); }
.key.action.on { box-shadow: inset 0 -3px 0 var(--indicator); } /* the current input mode (英数 / かな): a bar along its bottom, not Shift's ring */
.key.locked { background-color: var(--accent); color: var(--accent-text); }
.key.err { color: var(--error); } /* the mic key after a failed dictation */
.key.down { filter: var(--pressed); }
/* A large layout (the 12-key): fjk's sizes, for keys read through the headset. */
.kb.large .key.flick { font-size: var(--size-flick); }
.kb.large .key.named, .kb.large .key.action, .kb.large .key.char, .kb.large .key.mod { font-size: var(--size-label); }
.kb.large .key[data-k="modify"] { font-size: var(--size-modify); container-type: inline-size; }
/* ゛゜小 on one line, shrinking on a narrow key (the 五十音 grid). */
.kb.large .key[data-k="modify"] .lbl { white-space: nowrap; font-size: min(var(--size-modify), 27cqw); }
/* The modify key without a label of its own: ゛゜ boxed, 大⇔小 small beneath (as on Gboard's 12-key). */
.key .mk { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; line-height: 1; }
/* The boxes at the label's size (shrinking on the narrow 五十音 key); the marks larger. */
.key .mk-marks { display: flex; gap: 0.35em; --mark-size: var(--size-mark); }
.key .mk-size { font-size: var(--size-hint); color: var(--legend); white-space: nowrap; }
.kb.large .bar .key { font-size: var(--size-bar-key); }
/* The swipe trail, under the laser: one polyline, faded out by a transition after the release. */
.trail { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; overflow: visible; }
.trail polyline { fill: none; stroke: var(--accent); stroke-width: 4px; stroke-linecap: round; stroke-linejoin: round;
  opacity: 0.7; transition: opacity ${TRAIL_FADE_MS}ms ease-out; }
.trail.fade polyline { opacity: 0; }
/* The flick guide: the key's kana in a cross around it, in the hold popup's look; the pick in accent. */
.fl { position: absolute; z-index: 2; pointer-events: none; }
.fl div { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: var(--radius); font-size: inherit; background-color: var(--key);
  background-image: linear-gradient(var(--raised), var(--raised));
  box-shadow: var(--shadow); }
.fl div.pick { background-color: var(--accent); background-image: none; color: var(--accent-text); transform: scale(1.08); }
.fl div.empty { opacity: var(--opacity-dim); }
/* A box only shows placement: it never sets a size (that is the legend's role; see sizes.ts).
   A dotted box is the character's cell, as on JIS keycaps: one height for all, half width for a
   half-width character, full width for a full-width one, so it shows where in the cell the character
   sits (、。 low left, 「 and ゛゜ high right). */
.key .lg > .dot { vertical-align: top; } /* at the top of the small legend's line, as the legend's own text */
.key .dot { display: inline-block; position: relative; box-sizing: border-box; height: 1em; min-width: 0.55em; line-height: 1em;
  text-align: center; }
/* Dots we space ourselves (CSS dotted runs 1px dots 1px apart, which reads as a grey line): a rounded
   rectangle stroked with 1px dots 2px apart (DOT_BOX), as a mask over the legend's colour, just
   outside the box. */
.key .dot::before { content: ''; position: absolute; inset: -0.06em; pointer-events: none;
  background-color: color-mix(in srgb, currentColor 60%, transparent);
  -webkit-mask: ${DOT_BOX} 0 0 / 100% 100% no-repeat; mask: ${DOT_BOX} 0 0 / 100% 100% no-repeat; }
/* 0.888em puts Noto Sans CJK's em square exactly in the 1em box (its ascent is 1.16, descent 0.29). */
.key .dot.cell { width: 1em; min-width: 0; line-height: 0.888em; text-align: left;
  font-family: var(--font-cjk), var(--font); }
/* ゛ and ゜ fill only a corner of their cell, so they can be set larger (--mark-size) than their box:
   the box keeps the legend's size, and the mark's own cell is pinned to its top-right corner. */
.key .dot.mark .ch { position: absolute; top: 0; right: 0; width: 1em; height: 1em; line-height: 0.888em;
  text-align: left; font-size: var(--mark-size, 1em); }
/* The JIS Enter: two rows high, wider above; its halves meet across the row gap. */
/* The ABC keys: the label with its digit small beneath. */
.key.subbed { flex-direction: column; }
.key .sub { font-size: var(--size-sub); line-height: 1; margin-top: 3px; color: var(--legend); }
.kb.large .key.mod.labelled { font-size: var(--size-label); }
/* The 12-key's mode key: あ and a, the current mode's in bold. */
.key .pair { font-weight: 300; opacity: var(--opacity-muted); }
.key .pair.now { font-weight: 700; opacity: 1; }
.key .pair + .pair { margin-left: 0.5px; font-size: 1.6em; line-height: 0.6; } /* a sits against あ, one glyph */
.kb .key.tall-top { border-bottom-width: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; overflow: visible; z-index: 1; }
/* Notched (the JIS Enter, wider above): the top half's lower left is a corner of the key. */
.kb .key.tall-top.notched { border-bottom-left-radius: var(--radius); }
/* The label sits across both rows (the rows are the same height). */
.kb .key.tall-top > .lbl { position: relative; top: calc(50% + 1.5px); }
.kb .key.tall-top.span3 > .lbl { top: calc(100% + 3px); } /* three rows: across the middle piece */
.kb .key.tall-middle { border-top-width: 0; border-bottom-width: 0; border-radius: 0; } /* under the top piece, which draws the label */
.kb .key.tall-bottom { border-top-width: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
`;

/** What a key does, for its default icon: an action, a named key, a modifier, or " " for a space key. */
const iconId = (key: KeyDef): string => (key.type === 'action' ? key.action : key.type === 'key' ? key.key
  : key.type === 'mod' ? key.mod : key.type === 'char' && key.char === ' ' ? ' ' : '');

/**
 * The icon a key shows, if any: its own `icon` (null: text), else none when it has a label, else its
 * default in the layout's icon set; arrows draw as text with arrowStyle "glyph". Shift and Caps change
 * icon when locked.
 */
const iconFor = (key: KeyDef, mods: Mods, set: IconSet, arrows: 'icon' | 'glyph'): IconName | undefined => {
  const own = 'icon' in key ? key.icon : undefined;
  const id = iconId(key);
  const icon = own !== undefined ? (own !== null && own in ICONS ? own as IconName : undefined)
    : 'label' in key && key.label ? undefined
      : arrows === 'glyph' && id.startsWith('Arrow') ? undefined
        : defaultIcon(id, set);
  if (icon === 'shift' && mods.shift === 'locked') return 'shiftLocked';
  if (icon === 'caps' && mods.caps) return 'capsOn';
  return icon;
};

/** Which half of a two-row key this is (the JIS Enter, the 50-sound keyboard's あa and Enter). */
const tallOf = (key: KeyDef): Tall | undefined => ((key.type === 'key' || key.type === 'action') ? key.tall : undefined);

/** The reading buffer for the bar: typing (with the caret) or converting (segments, one focused). */
export type CompositionView = (
  | { readonly before: string; readonly after: string }
  | { readonly segments: readonly string[]; readonly focus: number }
) & { readonly candidates: readonly string[]; readonly selected: number };

/** A finished swipe: the path (evenly resampled), each letter key's centre, and a key's width, all in popup px. */
export type SwipeHandler = (path: Point[], keys: Record<string, [number, number]>, keyWidth: number) => void;

export interface View {
  update(mods: Mods): void;
  /** 英数 (true) or かな mode, for JIS keys' legends; shown at the next update(). */
  setMode(latin: boolean): void;
  /** Show the reading buffer and its candidates in the bar instead of word suggestions (null: hide). */
  setComposition(composition: CompositionView | null): void;
  /** Replace keys' labels by data-k id (空白 → 変換 while there is a reading); {} restores them. */
  setLabels(labels: Readonly<Record<string, string>>): void;
  /** The mic key's dictation state: listening is lit like a locked key, with bars; recognizing, a circling arc (ui/mic.ts). */
  setMic(state: MicState): void;
  /** The speech level's last five steps on the mic key's bars, while listening. */
  setMicLevels(levels: readonly number[]): void;
  /** A model download's progress along the mic key's foot (0..1), the key disabled; null: none. */
  setMicProgress(fraction: number | null): void;
  /** A phrase being recognized while continuous dictation listens on: the arc around the bars. */
  setMicBusy(busy: boolean): void;
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
   * hints: each flick key's other kana at its edges. placeholder: shown where candidates appear, while empty.
   */
  { side = false, hints = false, placeholder = '', latin: startLatin = false, romaji = false, symbols = 0, letters, keyboardMenu, onSwipe, canSwipe }:
    { side?: boolean; hints?: boolean; symbols?: 0 | 1 | 2; letters?: string | undefined; placeholder?: string; latin?: boolean; romaji?: boolean;
      /** Holding 🌐: the keyboards to pick from (ids, and names to show); the pick comes as its id. */
      keyboardMenu?: { ids: readonly string[]; names: readonly string[] };
      /** Swipe typing on: a press on a letter that leaves its key traces a word instead of typing. */
      onSwipe?: SwipeHandler | undefined;
      /** Whether a press may swipe now (a Japanese keyboard swipes only in 英数 mode); default yes. */
      canSwipe?: (() => boolean) | undefined } = {},
): View => {
  /** 英数 mode: JIS keys type their Latin legends; otherwise their kana. */
  let latin = startLatin;
  /** Romaji input: JIS keys type their Latin legends in かな mode too. */
  const latinKeys = (): boolean => latin || romaji;
  const dotted = new Set(Array.from(layout.dotted ?? ''));
  const iconSet: IconSet = layout.iconSet ?? (layout.large ? 'phone' : 'desktop');
  /** A dotted box round a legend: a full-width character's box is its whole cell. */
  const glyph = (text: string): HTMLElement => Object.assign(doc.createElement('span'), { className: 'ch', textContent: cellText(text) });
  const boxed = (text: string): HTMLElement => {
    const box = Object.assign(doc.createElement('span'), { className: `dot${isWide(text) ? ' cell' : ''}${isMark(text) ? ' mark' : ''}` });
    box.append(glyph(text));
    return box;
  };
  const style = doc.createElement('style');
  style.textContent = CSS + HOLD_POPUP_CSS + MIC_CSS;
  const root = doc.createElement('div');
  root.className = layout.large ? 'kb large' : 'kb';
  root.style.cssText = themeVars(theme) + sizeVars(layout.large ? 'large' : 'normal');

  /** A key: its element, its label (slot c) and the small legends it shows now, by slot. */
  type Entry = { el: HTMLElement; key: KeyDef; label: HTMLElement; slots: Partial<Record<SlotName, HTMLElement>>; under?: HTMLElement; pieces?: Entry[] };
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
    el.append(label);
    const tall = tallOf(key);
    if (tall) el.classList.add(`tall-${tall}`);
    if (tall === 'top' && 'notch' in key && key.notch) el.classList.add('notched');
    if (tall === 'top' && 'span' in key && key.span === 3) el.classList.add('span3');
    if (key.type === 'mod' && key.label) el.classList.add('labelled'); // text, not an icon (a↔A)
    keys.push({ el, key, label, slots: {} });
    return el;
  };

  /** The mic keys' visuals, made on first use. */
  let micKeys: MicKey[] | null = null;
  const mics = (): MicKey[] =>
    (micKeys ??= keys.filter((e) => e.key.type === 'action' && e.key.action === 'dictate').map(({ el }) => micKey(doc, el)));

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
  // A tall key's pieces act as one: each hovers and presses with the others.
  for (const top of keys.filter((e) => tallOf(e.key) === 'top')) {
    const span = 'span' in top.key && top.key.span === 3 ? 3 : 2;
    const pieces = [top];
    for (const tall of span === 3 ? ['middle', 'bottom'] as const : ['bottom'] as const) {
      const piece = keys.find((e) => tallOf(e.key) === tall && !e.pieces && e.el.dataset['k'] === top.el.dataset['k']);
      if (piece) pieces.push(piece);
    }
    if (pieces.length > 1) for (const piece of pieces) piece.pieces = pieces;
  }
  const mark = (entry: Entry | undefined, cls: string, on: boolean): void => {
    for (const piece of entry?.pieces ?? (entry ? [entry] : [])) piece.el.classList.toggle(cls, on);
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
  const guard = touchGuard();
  let mods: Mods = NO_MODS;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let repeated = false;
  let lastPoint: { x: number; y: number } | null = null;
  let popup: { hold: HoldPopup; texts: string[]; key: KeyDef } | null = null;
  // A press on a letter that may become a swipe: where it started, the path so far, and (once it left
  // the key) its trail. Only a swipe that left its key is one; until then it is a tap or a hold.
  let swipe: { start: Point; points: Point[]; rect: DOMRect; on: boolean; at: number;
    trail?: { svg: SVGSVGElement; line: SVGPolylineElement; origin: DOMRect; drawn: string } } | null = null;
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

  const trailPoint = (origin: DOMRect, p: Point): string => `${Math.round(p.x - origin.left)},${Math.round(p.y - origin.top)} `;
  const drawTrail = (p: Point): void => {
    if (!swipe?.trail) return;
    swipe.trail.drawn += trailPoint(swipe.trail.origin, p);
    swipe.trail.line.setAttribute('points', swipe.trail.drawn);
  };
  const openTrail = (): void => {
    if (!swipe) return;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'trail');
    const line = doc.createElementNS(SVG_NS, 'polyline');
    svg.append(line);
    root.append(svg);
    const origin = root.getBoundingClientRect();
    swipe.trail = { svg, line, origin, drawn: swipe.points.map((p) => trailPoint(origin, p)).join('') };
    line.setAttribute('points', swipe.trail.drawn);
  };
  /** End the swipe; its trail fades (after a swipe that typed) or goes at once. */
  const endSwipe = (fade: boolean): void => {
    const svg = swipe?.trail?.svg;
    swipe = null;
    if (!svg) return;
    if (!fade) {
      svg.remove();
      return;
    }
    svg.classList.add('fade');
    setTimeout(() => svg.remove(), TRAIL_FADE_MS);
  };
  /** Each letter key's centre (lower case), as drawn now: the swipe engine matches the path against them. */
  const letterCentres = (): Record<string, [number, number]> => {
    const out: Record<string, [number, number]> = {};
    for (const { el, key } of keys) {
      if (key.type !== 'char' || !swipeLetter(key.char)) continue;
      const r = el.getBoundingClientRect();
      out[key.char.toLowerCase()] = [Math.round((r.left + r.width / 2) * 10) / 10, Math.round((r.top + r.height / 2) * 10) / 10];
    }
    return out;
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
  /**
   * A row of alternates above the held key (below it on the top row), starting on the key itself.
   * Holding 🌐: the keyboards by name, picked by id.
   */
  const openPopup = (entry: Entry, startX: number | null, startY: number | null): void => {
    const menu = entry.key.type === 'action' && entry.key.action === 'next-keyboard' && keyboardMenu && keyboardMenu.ids.length > 1
      ? keyboardMenu : null;
    const texts = menu ? [...menu.names] : alternates(kanaSide(entry.key, !latinKeys()), mods);
    if (texts.length < 2) return;
    const at = entry.el.getBoundingClientRect();
    const width = menu ? Math.min(150, (root.getBoundingClientRect().width - 8) / texts.length || 150) : at.width * POPUP_SCALE;
    const size = { width, height: at.height * POPUP_SCALE };
    const start = startX !== null && startY !== null ? { x: startX, y: startY } : null;
    pickMoved = false;
    popup = { hold: openHoldPopup(doc, shadow, root, at, texts, size, start, true, menu ? 'menu' : '', () => { pickMoved = true; }),
      texts: menu ? [...menu.ids] : texts, key: entry.key };
  };
  const pickAt = (x: number, y: number): void => popup?.hold.pickAt(x, y);
  /** The popup's pick moved since hoverAt last said so: the laser gets a tick, as it does crossing keys. */
  let pickMoved = false;
  const setHover = (target: Entry | undefined): boolean => {
    const entry = target?.key.type === 'gap' ? undefined : target; // a gap is nothing to hover
    if (entry === hovered || (entry && hovered?.pieces?.includes(entry))) return false;
    mark(hovered, 'hover', false);
    hovered = entry;
    mark(hovered, 'hover', true);
    return true;
  };
  // Dragging the candidate list scrolls it (across on top, down on the left); a press that does not
  // move past the slop picks the candidate under it on release.
  let listDrag: { drag: DragScroll; cand: ReturnType<typeof candFor> } | null = null;
  const scrollList = (dx: number, dy: number): void => {
    if (side) list.scrollTop += dy;
    else list.scrollLeft += Math.abs(dx) > Math.abs(dy) ? dx : dy;
  };
  root.addEventListener('wheel', (e) => {
    if (!list.contains(e.target as Node) && e.target !== list) return;
    e.preventDefault();
    scrollList(e.deltaX, e.deltaY);
  }, { passive: false });

  const onStart = (start: TouchPoint | null, e: Event): void => {
    if (list.contains(e.target as Node) || e.target === list) {
      listDrag = { drag: dragScroll(list, start ?? { x: 0, y: 0 }, side ? 'y' : 'x', SLOP_PX.list), cand: candFor(e.target) };
      return;
    }
    pressed = entryFor(e.target);
    mark(pressed, 'down', true);
    clearHold();
    const held = pressed;
    lastPoint = start;
    repeated = false;
    endSwipe(false);
    // A letter may start a swipe; not while Ctrl, Alt, Super or Fn makes it a shortcut.
    if (onSwipe && start && held?.key.type === 'char' && swipeLetter(held.key.char) && (canSwipe?.() ?? true)
      && mods.ctrl === 'off' && mods.alt === 'off' && mods.super === 'off' && mods.fn === 'off') {
      swipe = { start, points: [start], rect: held.el.getBoundingClientRect(), on: false, at: Date.now() };
    }
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
      if (popup) swipe = null; // held for the alternates: moving now picks one (a key without may still swipe)
    }, HOLD_MS);
  };
  const onMove = (touch: TouchPoint | null): void => {
    if (!touch) return;
    lastPoint = touch;
    if (listDrag) {
      listDrag.drag.move(touch);
      return;
    }
    if (flick) moveFlick(lastPoint);
    else if (swipe) moveSwipe(touch);
    else pickAt(touch.x, touch.y);
  };
  const moveSwipe = (touch: TouchPoint): void => {
    if (!swipe) return;
    swipe.at = Date.now();
    if (swipe.points.length >= SWIPE_MAX_POINTS) {
      if (swipe.on) {
        endSwipe(false); // stuck, not a word: it types nothing
        pressed = undefined;
        return;
      }
      swipe.points.splice(1, 1); // a press resting on its key: only where it started matters
    }
    swipe.points.push(touch);
    if (swipe.on) drawTrail(touch);
    else if (leftKey(swipe.start, touch, swipe.rect, swipe.rect.width)) {
      // Leaving the key makes it a swipe: no tap, no alternates, no repeat.
      swipe.on = true;
      clearHold();
      mark(pressed, 'down', false);
      openTrail();
    }
  };
  const onEnd = (end: TouchPoint | null, e: Event): void => {
    clearHold();
    const hit = pressed;
    pressed = undefined;
    mark(hit, 'down', false);
    if (swipe?.on) {
      if (end) swipe.points.push(end);
      const { points, rect } = swipe;
      endSwipe(true);
      onSwipe?.(resample(points), letterCentres(), rect.width);
      return;
    }
    swipe = null;
    if (listDrag) {
      const { drag, cand } = listDrag;
      listDrag = null;
      if (!drag.moved && cand) onCandidate(cand.text, cand.index);
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
  };
  const onCancel = (): void => {
    clearHold();
    endSwipe(false);
    closePopup();
    closeFlick();
    listDrag = null;
    mark(pressed, 'down', false);
    pressed = undefined;
  };
  root.addEventListener('mouseover', (e) => { setHover(entryFor(e.target)); setSlotHover(slotFor(e.target)); });
  root.addEventListener('mouseleave', () => setHover(undefined));
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  const onClick = (e: MouseEvent): void => {
    e.stopPropagation();
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
  };
  listenTouch(root, { start: onStart, move: onMove, end: onEnd, cancel: onCancel, click: onClick }, { guard });

  /** A legend's size and colour classes (its size role; text tone inherits the key's colour in the label). */
  const sizeClass = (legend: Legend): string => (legend.kind === 'text' && legend.size !== 'key' ? ` s-${legend.size}` : '');
  const toneClass = (legend: Legend): string => (legend.kind === 'text' && legend.tone !== 'text' ? ` t-${legend.tone}` : '');
  /** Text into an element: in a dotted box (a child; the element itself positions and sizes it) when listed. */
  const putText = (el: HTMLElement, legend: Extract<Legend, { kind: 'text' }>): void => {
    if (legend.boxed) el.replaceChildren(boxed(legend.text));
    else el.textContent = legend.text;
  };
  /** The label (slot c): text, an icon, the あ a pair, or ゛゜ over 大⇔小; a line beneath it in the flow. */
  const showLabel = (entry: Entry, legend: Legend | undefined): void => {
    const { el, label } = entry;
    label.className = `lbl${legend ? sizeClass(legend) + toneClass(legend) : ''}`;
    if (!legend) label.textContent = '';
    else if (legend.kind === 'text') putText(label, legend);
    else if (legend.kind === 'icon') label.innerHTML = ICONS[legend.icon as IconName] ?? '';
    else if (legend.kind === 'pair') {
      label.replaceChildren(...legend.parts.map((text, i) => Object.assign(doc.createElement('span'), {
        className: i === legend.now ? 'pair now' : 'pair', textContent: text })));
    } else if (!label.querySelector('.mk')) {
      const span = (className: string, textContent: string): HTMLElement => Object.assign(doc.createElement('span'), { className, textContent });
      const marks = span('mk-marks', '');
      for (const mark of legend.marks) marks.append(mark.kind === 'text' && mark.boxed ? boxed(mark.text) : span('', mark.kind === 'text' ? mark.text : ''));
      const box = span('mk', '');
      box.append(marks, span('mk-size', legend.under.kind === 'text' ? legend.under.text : ''));
      label.replaceChildren(box);
    }
    // The ABC keys: the label with its digit small beneath.
    const under = legend?.kind === 'text' ? legend.under : undefined;
    el.classList.toggle('subbed', under !== undefined);
    if (under?.kind === 'text') {
      entry.under ??= el.appendChild(Object.assign(doc.createElement('span'), { className: 'sub' }));
      entry.under.textContent = under.text;
    } else {
      entry.under?.remove();
      delete entry.under;
    }
  };
  /** Draw a key's legends: the label, and each small legend in its slot. */
  const showLegends = (entry: Entry, model: KeyLegends): void => {
    const { el } = entry;
    for (const arrangement of ['tri', 'stack', 'quad', 'edges'] as const) el.classList.toggle(arrangement, model.arrangement === arrangement);
    showLabel(entry, model.slots.c);
    for (const slot of SLOTS) {
      const legend = model.slots[slot];
      if (!legend || legend.kind !== 'text') {
        entry.slots[slot]?.remove();
        delete entry.slots[slot];
        continue;
      }
      const span = entry.slots[slot] ?? el.appendChild(doc.createElement('span'));
      entry.slots[slot] = span;
      span.className = `lg ${slot}${sizeClass(legend)}${toneClass(legend)}`;
      putText(span, legend);
    }
  };

  shadow.append(style, root);

  return {
    update: (next) => {
      mods = next;
      for (const entry of keys) {
        const { el, key } = entry;
        if (key.type === 'action' && (key.action === 'eisu' || key.action === 'kana')) {
          el.classList.toggle('on', (key.action === 'eisu') === latin); // the current mode's key
        }
        if (key.type === 'mod') {
          const state = modState(mods, key.mod);
          el.classList.toggle('on', state.on);
          el.classList.toggle('locked', state.locked);
        }
        const label = labels[el.dataset['k'] ?? ''];
        const icon = label === undefined ? iconFor(key, mods, iconSet, layout.arrowStyle ?? 'icon') : undefined;
        showLegends(entry, keyLegends(key, mods, { latin, romaji, symbols, letters, hints, dotted, icon, label }));
      }
    },
    setMode: (next) => {
      latin = next;
    },
    setComposition: (c) => {
      const showing = c !== null || side || placeholder !== '';
      comp.classList.toggle('on', showing);
      if (!side) cands.style.display = showing ? 'none' : '';
      pre.textContent = '';
      list.textContent = '';
      candidates = [];
      hoveredCand = undefined;
      if (!c) {
        if (placeholder) list.append(Object.assign(doc.createElement('div'), { className: 'placeholder', textContent: placeholder }));
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
    setMic: (state) => { for (const m of mics()) m.setState(state); },
    setMicLevels: (levels) => { for (const m of mics()) m.setLevels(levels); },
    setMicProgress: (fraction) => { for (const m of mics()) m.setProgress(fraction); },
    setMicBusy: (busy) => { for (const m of mics()) m.setBusy(busy); },
    setSuggestions: (words) => {
      slots.forEach((slot, i) => {
        slot.word = words[i];
        slot.el.textContent = words[i] ?? '';
      });
      if (hoveredSlot && !hoveredSlot.word) setSlotHover(undefined);
    },
    hoverAt: (x, y) => {
      if (flick) return false; // a flick follows the touch alone
      // The laser moving on with no touch moves: the release was lost. A swipe then types nothing.
      const last = swipe?.points[swipe.points.length - 1];
      if (swipe?.on && last && Date.now() - swipe.at > RELEASE_LOST_MS && Math.hypot(x - last.x, y - last.y) > SLOP_PX.scroll) {
        endSwipe(false);
        pressed = undefined;
      }
      if (popup) {
        pickAt(x, y);
        const moved = pickMoved;
        pickMoved = false;
        return moved;
      }
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      const candChanged = setCandHover(hits.map(candFor).find(Boolean)?.el);
      const slotChanged = setSlotHover(hits.map(slotFor).find(Boolean)) || candChanged;
      return setHover(hits.map(entryFor).find(Boolean)) || slotChanged;
    },
    setBounds: ({ top, left, width, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    },
    destroy: () => { clearHold(); closePopup(); closeFlick(); endSwipe(false); style.remove(); root.remove(); },
  };
};
