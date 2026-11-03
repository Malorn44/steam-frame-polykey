// The keyboard as DOM inside our shadow root: built once per layout; update() changes labels, small
// Shift/Fn legends and modifier highlights. Gaps are transparent borders, so key positions follow
// the width weights exactly and columns line up across rows. The VR laser arrives as touch events
// (mouse clicks are the desktop fallback); hover comes from hoverAt() (laser) or mouseover.

import { normalizeFn, normalizeKey, type KeyDef, type Layout, type Theme } from '../core/catalog.js';
import { NO_MODS, alternates, charText, keyLabel, modState, type Mods } from '../core/keyboard.js';
import { ICONS, type IconName } from './icons.js';

export const TOOLBAR_PX = 26;
const TOUCH_MOUSE_GUARD_MS = 600;
/** Hold this long for a key's alternates. */
export const LONG_PRESS_MS = 400;
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
.row { flex: 1; display: flex; min-height: 0; }
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
.alts { position: absolute; display: flex; z-index: 1; background: var(--surface); border-radius: var(--radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6); }
.key[data-k="fn"] { color: var(--fn); }
.key[data-k="fn"].on { box-shadow: inset 0 0 0 2px var(--fn); }
.key[data-k="fn"].locked { background-color: var(--fn); color: var(--surface); }
/* Alternates wear the held-key look, so they stand apart from the keyboard; the pick gets the accent. */
.alts .key { flex: none; background-color: var(--key); filter: brightness(1.5); }
.alts .key.pick { background-color: var(--accent); color: var(--surface); filter: none; }
.key.hover { background-color: var(--hover); }
.key.on { box-shadow: inset 0 0 0 2px var(--accent); }
.key.locked { background-color: var(--accent); color: var(--surface); }
.key.down { filter: brightness(1.5); }
`;

const ACTION_ICONS: Partial<Record<string, IconName>> = {
  settings: 'settings', emoji: 'emoji', dictate: 'dictate', copy: 'copy', cut: 'cut', paste: 'paste', menu: 'menu',
  hide: 'hide', 'next-keyboard': 'globe',
};

/** The icon a key shows, if any (Shift and Caps change icon when locked). */
const iconFor = (key: KeyDef, mods: Mods): IconName | undefined => {
  if ('label' in key && key.label) return undefined;
  if (key.type === 'action') return ACTION_ICONS[key.action];
  if (key.type === 'key' && key.key === 'Backspace') return 'backspace';
  if (key.type !== 'mod') return undefined;
  if (key.mod === 'super') return 'frame';
  if (key.mod === 'shift') return mods.shift === 'locked' ? 'shiftLocked' : 'shift';
  if (key.mod === 'caps') return mods.caps ? 'capsOn' : 'caps';
  return undefined;
};

/** Small legends: the Shift character (not for letters) and the Fn variant. */
const legends = (key: KeyDef, mods: Mods): { sh: string; fn: string } => {
  if (key.type !== 'char' && key.type !== 'key') return { sh: '', fn: '' };
  const fnOn = mods.fn !== 'off' && key.fn;
  const fn = key.fn && !fnOn ? keyLabel(normalizeFn(key.fn), mods) : '';
  if (key.type !== 'char' || fnOn || !key.shift) return { sh: '', fn };
  const shown = charText(key, mods);
  return { sh: shown === key.shift ? key.char : key.shift, fn };
};

export interface View {
  update(mods: Mods): void;
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
  /** A tap, or a long press that chose `alternate` (its text). */
  onKey: (key: KeyDef, alternate?: string) => void,
  onSuggestion: (word: string) => void = () => {},
): View => {
  const style = doc.createElement('style');
  style.textContent = CSS;
  const root = doc.createElement('div');
  root.className = 'kb';
  const c = theme.colors;
  root.style.cssText = `--surface:${c.surface};--key:${c.key};--text:${c.keyText};--mod:${c.modifier};`
    + `--accent:${c.accent};--legend:${c.legend ?? c.keyText};--fn:${c.fnLegend ?? c.accent};`
    + `--hover:${c.hover ?? c.modifier};--radius:${theme.radius ?? 6}px;--font:${theme.font ?? 'system-ui, sans-serif'};`;

  type Entry = { el: HTMLElement; key: KeyDef; label: HTMLElement; sh: HTMLElement; fn: HTMLElement };
  const keys: Entry[] = [];
  const widthOf = (key: KeyDef): number => ('w' in key && key.w !== undefined ? key.w : 1);
  const makeKey = (key: KeyDef, rowUnits?: number): HTMLElement => {
    const el = doc.createElement('div');
    el.className = `key ${key.type === 'char' ? 'char' : key.type === 'key' ? 'named' : key.type}`;
    // An exact share of the row, so keys line up across rows whatever their count.
    if (rowUnits) el.style.flex = `0 0 ${(widthOf(key) / rowUnits) * 100}%`;
    el.dataset['k'] = key.type === 'char' ? key.char : key.type === 'key' ? key.key
      : key.type === 'mod' ? key.mod : key.type === 'action' ? key.action : '';
    const label = doc.createElement('span');
    label.className = 'lbl';
    const sh = doc.createElement('span');
    sh.className = 'sh';
    const fn = doc.createElement('span');
    fn.className = 'fn';
    el.append(sh, label, fn);
    keys.push({ el, key, label, sh, fn });
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
  for (const key of toolbar.filter((k) => k.action === 'hide')) bar.append(makeKey(key)); // close sits at the right end
  if (toolbar.length) root.append(bar);
  for (const row of layout.rows) {
    const rowEl = doc.createElement('div');
    rowEl.className = 'row';
    const defs = row.map(normalizeKey);
    const units = defs.reduce((sum, key) => sum + widthOf(key), 0);
    for (const key of defs) rowEl.append(makeKey(key, units));
    root.append(rowEl);
  }

  const entryFor = (target: EventTarget | null): Entry | undefined =>
    keys.find(({ el }) => el === target || el.contains(target as Node));
  const slotFor = (target: EventTarget | null) => slots.find(({ el, word }) => word && (el === target || el.contains(target as Node)));
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
  let lastPoint: { x: number; y: number } | null = null;
  let popup: { el: HTMLElement; cells: { el: HTMLElement; text: string }[]; pick: number; key: KeyDef; keyRect: DOMRect } | null = null;

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const closePopup = (): void => {
    popup?.el.remove();
    popup = null;
  };
  const setPick = (index: number): void => {
    if (!popup || index === popup.pick) return;
    popup.cells[popup.pick]?.el.classList.remove('pick');
    popup.pick = index;
    popup.cells[index]?.el.classList.add('pick');
  };
  /** A row of alternates above the held key (below it on the top row), starting on the key itself. */
  const openPopup = (entry: Entry, startX: number | null, startY: number | null): void => {
    const texts = alternates(entry.key, mods);
    if (texts.length < 2) return;
    const box = root.getBoundingClientRect();
    const at = entry.el.getBoundingClientRect();
    const el = doc.createElement('div');
    el.className = 'alts';
    const cells = texts.map((text) => {
      const cell = doc.createElement('div');
      cell.className = 'key';
      Object.assign(cell.style, { width: `${at.width * POPUP_SCALE}px`, height: `${at.height * POPUP_SCALE}px` });
      cell.textContent = text;
      el.append(cell);
      return { el: cell, text };
    });
    const cellWidth = at.width * POPUP_SCALE;
    const left = Math.min(Math.max(0, at.left - box.left), Math.max(0, box.width - cellWidth * texts.length));
    const above = at.top - box.top - at.height * POPUP_SCALE - 2;
    Object.assign(el.style, { left: `${left}px`, top: `${above >= 0 ? above : at.bottom - box.top + 2}px` });
    root.append(el);
    popup = { el, cells, pick: -1, key: entry.key, keyRect: at };
    // Start on the cell above the laser, so the pick never flashes on the first cell first.
    setPick(0);
    if (startY !== null && startX !== null) pickAt(startX, startY);
  };
  /**
   * The cell above the laser's horizontal position, like a phone: the laser usually still sits on the
   * held key, below the popup. Moving well above the popup or below the key picks nothing (release
   * cancels).
   */
  const pickAt = (x: number, y: number): void => {
    if (!popup) return;
    const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
    const direct = popup.cells.findIndex(({ el }) => hits.includes(el));
    if (direct >= 0) {
      setPick(direct);
      return;
    }
    const rects = popup.cells.map(({ el }) => el.getBoundingClientRect());
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last || first.width === 0) return; // not laid out: keep the current pick
    const top = Math.min(first.top, popup.keyRect.top);
    const bottom = Math.max(first.bottom, popup.keyRect.bottom);
    if (y < top - first.height || y > bottom + first.height) {
      setPick(-1);
      return;
    }
    const index = rects.findIndex((r) => x < r.right);
    setPick(index < 0 ? rects.length - 1 : index);
  };
  const setHover = (entry: Entry | undefined): boolean => {
    if (entry === hovered) return false;
    hovered?.el.classList.remove('hover');
    hovered = entry && entry.key.type !== 'gap' ? entry : undefined;
    hovered?.el.classList.add('hover');
    return true;
  };
  root.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pressed = entryFor(e.target);
    pressed?.el.classList.add('down');
    clearHold();
    const held = pressed;
    const start = (e as TouchEvent).changedTouches?.[0];
    lastPoint = start ? { x: start.clientX, y: start.clientY } : null;
    if (held) holdTimer = setTimeout(() => {
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
    pickAt(touch.clientX, touch.clientY);
  }, { passive: false });
  root.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    lastTouchAt = Date.now();
    clearHold();
    const hit = pressed;
    pressed = undefined;
    hit?.el.classList.remove('down');
    const slot = slotFor(e.target);
    if (slot?.word) {
      onSuggestion(slot.word);
      return;
    }
    if (popup) {
      const chosen = popup.cells[popup.pick]?.text;
      const key = popup.key;
      closePopup();
      if (chosen !== undefined) onKey(key, chosen);
      return;
    }
    if (hit && hit.key.type !== 'gap') onKey(hit.key);
  }, { passive: false });
  root.addEventListener('touchcancel', () => {
    clearHold();
    closePopup();
    pressed?.el.classList.remove('down');
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
    const hit = entryFor(e.target);
    if (hit && hit.key.type !== 'gap') onKey(hit.key);
  });

  shadow.append(style, root);

  return {
    update: (next) => {
      mods = next;
      for (const { el, key, label, sh, fn } of keys) {
        if (key.type === 'mod') {
          const state = modState(mods, key.mod);
          el.classList.toggle('on', state.on);
          el.classList.toggle('locked', state.locked);
        }
        const icon = iconFor(key, mods);
        if (icon) label.innerHTML = ICONS[icon];
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
    setSuggestions: (words) => {
      slots.forEach((slot, i) => {
        slot.word = words[i];
        slot.el.textContent = words[i] ?? '';
      });
      if (hoveredSlot && !hoveredSlot.word) setSlotHover(undefined);
    },
    hoverAt: (x, y) => {
      if (popup) {
        pickAt(x, y);
        return false;
      }
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      const slotChanged = setSlotHover(hits.map(slotFor).find(Boolean));
      return setHover(hits.map(entryFor).find(Boolean)) || slotChanged;
    },
    setBounds: ({ top, left, width, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    },
    destroy: () => { clearHold(); closePopup(); style.remove(); root.remove(); },
  };
};
