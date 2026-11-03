// The emoji picker, drawn in the keyboard area above a row of keys: category tabs, then one
// horizontally scrolling grid (filled down each column) with Recent (and its bin), Favorites, the
// Unicode groups and the user's Steam items, separated. Recent and Favorites hold emoji and Steam items.
// Drag or the thumbstick (wheel events) scrolls; a quick drag glides. Holding a toned emoji offers its
// skin tones (the shared hold popup); holding an entry in Recent or Favorites lifts it for drag and drop
// into Favorites, where a placeholder opens (drop elsewhere removes a favorite). A gesture is followed
// across the whole shadow root, and ended if its release is lost. Like Full Keyboard: no haptics here.

import type { Theme } from '../core/catalog.js';
import { HOLD_POPUP_CSS, openHoldPopup, type HoldPopup } from './hold-popup.js';
import { ICONS } from './icons.js';
import { themeVars } from './theme.js';
import { MAX_FAVORITES, TONES, steamFromKey, steamKey, removeFavorite, placeFavorite, withTone, baseOf, type EmojiData, type EmojiState, type SteamItem, type Tone } from '../core/emoji.js';

export const RECENT_COLUMNS = 6;
/** Recent's block is 6 × 4; its last place holds the bin. */
export const RECENT_MAX = RECENT_COLUMNS * 4 - 1;
export const TABS_PX = 26;
/** A press that moves further than this scrolls instead (more while a hold may follow). */
export const SCROLL_SLOP_PX = 24;
export const HOLD_MS = 500;
/** While a hold may follow (toned, Recent, Favorites), the laser may wander this far (Full Keyboard). */
export const HOLD_SLOP_PX = 32;
const GLIDE_TAU_S = 0.35;
/** The laser moving this long without a touch move means the trigger was released unseen. */
export const RELEASE_LOST_MS = 600;
const GLIDE_MIN_SPEED = 300;

const CSS = `
.emoji { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; padding: 2px;
  background: var(--surface); color: var(--text); font: 400 14px/1 var(--font); overflow: hidden;
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.tabs { height: ${TABS_PX}px; display: flex; flex: none; gap: 2px; overflow: hidden; }
.tab { flex: none; min-width: 30px; height: 100%; display: flex; align-items: center; justify-content: center;
  padding: 0 6px; box-sizing: border-box; border-radius: var(--radius); font-size: 18px; color: var(--legend); }
.tab.on { background: var(--mod); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.trash { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: var(--radius); font-size: 20px; color: var(--legend); }
.trash.hover { background: var(--hover); color: var(--text); }
.grid { position: relative; flex: 1; overflow: hidden; margin-top: 2px; }
.strip { position: absolute; top: 0; left: 0; height: 100%; will-change: transform; }
.cell { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  font-size: 26px; border-radius: var(--radius); }
.cell img { max-width: 80%; max-height: 80%; pointer-events: none; }
.cell.effect { font-size: 11px; text-align: center; color: var(--legend); }
.cell.hover { background: var(--hover); }
.cell.lifted { opacity: var(--opacity-dim); }
.cell.fav { transition: left 0.12s ease-out, top 0.12s ease-out; }
.cell.away { visibility: hidden; }
.note { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center;
  padding: 0 8px; box-sizing: border-box; font-size: 12px; line-height: 1.3; color: var(--legend); white-space: normal; }
.placeholder { position: absolute; box-sizing: border-box; border-radius: var(--radius); background: var(--hover); }
.divider { position: absolute; top: 8%; height: 84%; width: 1px; background: var(--mod); }
.label { position: absolute; top: 0; font-size: 10px; color: var(--legend); writing-mode: vertical-rl; transform: rotate(180deg); }
.ghost { position: fixed; z-index: 2; pointer-events: none; display: flex; align-items: center; justify-content: center;
  font-size: 34px; background: var(--mod); border-radius: var(--radius); box-shadow: var(--shadow-lg); }
.alts .key { font-size: 26px; }
`;

export interface EmojiHandlers {
  /** Type an emoji (the base form; the caller applies the tone and updates Recent). */
  onEmoji(base: string, fromRecent: boolean): void;
  /** A skin tone was chosen from a hold: set it everywhere, then type `base` with it. */
  onTone(tone: Tone, base: string): void;
  /** Send a Steam item (the caller updates Recent, as for emoji). */
  onSteam(item: SteamItem, fromRecent: boolean): void;
  onFavorites(favorites: string[]): void;
  /** The bin over Recent: empty it. */
  onClearRecent(): void;
}

