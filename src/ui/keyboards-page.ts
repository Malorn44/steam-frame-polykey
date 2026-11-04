// Settings → Keyboards: languages on the left, that language's layouts in the middle, and on the right
// your keyboards in 🌐's order. Tap a layout to add it at the end, or drag it into the list where it
// should go; drag your keyboards to reorder them, and out of the list (or ✕) to remove them. The last
// one stays. A gap opens where a dragged keyboard will land.

import { SLOP_PX } from '../core/interaction.js';

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
.kbs .list { flex: 1; display: flex; flex-direction: column; gap: 3px; min-height: 0; overflow: hidden; }
.item { display: flex; align-items: center; gap: 6px; height: 29px; flex: none; padding: 0 8px; box-sizing: border-box;
  background: var(--mod); border-radius: var(--radius); font-size: 14px; white-space: nowrap; overflow: hidden; }
.item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.item .mark { flex: none; color: var(--legend); font-size: 13px; }
.item.sel { box-shadow: inset 0 0 0 2px var(--ring); }
.item.added .mark { color: var(--accent); }
.item .grip { flex: none; color: var(--legend); }
.item .x { flex: none; width: 24px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius); color: var(--legend); }
.item .x.hover { background: var(--accent); color: var(--accent-text); }
.item.hover { box-shadow: inset 0 0 0 2px var(--ring); }
.item.dragging { display: none; }
.kbs .ph { height: 29px; flex: none; border-radius: var(--radius); background: var(--hover);
  box-shadow: inset 0 0 0 2px var(--ring); opacity: 0.6; }
.ghost { position: fixed; z-index: 3; pointer-events: none; opacity: 0.9; box-shadow: var(--shadow); }
.ghost.out { opacity: 0.45; }
.hintline { color: var(--legend); font-size: 12px; border-top: 1px solid var(--divider); padding-top: 3px; }
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
): HTMLElement => {
  const el = (cls: string, text = ''): HTMLElement => Object.assign(doc.createElement('div'), { className: cls, textContent: text });
  // A layout's pack name is the layout alone (12キー); your list shows its language too.
  const nameOf = new Map(info.all.map((k) => [k.id, fullName(k)]));
  const root = el('kbs');

  const column = (cls: string, heading: string): { col: HTMLElement; list: HTMLElement } => {
    const col = el(`col ${cls}`);
    const list = el('list');
    col.append(el('sect', heading), list);
    root.append(col);
    return { col, list };
  };

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
  const mine = column('mine', 'Your keyboards (🌐 order)');
  const ringItems = info.ring.map((id) => {
    const item = el('item');
    const x = el('x', '✕');
    item.append(el('grip', '≡'), el('nm', nameOf.get(id) ?? id), x);
    if (info.ring.length > 1) actions.set(x, () => onKeyboards(info.ring.filter((k) => k !== id)));
    else x.style.visibility = 'hidden'; // the last one stays
    draggable.set(item, { id, from: 'ring', source: item });
    mine.list.append(item);
    return item;
  });

  // Dragging: a ghost follows the touch; over your list a gap shows where it will land.
  let start: { x: number; y: number; drag: Drag } | null = null;
  let ghost: HTMLElement | null = null;
  const ph = el('ph');
  const point = (e: Event) => (e as TouchEvent).changedTouches?.[0];
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

  root.addEventListener('touchstart', (e) => {
    const target = e.target as Node;
    const item = [...draggable.keys()].find((i) => i.contains(target));
    if (!item || [...actions.keys()].some((a) => a.classList.contains('x') && a.contains(target))) return;
    e.preventDefault();
    e.stopPropagation();
    const t = point(e);
    start = { x: t?.clientX ?? 0, y: t?.clientY ?? 0, drag: draggable.get(item)! };
  }, { passive: false });
  root.addEventListener('touchmove', (e) => {
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    const t = point(e);
    if (!t) return;
    if (!ghost) {
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP_PX.reorder) return;
      const r = start.drag.source.getBoundingClientRect();
      ghost = start.drag.source.cloneNode(true) as HTMLElement;
      ghost.classList.add('ghost');
      Object.assign(ghost.style, { width: `${r.width}px` });
      root.append(ghost);
      if (start.drag.from === 'ring') start.drag.source.classList.add('dragging');
    }
    Object.assign(ghost.style, { left: `${t.clientX - 20}px`, top: `${t.clientY - 14}px` });
    const inside = overList(t.clientX, t.clientY);
    ghost.classList.toggle('out', !inside && start.drag.from === 'ring');
    if (inside) {
      const shown = others(start.drag.id);
      const at = indexAt(t.clientY, start.drag.id);
      if (shown[at]) mine.list.insertBefore(ph, shown[at]!);
      else mine.list.append(ph);
    } else ph.remove();
  }, { passive: false });
  root.addEventListener('touchend', (e) => {
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    const t = point(e);
    const { drag } = start;
    const dragged = ghost !== null;
    end();
    if (!dragged) {
      actions.get(drag.source)?.(); // a tap
      return;
    }
    if (t && overList(t.clientX, t.clientY)) onKeyboards(dropInto(info.ring, drag.id, indexAt(t.clientY, drag.id)));
    else if (drag.from === 'ring' && info.ring.length > 1) onKeyboards(info.ring.filter((k) => k !== drag.id));
  }, { passive: false });
  root.addEventListener('touchcancel', end);
  return root;
};
