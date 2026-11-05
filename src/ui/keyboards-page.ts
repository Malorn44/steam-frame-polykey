// Settings → Keyboards: languages on the left, that language's layouts in the middle, and on the right
// your keyboards in 🌐's order. Tap a layout to add it at the end, or drag it into the list where it
// should go; drag your keyboards to reorder them, and out of the list (or ✕) to remove them. The last
// one stays. A gap opens where a dragged keyboard will land.

import { SLOP_PX, type TouchGuard } from '../core/interaction.js';
import { dragScroll, listenTouch, type DragScroll, type TouchPoint } from './gesture.js';
import { ICONS, type IconName } from './icons.js';

/** How near your list's top or bottom edge a dragged keyboard scrolls it, and how far each move. */
const EDGE_PX = 20;
const EDGE_STEP_PX = 6;

/** An icon inside a line of text, at the text's size (the icons draw at 1em). */
export const inlineIcon = (doc: Document, name: IconName): HTMLElement =>
  Object.assign(doc.createElement('span'), { className: 'ic', innerHTML: ICONS[name] });

export interface KeyboardsInfo {
  /** Every keyboard there is: id, name, language code. */
  all: { id: string; name: string; language: string }[];
  /** Yours, in 🌐's order. */
  ring: string[];
  /** The language whose layouts are shown. */
  language: string;
}

export interface KeyboardsHandlers {
  onLanguage(code: string): void;
  onKeyboards(ids: string[]): void;
}

export const KEYBOARDS_CSS = `
.kbs { flex: 1; display: flex; gap: 10px; min-height: 0; }
.kbs .col.langs { flex: 0 0 22%; }
.kbs .col.lays { flex: 0 0 34%; }
.kbs .list { flex: 1; display: flex; flex-direction: column; gap: 3px; min-height: 0; }
.item { display: flex; align-items: center; gap: 6px; height: var(--row-height); flex: none; padding: 0 8px; box-sizing: border-box;
  background: var(--mod); border-radius: var(--radius); font-size: var(--ui-control); white-space: nowrap; overflow: hidden; }
.item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.item .mark { flex: none; color: var(--legend); font-size: var(--ui-small); }
.item.sel { box-shadow: inset 0 0 0 2px var(--ring); }
.item.added .mark { color: var(--accent); }
.item .grip { flex: none; display: flex; color: var(--legend); }
.ic { display: inline-flex; vertical-align: -0.15em; }
.item .x { flex: none; width: 24px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius); color: var(--legend); }
.item .x.hover { background: var(--accent); color: var(--accent-text); }
.item.hover { box-shadow: inset 0 0 0 2px var(--ring); }
.item.dragging { display: none; }
.kbs .ph { height: var(--row-height); flex: none; border-radius: var(--radius); background: var(--hover);
  box-shadow: inset 0 0 0 2px var(--ring); opacity: 0.6; }
.ghost { position: fixed; z-index: 3; pointer-events: none; opacity: 0.9; box-shadow: var(--shadow); }
.ghost.out { opacity: 0.45; }
.hintline { color: var(--legend); font-size: var(--ui-caption); border-top: 1px solid var(--divider); padding-top: 3px; }
`;

/** A language's own name for itself (日本語, English), or its code. */
export const languageName = (code: string): string => {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name[0]!.toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
};

/** A column of a settings page, appended to `root`: its heading, then its list, which scrolls (.scroll in settings). */
export const pageColumn = (root: HTMLElement, cls: string, heading: string | (string | Node)[]): { col: HTMLElement; list: HTMLElement } => {
  const div = (className: string): HTMLElement => Object.assign(root.ownerDocument.createElement('div'), { className });
  const col = div(`col ${cls}`);
  const list = div('list scroll');
  const sect = div('sect');
  sect.append(...(typeof heading === 'string' ? [heading] : heading));
  col.append(sect, list);
  root.append(col);
  return { col, list };
};

/** A keyboard where languages are mixed (your list, settings): its language and layout. */
export const fullName = (k: { name: string; language?: string | undefined }): string =>
  (k.language ? `${languageName(k.language)} · ${k.name}` : k.name);

/** Your list after dropping `id` at `index` among the others (moved if it was there already). */
export const dropInto = (ring: readonly string[], id: string, index: number): string[] => {
  const rest = ring.filter((k) => k !== id);
  const at = Math.min(Math.max(0, index), rest.length);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
};

/**
 * Build the page. Taps go through `actions` (the settings page's tap and laser-hover handling);
 * drags are handled here, so a touch that starts on a draggable item does not reach the page.
 */