export interface EmojiPickerInput {
  data: EmojiData;
  steam: { item: SteamItem; image: string | null }[];
  /** False when Steam's item store could not be read. */
  steamAvailable?: boolean;
  tones: ReadonlyMap<string, readonly string[]>;
}

export interface EmojiView {
  /** Show new Recent/Favorites/tone (keeps the scroll position). */
  update(state: EmojiState): void;
  hoverAt(x: number, y: number): boolean;
  setBounds(rect: { top: number; left: number; width: number; height: number }): void;
  destroy(): void;
}

type Cell = { el: HTMLElement; section: string; base?: string; steam?: SteamItem; toned: boolean; sx: number };
type Section = { id: string; tab: string; x: number; columns: number };

const GROUP_TABS: Record<string, string> = {
  smileys: ICONS.smileys, people: ICONS.people, animals: ICONS.animals, food: ICONS.food, travel: ICONS.travel,
  activities: ICONS.activities, objects: ICONS.objects, symbols: ICONS.symbols, flags: ICONS.flags,
};
export const RECENT_NOTE = 'Recently used emoji appear here.';
export const FAVORITES_NOTE = 'Drag and drop from Recent to add a favorite, drop outside to remove.';

export const createEmojiView = (
  doc: Document,
  shadow: ShadowRoot,
  theme: Theme,
  input: EmojiPickerInput,
  initial: EmojiState,
  handlers: EmojiHandlers,
): EmojiView => {
  const style = doc.createElement('style');
  style.textContent = CSS + HOLD_POPUP_CSS;
  const root = doc.createElement('div');
  root.className = 'emoji';
  root.style.cssText = themeVars(theme);
  const tabsEl = doc.createElement('div');
  tabsEl.className = 'tabs';
  const grid = doc.createElement('div');
  grid.className = 'grid';
  const strip = doc.createElement('div');
  strip.className = 'strip';
  grid.append(strip);
  root.append(tabsEl, grid);
  shadow.append(style, root);

  let state: EmojiState = initial;
  let rows = 4;
  let cellSize = 40;
  let offset = 0;
  let width = 0;
  let cells: Cell[] = [];
  let sections: Section[] = [];
  const tabs = new Map<string, HTMLElement>();
  const trash = doc.createElement('div');
  trash.className = 'trash';
  trash.innerHTML = ICONS.clear;
  /** Where a dragged emoji will land in Favorites. */
  const placeholder = doc.createElement('div');
  placeholder.className = 'placeholder';
  /** A cell's place: sections fill down each column, then across. */
  const cellPos = (sx: number, i: number): { left: string; top: string } =>
    ({ left: `${sx + Math.floor(i / rows) * cellSize}px`, top: `${(i % rows) * cellSize}px` });

  const shown = (base: string): string => withTone(base, state.tone, input.tones);
  const clamp = (x: number): number => Math.max(0, Math.min(x, Math.max(0, width - grid.clientWidth)));
  const setOffset = (x: number): void => {
    offset = clamp(x);
    strip.style.transform = `translateX(${-offset}px)`;
    const current = [...sections].reverse().find((s) => s.x <= offset + 1) ?? sections[0];
    for (const [id, tab] of tabs) tab.classList.toggle('on', id === current?.id);
  };

  /** Lay out every section from scratch (on open, and when Favorites changes width or the tone changes). */
  const build = (): void => {
    strip.textContent = '';
    cells = [];
    sections = [];
    let x = 0;
    const gap = cellSize / 2;
    /** A Recent or Favorites entry: an emoji, or a Steam item (its picture when the user still has it). */
    const entry = (key: string): { base: string; steam?: SteamItem; image?: string | null } => {
      const item = steamFromKey(key);
      if (!item) return { base: key };
      const owned = input.steam.find((s) => s.item.kind === item.kind && s.item.name === item.name);
      return { base: key, steam: item, image: owned?.image ?? null };
    };
    const addCell = (section: string, sx: number, i: number, content: { base?: string; steam?: SteamItem; image?: string | null }): void => {
      const el = doc.createElement('div');
      el.className = `cell${content.steam?.kind === 'effect' ? ' effect' : ''}${section === 'favorites' ? ' fav' : ''}`;
      Object.assign(el.style, { ...cellPos(sx, i), width: `${cellSize}px`, height: `${cellSize}px` });
      if (content.base && !content.steam) el.textContent = shown(content.base);
      else if (content.image) {
        const img = doc.createElement('img');
        img.src = content.image;
        img.loading = 'lazy';
        img.alt = content.steam?.name ?? '';
        el.append(img);
      } else if (content.steam) el.textContent = content.steam.name;
      strip.append(el);
      const toned = !content.steam && !!content.base && input.tones.has(content.base);
      cells.push({ el, section, sx, toned, ...(content.base ? { base: content.base } : {}), ...(content.steam ? { steam: content.steam } : {}) });
    };
    const note = (sx: number, columns: number, text: string): void => {
      const el = doc.createElement('div');
      el.className = 'note';
      Object.assign(el.style, { left: `${sx}px`, top: '0', width: `${columns * cellSize}px`, height: `${rows * cellSize}px` });
      el.textContent = text;
      strip.append(el);
    };
    const divider = (at: number, label?: string): void => {
      const el = doc.createElement('div');
      el.className = 'divider';
      el.style.left = `${at}px`;
      strip.append(el);
      if (label) {
        const l = doc.createElement('div');
        l.className = 'label';
        l.style.left = `${at + 3}px`;
        l.textContent = label;
        strip.append(l);
      }
    };
    const section = (id: string, tab: string, columns: number, fill: (sx: number) => void): void => {
      sections.push({ id, tab, x, columns });
      fill(x);
      x += columns * cellSize + gap;
    };

    section('recent', ICONS.recent, RECENT_COLUMNS, (sx) => {
      if (!state.recent.length) note(sx, RECENT_COLUMNS, RECENT_NOTE);
      const room = RECENT_COLUMNS * rows - 1;
      state.recent.slice(0, room).forEach((key, i) => addCell('recent', sx, i, entry(key)));
      if (state.recent.length) {
        Object.assign(trash.style, { ...cellPos(sx, room), width: `${cellSize}px`, height: `${cellSize}px` });
        strip.append(trash);
      }
    });
    divider(x - gap / 2);
    const favColumns = Math.max(3, Math.ceil((state.favorites.length + 1) / rows));
    section('favorites', ICONS.favorites, favColumns, (sx) => {
      if (!state.favorites.length) note(sx, favColumns, FAVORITES_NOTE);
      state.favorites.forEach((key, i) => addCell('favorites', sx, i, entry(key)));
    });
    divider(x - gap / 2);
    for (const group of input.data.groups) {
      const columns = Math.ceil(group.items.length / rows);
      section(group.id, GROUP_TABS[group.id] ?? group.name.slice(0, 2), columns, (sx) => {
        group.items.forEach((item, i) => addCell(group.id, sx, i, { base: baseOf(item) }));
      });
    }
    const steamKinds: [SteamItem['kind'], string, string][] = [
      ['emoticon', ICONS.emoticons, 'No Steam emoticons yet'],
      ['sticker', ICONS.stickers, 'No Steam stickers yet'],
      ['effect', ICONS.effects, 'No room effects yet'],
    ];
    let firstSteam = true;
    for (const [kind, icon, empty] of steamKinds) {
      const items = input.steam.filter((s) => s.item.kind === kind);
      x += gap; // Steam items sit apart from the emoji
      divider(x - gap, firstSteam ? 'Steam' : undefined);
      firstSteam = false;
      const columns = items.length ? Math.ceil(items.length / rows) : 3;
      section(`steam-${kind}`, icon, columns, (sx) => {
        if (!items.length) note(sx, columns, input.steamAvailable === false ? 'Steam items unavailable' : empty);
        items.forEach(({ item, image }, i) => addCell(`steam-${kind}`, sx, i, { base: steamKey(item), steam: item, image }));
      });
    }
    width = x;
    strip.style.width = `${width}px`;

    tabsEl.textContent = '';
    tabs.clear();
    for (const s of sections) {
      const tab = doc.createElement('div');
      tab.className = 'tab';
      if (s.tab.startsWith('<svg')) tab.innerHTML = s.tab;
      else tab.textContent = s.tab;
      tab.dataset['section'] = s.id;
      tabsEl.append(tab);
      tabs.set(s.id, tab);
    }
    setOffset(offset);
  };

  // --- pointer handling --------------------------------------------------------------------------

  type Mode = 'idle' | 'press' | 'scroll' | 'drag' | 'tones';
  let mode: Mode = 'idle';
  let start = { x: 0, y: 0, offset: 0 };
  let pressed: Cell | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let samples: { t: number; x: number }[] = [];
  let glide: number | null = null;
  let ghost: HTMLElement | null = null;
  let dropIndex = -1;
  let toneBox: HoldPopup | null = null;
  let hovered: HTMLElement | undefined;
  const win = doc.defaultView;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const cellAt = (target: EventTarget | null): Cell | undefined => cells.find((c) => c.el === target || c.el.contains(target as Node));
  const cellAtPoint = (x: number, y: number): Cell | undefined => {
    const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
    return hits.map(cellAt).find(Boolean);
  };
  const point = (e: Event): { x: number; y: number } | null => {
    const t = (e as TouchEvent).changedTouches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  };
  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const stopGlide = (): void => {
    if (glide !== null) win?.cancelAnimationFrame(glide);
    glide = null;
  };

  /**
   * Where a drop at (x, y) lands in Favorites, counted among the favorites other than the dragged one,
   * or -1 when not over Favorites (or it is full and this would be a new one).
   */
  const favoriteIndexAt = (x: number, y: number): number => {
    const fav = sections.find((s) => s.id === 'favorites');
    const box = grid.getBoundingClientRect();
    const base = pressed?.base;
    if (!fav || !base || box.width === 0) return -1;
    const others = state.favorites.filter((f) => f !== base).length;
    if (others === state.favorites.length && state.favorites.length >= MAX_FAVORITES) return -1;
    const gx = x - box.left + offset - fav.x;
    const gy = y - box.top;
    if (gx < 0 || gx > fav.columns * cellSize || gy < 0 || gy > rows * cellSize) return -1;
    const index = Math.floor(gx / cellSize) * rows + Math.min(rows - 1, Math.floor(gy / cellSize));
    return Math.min(index, others);
  };
  /** Open an empty place at `gap` in Favorites, the others sliding aside (-1 puts everything back). */
  const showGap = (gap: number): void => {
    if (gap === dropIndex) return;
    dropIndex = gap;
    placeholder.remove();
    const fav = sections.find((s) => s.id === 'favorites');
    if (gap >= 0 && fav) {
      Object.assign(placeholder.style, { ...cellPos(fav.x, gap), width: `${cellSize}px`, height: `${cellSize}px` });
      strip.append(placeholder);
    }
    let i = 0;
    for (const cell of cells) {
      if (cell.section !== 'favorites') continue;
      const away = gap >= 0 && cell === pressed; // the dragged one leaves its place while a gap is open
      cell.el.classList.toggle('away', away);
      if (away) continue;
      Object.assign(cell.el.style, cellPos(cell.sx, gap >= 0 && i >= gap ? i + 1 : i));
      i++;
    }
  };

  const lift = (cell: Cell, p: { x: number; y: number }): void => {
    mode = 'drag';
    lastTouchAt = now();
    cell.el.classList.add('lifted');
    ghost = doc.createElement('div');
    ghost.className = 'ghost';
    ghost.innerHTML = cell.el.innerHTML; // an emoji, or a Steam item's picture
    Object.assign(ghost.style, { width: `${cellSize * 1.2}px`, height: `${cellSize * 1.2}px` });
    root.append(ghost);
    moveGhost(p);
  };
  const moveGhost = (p: { x: number; y: number }): void => {
    if (!ghost) return;
    // Centred just above the laser, so the target under it stays visible.
    Object.assign(ghost.style, { left: `${p.x - cellSize * 0.6}px`, top: `${p.y - cellSize * 1.6}px` });
    showGap(favoriteIndexAt(p.x, p.y));
  };
  const drop = (): void => {
    const base = pressed?.base;
    const at = dropIndex;
    clearOverlays();
    if (!base) return;
    const old = state.favorites.indexOf(base);
    if (at >= 0) {
      const next = placeFavorite(state.favorites, base, old >= 0 && at >= old ? at + 1 : at);
      if (next.join() !== state.favorites.join()) handlers.onFavorites(next);
    } else if (pressed?.section === 'favorites') handlers.onFavorites(removeFavorite(state.favorites, base));
  };

  /** Skin tones over a held emoji: the same popup and picking as a key's alternates. */
  const openTones = (cell: Cell): void => {
    const variants = cell.base ? input.tones.get(cell.base) : undefined;
    const at = cell.el.getBoundingClientRect();
    if (!variants || !cell.el.isConnected) return;
    mode = 'tones';
    lastTouchAt = now();
    toneBox = openHoldPopup(doc, shadow, root, at, variants,
      { width: cellSize, height: cellSize }, last, false);
  };
  const pickTone = (x: number, y: number): void => toneBox?.pickAt(x, y);

  /** Remove any tone popup or lifted emoji left over (a missed release, a second laser, a scroll). */
  const clearOverlays = (): void => {
    toneBox?.close();
    toneBox = null;
    ghost?.remove();
    ghost = null;
    showGap(-1);
    for (const cell of cells) cell.el.classList.remove('lifted');
  };

  const tap = (cell: Cell | undefined): void => {
    if (!cell) return;
    if (cell.steam) handlers.onSteam(cell.steam, cell.section === 'recent');
    else if (cell.base) handlers.onEmoji(cell.base, cell.section === 'recent');
  };

  root.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopGlide();
    clearOverlays();
    const p = point(e) ?? { x: 0, y: 0 };
    if ((e.target as HTMLElement | null)?.closest?.('.trash')) {
      mode = 'idle';
      handlers.onClearRecent();
      return;
    }
    const tab = (e.target as HTMLElement | null)?.closest?.('.tab') as HTMLElement | null;
    if (tab) {
      const section = sections.find((s) => s.id === tab.dataset['section']);
      if (section) setOffset(section.x);
      mode = 'idle';
      return;
    }
    pressed = cellAt(e.target);
    start = { ...p, offset };
    last = p;
    lastTouchAt = now();
    samples = [{ t: now(), x: p.x }];
    mode = 'press';
    clearHold();
    const held = pressed;
    if (held && (held.section === 'recent' || held.section === 'favorites')) {
      holdTimer = setTimeout(() => { holdTimer = null; if (mode === 'press') lift(held, last); }, HOLD_MS);
    } else if (held?.toned) {
      holdTimer = setTimeout(() => { holdTimer = null; if (mode === 'press') openTones(held); }, HOLD_MS);
    }
  }, { passive: false });
  let last = { x: 0, y: 0 };
  let lastTouchAt = 0;
  let built = false;
  // A gesture that started here is followed across the whole shadow root (a fast drag or tone pick can
  // leave the picker, e.g. into the key row), so its release is never lost and nothing is left hanging.
  const onMove = (e: Event): void => {
    if (mode === 'idle') return;
    e.preventDefault();
    e.stopPropagation();
    const p = point(e);
    if (!p) return;
    last = p;
    lastTouchAt = now();
    const slop = pressed && (pressed.toned || pressed.section === 'recent' || pressed.section === 'favorites') ? HOLD_SLOP_PX : SCROLL_SLOP_PX;
    if (mode === 'press' && Math.hypot(p.x - start.x, p.y - start.y) > slop) {
      clearHold();
      mode = 'scroll';
    }
    if (mode === 'scroll') {
      setOffset(start.offset - (p.x - start.x));
      samples.push({ t: now(), x: p.x });
      samples = samples.filter((s) => s.t > now() - 100);
    } else if (mode === 'drag') moveGhost(p);
    else if (mode === 'tones') pickTone(p.x, p.y);
  };
  const onEnd = (e: Event): void => {
    if (mode === 'idle') return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };
  /** End the gesture as a release where the touch last was. */
  const finish = (): void => {
    clearHold();
    const was = mode;
    mode = 'idle';
    if (was === 'press') tap(pressed);
    else if (was === 'drag') drop();
    else if (was === 'tones' && toneBox && pressed?.base) {
      const pick = toneBox.pick;
      clearOverlays();
      if (pick >= 0) handlers.onTone(TONES[pick] ?? '', pressed.base);
    } else if (was === 'scroll') startGlide();
    if (was !== 'drag') clearOverlays();
    pressed = undefined;
  };
  const onCancel = (): void => {
    if (mode === 'idle') return;
    clearHold();
    clearOverlays();
    mode = 'idle';
    pressed = undefined;
  };
  const listen = { capture: true, passive: false } as const;
  shadow.addEventListener('touchmove', onMove, listen);
  shadow.addEventListener('touchend', onEnd, listen);
  shadow.addEventListener('touchcancel', onCancel, listen);
  // A release outside our shadow root (off the keyboard entirely) reaches the window.
  const ends = ['touchend', 'pointerup', 'mouseup'] as const;
  for (const type of ends) win?.addEventListener(type, onEnd, listen);
  win?.addEventListener('touchcancel', onCancel, listen);
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (mode === 'tones' || mode === 'drag') return; // the stick must not slide the grid under a popup
    stopGlide();
    setOffset(offset + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
  }, { passive: false });
  root.addEventListener('click', (e) => {
    // Desktop fallback (mouse); touch already handled the press.
    if ((e as MouseEvent).detail === 0) return;
    if ((e.target as HTMLElement | null)?.closest?.('.trash')) {
      handlers.onClearRecent();
      return;
    }
    const tab = (e.target as HTMLElement | null)?.closest?.('.tab') as HTMLElement | null;
    if (tab) {
      const section = sections.find((s) => s.id === tab.dataset['section']);
      if (section) setOffset(section.x);
    } else if (mode === 'idle') tap(cellAt(e.target));
  });

  /** Keep moving after a quick drag, slowing like a phone list. */
  const startGlide = (): void => {
    const first = samples[0];
    const lastSample = samples[samples.length - 1];
    if (!first || !lastSample || !win || lastSample.t - first.t < 10) return;
    let speed = -((lastSample.x - first.x) / (lastSample.t - first.t)) * 1000; // px/s, in scroll direction
    if (Math.abs(speed) < GLIDE_MIN_SPEED) return;
    let at = now();
    const step = (): void => {
      const t = now();
      const dt = (t - at) / 1000;
      at = t;
      speed *= Math.exp(-dt / GLIDE_TAU_S);
      setOffset(offset + speed * dt);
      glide = Math.abs(speed) > 20 && offset > 0 && offset < clamp(Infinity) ? win.requestAnimationFrame(step) : null;
    };
    glide = win.requestAnimationFrame(step);
  };

  return {
    update: (next) => {
      const rebuild = next.tone !== state.tone || next.favorites.length !== state.favorites.length
        || next.recent.join() !== state.recent.join() || next.favorites.join() !== state.favorites.join();
      state = next;
      if (rebuild) build();
    },
    hoverAt: (x, y) => {
      // While the trigger is held, the laser's moves come as touch moves too. The laser moving on with
      // no touch moves means the release was lost somewhere: end the gesture there and then.
      if ((mode === 'drag' || mode === 'tones' || mode === 'scroll') && now() - lastTouchAt > RELEASE_LOST_MS
        && Math.hypot(x - last.x, y - last.y) > SCROLL_SLOP_PX) finish();
      if (mode === 'tones') {
        pickTone(x, y);
        return false;
      }
      if (mode === 'drag') return false; // dragging follows touch alone: two pointer sources disagree
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      trash.classList.toggle('hover', hits.includes(trash) || hits.some((h) => trash.contains(h)));
      const cell = cellAtPoint(x, y)?.el;
      if (cell === hovered) return false;
      hovered?.classList.remove('hover');
      hovered = cell;
      cell?.classList.add('hover');
      return false; // no haptics in the grid
    },
    setBounds: ({ top, left, width: w, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${height}px` });
      const gridHeight = Math.max(0, height - TABS_PX - 6);
      const nextRows = Math.max(2, Math.floor(gridHeight / 40));
      const nextSize = Math.floor(gridHeight / nextRows) || 40;
      if (built && nextRows === rows && nextSize === cellSize) return; // the periodic check: nothing changed
      onCancel();
      rows = nextRows;
      cellSize = nextSize;
      built = true;
      build();
    },
    destroy: () => {
      clearHold();
      stopGlide();
      shadow.removeEventListener('touchmove', onMove, listen);
      shadow.removeEventListener('touchend', onEnd, listen);
      shadow.removeEventListener('touchcancel', onCancel, listen);
      for (const type of ends) win?.removeEventListener(type, onEnd, listen);
      win?.removeEventListener('touchcancel', onCancel, listen);
      style.remove();
      root.remove();
    },
  };
};