export const buildKeyboardsPage = (
  doc: Document,
  info: KeyboardsInfo,
  { onLanguage, onKeyboards }: KeyboardsHandlers,
  actions: Map<HTMLElement, () => void>,
  /** Settings' touch guard: a claimed drag marks it too, so its copied click is dropped. */
  guard?: TouchGuard,
): HTMLElement => {
  const el = (cls: string, text = ''): HTMLElement => Object.assign(doc.createElement('div'), { className: cls, textContent: text });
  const icon = (cls: string, name: IconName): HTMLElement => Object.assign(el(cls), { innerHTML: ICONS[name] });
  // A layout's pack name is the layout alone (12キー); your list shows its language too.
  const nameOf = new Map(info.all.map((k) => [k.id, fullName(k)]));
  const root = el('kbs');
  const column = (cls: string, heading: string | (string | Node)[]) => pageColumn(root, cls, heading);

  // Languages, with how many of yours each has.
  const languages = [...new Set(info.all.map((k) => k.language))].sort((a, b) => languageName(a).localeCompare(languageName(b)));
  const langs = column('langs', 'Languages');
  for (const code of languages) {
    const item = el(code === info.language ? 'item sel' : 'item');
    const count = info.ring.filter((id) => info.all.find((k) => k.id === id)?.language === code).length;
    item.append(el('nm', languageName(code)), el('mark', count ? String(count) : ''));
    actions.set(item, () => onLanguage(code));
    langs.list.append(item);
  }

  // The chosen language's layouts: ✓ if yours, + to add.
  type Drag = { id: string; from: 'layout' | 'ring'; source: HTMLElement };
  const draggable = new Map<HTMLElement, Drag>();
  const lays = column('lays', `${languageName(info.language)} layouts`);
  for (const k of info.all.filter((x) => x.language === info.language)) {
    const added = info.ring.includes(k.id);
    const item = el(added ? 'item added' : 'item');
    item.append(el('nm', k.name), el('mark', added ? '✓' : '+'));
    actions.set(item, () => { if (!added) onKeyboards([...info.ring, k.id]); });
    draggable.set(item, { id: k.id, from: 'layout', source: item });
    lays.list.append(item);
  }

  // Yours, in 🌐's order.
  const mine = column('mine', ['Your keyboards (', inlineIcon(doc, 'globe'), ' order)']);
  const ringItems = info.ring.map((id) => {
    const item = el('item');
    const x = icon('x', 'close');
    item.append(icon('grip', 'menu'), el('nm', nameOf.get(id) ?? id), x);
    if (info.ring.length > 1) actions.set(x, () => onKeyboards(info.ring.filter((k) => k !== id)));
    else x.style.visibility = 'hidden'; // the last one stays
    draggable.set(item, { id, from: 'ring', source: item });
    mine.list.append(item);
    return item;
  });

  // Dragging: a ghost follows the touch; over your list a gap shows where it will land.
  /** A press on a row; `scroll` once it turned out to drag the layouts' list instead. */
  let start: { x: number; y: number; drag: Drag; scroll?: DragScroll } | null = null;
  let ghost: HTMLElement | null = null;
  const ph = el('ph');
  const overList = (x: number, y: number): boolean => {
    const r = mine.col.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  /** The others (not the one being dragged) and where a drop at y lands among them. */
  const others = (id: string): HTMLElement[] => ringItems.filter((_, i) => info.ring[i] !== id);
  const indexAt = (y: number, id: string): number => {
    const at = others(id).findIndex((i) => { const r = i.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return at < 0 ? others(id).length : at;
  };
  const end = (): void => {
    ghost?.remove();
    ghost = null;
    ph.remove();
    for (const i of ringItems) i.classList.remove('dragging');
    start = null;
  };

  // Only a press on a row (not its ✕) is ours: the rest goes on to settings, which handles taps.
  listenTouch(root, {
    start: (t, e) => {
      const target = e.target as Node;
      const item = [...draggable.keys()].find((i) => i.contains(target));
      if (!item || [...actions.keys()].some((a) => a.classList.contains('x') && a.contains(target))) return false;
      start = { x: t?.x ?? 0, y: t?.y ?? 0, drag: draggable.get(item)! };
      return true;
    },
    move: (t) => {
      if (!start) return false;
      if (t) moveTo(t);
      return true;
    },
    end: (t) => {
      if (!start) return false;
      release(t);
      return true;
    },
    cancel: end,
  }, guard ? { guard } : {});
  const moveTo = (t: TouchPoint): void => {
    if (!start) return;
    if (start.scroll) {
      start.scroll.move(t);
      return;
    }
    if (!ghost) {
      const [dx, dy] = [t.x - start.x, t.y - start.y];
      if (Math.hypot(dx, dy) < SLOP_PX.list) return;
      // A layout only ever goes right, into your list: up or down, a list too long to show scrolls instead.
      if (start.drag.from === 'layout' && Math.abs(dy) > Math.abs(dx) && lays.list.scrollHeight > lays.list.clientHeight) {
        start.scroll = dragScroll(lays.list, start, 'y', 0);
        start.scroll.move(t);
        return;
      }
      const r = start.drag.source.getBoundingClientRect();
      ghost = start.drag.source.cloneNode(true) as HTMLElement;
      ghost.classList.add('ghost');
      Object.assign(ghost.style, { width: `${r.width}px` });
      root.append(ghost);
      if (start.drag.from === 'ring') start.drag.source.classList.add('dragging');
    }
    Object.assign(ghost.style, { left: `${t.x - 20}px`, top: `${t.y - 14}px` });
    const inside = overList(t.x, t.y);
    ghost.classList.toggle('out', !inside && start.drag.from === 'ring');
    if (inside) {
      // Held near your list's top or bottom edge, it scrolls to show more of itself.
      const r = mine.list.getBoundingClientRect();
      mine.list.scrollTop += t.y < r.top + EDGE_PX ? -EDGE_STEP_PX : t.y > r.bottom - EDGE_PX ? EDGE_STEP_PX : 0;
      const shown = others(start.drag.id);
      const at = indexAt(t.y, start.drag.id);
      if (shown[at]) mine.list.insertBefore(ph, shown[at]!);
      else mine.list.append(ph);
    } else ph.remove();
  };
  const release = (t: TouchPoint | null): void => {
    if (!start) return;
    const { drag, scroll } = start;
    const dragged = ghost !== null;
    if (scroll) {
      end(); // a scroll is never a tap
      return;
    }
    end();
    if (!dragged) {
      actions.get(drag.source)?.(); // a tap
      return;
    }
    if (t && overList(t.x, t.y)) onKeyboards(dropInto(info.ring, drag.id, indexAt(t.y, drag.id)));
    else if (drag.from === 'ring' && info.ring.length > 1) onKeyboards(info.ring.filter((k) => k !== drag.id));
  };
  return root;
};
