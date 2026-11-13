// The emoji picker, drawn in the keyboard area above a row of keys: category tabs, then one
// horizontally scrolling grid (filled down each column) with Recent (and its bin), Favorites, the
// (the tabs scroll the same way when they are wider than the picker, and keep the current one in view)
// Unicode groups and the user's Steam items, separated. Recent and Favorites hold emoji and Steam items.
// Drag or the thumbstick (wheel events) scrolls; a quick drag glides. Holding a toned emoji offers its
// skin tones (the shared hold popup); holding an entry in Recent or Favorites lifts it for drag and drop
// into Favorites, where a placeholder opens (drop elsewhere removes a favorite). A gesture is followed
// across the whole shadow root, and ended if its release is lost. The laser ticks as it comes onto a cell,
// the bin or a tab, but not while anything scrolls; a lifted entry ticks only into and out of Favorites, and
// as it drops.
//
// In kaomoji mode the same frame shows text faces instead: a Recent and a section per category, in wide
// cells, each face shrunk or squeezed to fit its cell. Taps only: no favorites, lifting or hold popups.

import type { Theme } from '../core/catalog.js';
import { HOLD_MS, RELEASE_LOST_MS, SLOP_PX, touchGuard } from '../core/interaction.js';
import { HOLD_POPUP_CSS, openHoldPopup, type HoldPopup } from './hold-popup.js';
import { ICONS } from './icons.js';
import { BAR_PX, sizeVars } from './sizes.js';
import { listenTouch, type TouchPoint } from './gesture.js';
import { themeVars } from './theme.js';
import { FACE_CELLS, FACE_PX, KAOMOJI_RECENT_COLUMNS, MAX_FAVORITES, TONES, fitFace, steamFromKey, steamKey, removeFavorite, placeFavorite, withTone, baseOf,
  type EmojiData, type EmojiState, type KaomojiCategory, type SteamItem, type Tone } from '../core/emoji.js';

export const RECENT_COLUMNS = 6;
/** Recent's block is 6 × 4; its last place holds the bin. */
export const RECENT_MAX = RECENT_COLUMNS * 4 - 1;
const GLIDE_TAU_S = 0.35;
const GLIDE_MIN_SPEED = 300;
/** After the thumbstick scrolls, the cells passing under the laser stay quiet this long. */
const WHEEL_QUIET_MS = 150;
/** Room kept clear beside a face in its cell (both sides together). */
const FACE_PAD_PX = 10;

const CSS = `
.emoji { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; padding: 2px;
  background: var(--surface); color: var(--text); font: 400 var(--ui-control)/1 var(--font); overflow: hidden;
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.tabs { height: var(--bar-height); flex: none; overflow: hidden; }
.tabstrip { position: relative; display: flex; gap: 2px; width: max-content; height: 100%; will-change: transform; }
.tab { flex: none; min-width: 30px; height: 100%; display: flex; align-items: center; justify-content: center;
  padding: 0 6px; box-sizing: border-box; border-radius: var(--radius); font-size: var(--ui-icon); color: var(--legend); }
.tab.text { padding: 0 7px; font-size: var(--ui-control); white-space: nowrap; }
.tab.on { background: var(--mod); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.trash { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: var(--radius); font-size: var(--ui-icon-lg); color: var(--legend); }
.trash.hover { background: var(--hover); color: var(--text); }
.grid { position: relative; flex: 1; overflow: hidden; margin-top: 2px; }
.strip { position: absolute; top: 0; left: 0; height: 100%; will-change: transform; }
.cell { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  font-size: var(--size-emoji); border-radius: var(--radius); }
.cell img { max-width: 80%; max-height: 80%; pointer-events: none; }
.cell.effect { font-size: var(--ui-tiny); text-align: center; color: var(--legend); }
.cell.hover { background: var(--hover); }
.cell.face { font-size: ${FACE_PX}px; font-family: var(--font-kaomoji); overflow: hidden; white-space: nowrap; background: none; }
.cell.face::before { content: ""; position: absolute; inset: 2px; border-radius: var(--radius); background: var(--key); }
.cell.face.hover::before { background: var(--hover); }
.cell.face span { position: relative; display: inline-block; }
.cell.lifted { opacity: var(--opacity-dim); }
.cell.fav { transition: left 0.12s ease-out, top 0.12s ease-out; }
.cell.away { visibility: hidden; }
.note { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center;
  padding: 0 8px; box-sizing: border-box; font-size: var(--ui-caption); line-height: 1.3; color: var(--legend); white-space: normal; }
.placeholder { position: absolute; box-sizing: border-box; border-radius: var(--radius); background: var(--hover); }
.divider { position: absolute; top: 8%; height: 84%; width: 1px; background: var(--mod); }
.label { position: absolute; top: 0; font-size: var(--ui-label); color: var(--legend); writing-mode: vertical-rl; transform: rotate(180deg); }
.label.upright { transform: none; }
.ghost { position: fixed; z-index: 2; pointer-events: none; display: flex; align-items: center; justify-content: center;
  font-size: var(--ui-emoji-lifted); background: var(--mod); border-radius: var(--radius); box-shadow: var(--shadow-lg); }
.alts .key { font-size: var(--size-emoji); }
`;

export interface EmojiHandlers {
  /** Type an emoji (the base form; the caller applies the tone and updates Recent). */
  onEmoji(base: string, fromRecent: boolean): void;
  /** A skin tone was chosen from a hold: set it everywhere, then type `base` with it. */
  onTone(tone: Tone, base: string): void;
  /** Send a Steam item (the caller updates Recent, as for emoji). */
  onSteam(item: SteamItem, fromRecent: boolean): void;
  onFavorites(favorites: string[]): void;
  /** Type a kaomoji (the caller updates its Recent, which holds `room` faces). */
  onKaomoji(face: string, fromRecent: boolean, room: number): void;
  /** The bin over Recent: empty it. */
  onClearRecent(): void;
}

export interface EmojiPickerInput {
  data: EmojiData;
  steam: { item: SteamItem; image: string | null }[];
  /** False when Steam's item store could not be read. */
  steamAvailable?: boolean;
  /** True while Steam is still fetching the items. */
  steamLoading?: boolean;
  tones: ReadonlyMap<string, readonly string[]>;
  /** Kaomoji mode's faces, named in Japanese on a Japanese keyboard; without them the picker stays on emoji. */
  kaomoji?: { categories: readonly KaomojiCategory[]; japanese: boolean } | null;
}

export interface EmojiView {
  /** Show new Recent/Favorites/tone (keeps the scroll position). */
  update(state: EmojiState): void;
  /** The laser over the picker; true when a haptic tick is due (see the top of this file). */
  hoverAt(x: number, y: number): boolean;
  setBounds(rect: { top: number; left: number; width: number; height: number }): void;
  /** Show the Steam items again (they arrived, or stopped loading); keeps the scroll position. */
  setSteam(steam: EmojiPickerInput['steam'], loading: boolean): void;
  destroy(): void;
}

/** `at` is the cell's place (its section and index there), the same across a redraw. */
type Cell = { el: HTMLElement; at: string; section: string; base?: string; steam?: SteamItem; face?: string; toned: boolean; sx: number };
/** `lead` is what a jump to the section shows before it: its divider and label. */
type Section = { id: string; tab: string; x: number; columns: number; lead: number };

const GROUP_TABS: Record<string, string> = {
  smileys: ICONS.smileys, people: ICONS.people, animals: ICONS.animals, food: ICONS.food, travel: ICONS.travel,
  activities: ICONS.activities, objects: ICONS.objects, symbols: ICONS.symbols, flags: ICONS.flags,
};
export const RECENT_NOTE = 'Recently used emoji appear here.';
export const KAOMOJI_RECENT_NOTE = 'Recently used kaomoji appear here.';
export const FAVORITES_NOTE = 'Drag and drop from Recent to add a favorite, drop outside to remove.';
export const STEAM_LOADING_NOTE = 'Loading your Steam items…';

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
  root.style.cssText = themeVars(theme) + sizeVars('normal');
  const tabsEl = doc.createElement('div');
  tabsEl.className = 'tabs';
  const tabStrip = doc.createElement('div');
  tabStrip.className = 'tabstrip';
  tabsEl.append(tabStrip);
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
  /** A cell's width: an emoji's is square, a face's wider. */
  let cellWidth = 40;
  /** Each face's width at FACE_PX, measured once. */
  const faceWidths = new Map<string, number>();
  let shownTab: Section | undefined;
  /** The tab strip's own scroll, and how far it can go (0 when the tabs fit). */
  let tabOffset = 0;
  let tabMax = 0;
  const measureTabs = (): void => { tabMax = Math.max(0, tabStrip.offsetWidth - tabsEl.clientWidth); };
  const setTabOffset = (x: number): void => {
    tabOffset = Math.max(0, Math.min(x, tabMax));
    tabStrip.style.transform = `translateX(${-tabOffset}px)`;
  };
  const faces = (): EmojiPickerInput['kaomoji'] => (state.mode === 'kaomoji' ? input.kaomoji : null);
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
    ({ left: `${sx + Math.floor(i / rows) * cellWidth}px`, top: `${(i % rows) * cellSize}px` });

  const shown = (base: string): string => withTone(base, state.tone, input.tones);
  const clamp = (x: number): number => Math.max(0, Math.min(x, Math.max(0, width - grid.clientWidth)));
  /** The tab last tapped, while the grid stays where that put it: a section near the end cannot scroll to the left edge. */
  let jumped: string | undefined;
  const setOffset = (x: number, tapped?: Section): void => {
    if (tapped) jumped = tapped.id;
    else if (clamp(x) !== offset) jumped = undefined;
    offset = clamp(x);
    strip.style.transform = `translateX(${-offset}px)`;
    const current = sections.find((s) => s.id === jumped && s.x - s.lead > offset)
      ?? [...sections].reverse().find((s) => s.x - s.lead <= offset + 1) ?? sections[0];
    for (const [id, tab] of tabs) tab.classList.toggle('on', id === current?.id);
    if (current === shownTab) return;
    shownTab = current;
    // Tabs wider than the picker scroll: bring the current one's neighbours into view, moving no more
    // than that takes, and the current one fully whatever else fits.
    const at = sections.indexOf(current!);
    const tab = tabs.get(current?.id ?? '');
    const first = tabs.get(sections[Math.max(0, at - 1)]?.id ?? '');
    const last = tabs.get(sections[Math.min(sections.length - 1, at + 1)]?.id ?? '');
    if (!tab || !first || !last) return;
    measureTabs();
    const room = tabsEl.clientWidth;
    const near = Math.max(Math.min(tabOffset, first.offsetLeft), last.offsetLeft + last.offsetWidth - room);
    setTabOffset(Math.min(Math.max(near, tab.offsetLeft + tab.offsetWidth - room), tab.offsetLeft));
  };

  /** Lay out every section from scratch (on open, and when Favorites changes width or the tone changes). */
  const build = (): void => {
    strip.textContent = '';
    cells = [];
    sections = [];
    let x = 0;
    const gap = cellSize / 2;
    const kaomoji = faces();
    cellWidth = kaomoji ? Math.round(cellSize * FACE_CELLS) : cellSize;
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
      cells.push({ el, at: `${section}:${i}`, section, sx, toned, ...(content.base ? { base: content.base } : {}), ...(content.steam ? { steam: content.steam } : {}) });
    };
    const note = (sx: number, columns: number, text: string): void => {
      const el = doc.createElement('div');
      el.className = 'note';
      Object.assign(el.style, { left: `${sx}px`, top: '0', width: `${columns * cellWidth}px`, height: `${rows * cellSize}px` });
      el.textContent = text;
      strip.append(el);
    };
    const divider = (at: number, label?: string, upright = false): void => {
      const el = doc.createElement('div');
      el.className = 'divider';
      el.style.left = `${at}px`;
      strip.append(el);
      if (label) {
        const l = doc.createElement('div');
        l.className = upright ? 'label upright' : 'label'; // kana and kanji stand upright in a vertical line
        l.style.left = `${at + 3}px`;
        l.textContent = label;
        strip.append(l);
      }
    };
    const section = (id: string, tab: string, columns: number, fill: (sx: number) => void, lead = 0): void => {
      sections.push({ id, tab, x, columns, lead });
      fill(x);
      x += columns * cellWidth + gap;
    };
    const drawn: [HTMLElement, string][] = [];
    const addFace = (sectionId: string, sx: number, i: number, face: string): void => {
      const el = doc.createElement('div');
      el.className = 'cell face';
      Object.assign(el.style, { ...cellPos(sx, i), width: `${cellWidth}px`, height: `${cellSize}px` });
      const text = doc.createElement('span');
      text.textContent = face;
      el.append(text);
      strip.append(el);
      drawn.push([text, face]);
      cells.push({ el, at: `${sectionId}:${i}`, section: sectionId, sx, toned: false, face });
    };

    if (kaomoji) {
      const room = KAOMOJI_RECENT_COLUMNS * rows;
      section('recent', ICONS.recent, KAOMOJI_RECENT_COLUMNS, (sx) => {
        if (!state.kaomojiRecent.length) note(sx, KAOMOJI_RECENT_COLUMNS, KAOMOJI_RECENT_NOTE);
        state.kaomojiRecent.slice(0, room).forEach((face, i) => addFace('recent', sx, i, face));
      });
      for (const category of kaomoji.categories) {
        const name = kaomoji.japanese ? category.ja : category.en;
        divider(x - gap + 3, name, kaomoji.japanese); // the label fills the gap before its section
        section(category.id, name, Math.ceil(category.faces.length / rows), (sx) => {
          category.faces.forEach((face, i) => addFace(category.id, sx, i, face));
        }, gap);
      }
    } else {
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
          if (!items.length) note(sx, columns, input.steamAvailable === false ? 'Steam items unavailable' : input.steamLoading ? STEAM_LOADING_NOTE : empty);
          items.forEach(({ item, image }, i) => addCell(`steam-${kind}`, sx, i, { base: steamKey(item), steam: item, image }));
        });
      }
    }
    width = x;
    strip.style.width = `${width}px`;

    tabStrip.textContent = '';
    tabs.clear();
    for (const s of sections) {
      const tab = doc.createElement('div');
      const icon = s.tab.startsWith('<svg');
      tab.className = kaomoji && !icon ? 'tab text' : 'tab'; // Recent's icon, as over emoji; a category's name
      if (icon) tab.innerHTML = s.tab;
      else tab.textContent = s.tab;
      tab.dataset['section'] = s.id;
      tabStrip.append(tab);
      tabs.set(s.id, tab);
    }
    // Fit the faces: every width not yet known is read in one layout, then the styles are written. What is
    // measured is the drawn text itself, so in the cells' own font (--font-kaomoji).
    for (const [el, face] of drawn) {
      const measured = faceWidths.has(face) ? 0 : el.offsetWidth;
      if (measured > 0) faceWidths.set(face, measured);
    }
    for (const [el, face] of drawn) {
      const fit = fitFace(faceWidths.get(face) ?? 0, cellWidth - FACE_PAD_PX);
      if (fit.font < FACE_PX) el.style.fontSize = `${fit.font.toFixed(2)}px`;
      if (fit.scaleX < 1) el.style.transform = `scaleX(${fit.scaleX.toFixed(3)})`;
    }
    shownTab = undefined;
    measureTabs();
    setTabOffset(tabOffset);
    setOffset(offset);
  };

  // --- pointer handling --------------------------------------------------------------------------

  /** 'tabs' is a press on the tab bar (a tap on its tab when released), 'tabscroll' a drag of it. */
  type Mode = 'idle' | 'press' | 'scroll' | 'drag' | 'tones' | 'tabs' | 'tabscroll';
  let pressedTab: HTMLElement | null = null;
  const jumpTo = (tab: HTMLElement | null): void => {
    const section = sections.find((s) => s.id === tab?.dataset['section']);
    if (section) setOffset(section.x - section.lead, section);
  };
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
  /** What the laser is on, for haptics: a cell's place, the bin, a tab, or '' for none of them. */
  let over = '';
  /** A tick hoverAt has yet to report: a tone pick moved, a lifted entry crossed Favorites' edge or dropped. */
  let tickDue = false;
  let wheelAt = -Infinity;
  const win = doc.defaultView;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const guard = touchGuard(now);

  const cellAt = (target: EventTarget | null): Cell | undefined => cells.find((c) => c.el === target || c.el.contains(target as Node));
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
    tickDue = false; // lifting a favorite opens its gap at once: not a crossing
  };
  const moveGhost = (p: { x: number; y: number }): void => {
    if (!ghost) return;
    // Centred just above the laser, so the target under it stays visible.
    Object.assign(ghost.style, { left: `${p.x - cellSize * 0.6}px`, top: `${p.y - cellSize * 1.6}px` });
    const inside = dropIndex >= 0;
    showGap(favoriteIndexAt(p.x, p.y));
    if (dropIndex >= 0 !== inside) tickDue = true;
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
    tickDue = false;
    toneBox = openHoldPopup(doc, shadow, root, at, variants,
      { width: cellSize, height: cellSize }, last, false, '', () => { tickDue = true; });
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
    if (cell.face) handlers.onKaomoji(cell.face, cell.section === 'recent', KAOMOJI_RECENT_COLUMNS * rows);
    else if (cell.steam) handlers.onSteam(cell.steam, cell.section === 'recent');
    else if (cell.base) handlers.onEmoji(cell.base, cell.section === 'recent');
  };

  const onStart = (touch: TouchPoint | null, e: Event): void => {
    stopGlide();
    clearOverlays();
    const p = touch ?? { x: 0, y: 0 };
    if ((e.target as HTMLElement | null)?.closest?.('.trash')) {
      mode = 'idle';
      handlers.onClearRecent();
      return;
    }
    if ((e.target as HTMLElement | null)?.closest?.('.tabs')) {
      // The tab bar: a release where it was pressed jumps to the tab there; a drag scrolls the tabs.
      pressedTab = (e.target as HTMLElement).closest('.tab');
      pressed = undefined;
      measureTabs();
      start = { ...p, offset: tabOffset };
      last = p;
      lastTouchAt = now();
      samples = [{ t: now(), x: p.x }];
      mode = 'tabs';
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
    if (held?.face) return; // a face only taps
    if (held && (held.section === 'recent' || held.section === 'favorites')) {
      holdTimer = setTimeout(() => { holdTimer = null; if (mode === 'press') lift(held, last); }, HOLD_MS);
    } else if (held?.toned) {
      holdTimer = setTimeout(() => { holdTimer = null; if (mode === 'press') openTones(held); }, HOLD_MS);
    }
  };
  let last = { x: 0, y: 0 };
  let lastTouchAt = 0;
  let built = false;
  /** Steam items came in during a gesture: redrawn when it ends, so a press in progress is not lost. */
  let stale = false;
  const redrawIfStale = (): void => {
    if (stale) build();
    stale = false;
  };
  // A gesture that started here is followed across the whole shadow root (a fast drag or tone pick can
  // leave the picker, e.g. into the key row), so its release is never lost and nothing is left hanging.
  const onMove = (p: TouchPoint | null): boolean => {
    if (mode === 'idle') return false; // not ours: e.g. the key row's own touches
    if (!p) return true;
    last = p;
    lastTouchAt = now();
    const slop = pressed && !pressed.face && (pressed.toned || pressed.section === 'recent' || pressed.section === 'favorites') ? SLOP_PX.holdWander : SLOP_PX.scroll;
    if (mode === 'press' && Math.hypot(p.x - start.x, p.y - start.y) > slop) {
      clearHold();
      mode = 'scroll';
    }
    if (mode === 'tabs' && Math.hypot(p.x - start.x, p.y - start.y) > SLOP_PX.scroll) mode = 'tabscroll';
    if (mode === 'tabscroll') {
      setTabOffset(start.offset - (p.x - start.x));
      samples.push({ t: now(), x: p.x });
      samples = samples.filter((s) => s.t > now() - 100);
    } else if (mode === 'scroll') {
      setOffset(start.offset - (p.x - start.x));
      samples.push({ t: now(), x: p.x });
      samples = samples.filter((s) => s.t > now() - 100);
    } else if (mode === 'drag') moveGhost(p);
    else if (mode === 'tones') pickTone(p.x, p.y);
    return true;
  };
  const onEnd = (): boolean => {
    if (mode === 'idle') return false;
    finish();
    return true;
  };
  /** End the gesture as a release where the touch last was. */
  const finish = (): void => {
    clearHold();
    const was = mode;
    mode = 'idle';
    if (was === 'tabs') jumpTo(pressedTab);
    else if (was === 'tabscroll') startGlide(() => tabOffset, setTabOffset, () => tabMax);
    else if (was === 'press') tap(pressed);
    else if (was === 'drag') {
      drop();
      tickDue = true;
    }
    else if (was === 'tones' && toneBox && pressed?.base) {
      const pick = toneBox.pick;
      clearOverlays();
      if (pick >= 0) handlers.onTone(TONES[pick] ?? '', pressed.base);
    } else if (was === 'scroll') startGlide(() => offset, setOffset, () => clamp(Infinity));
    if (was !== 'drag') clearOverlays();
    pressed = undefined;
    redrawIfStale();
  };
  const onCancel = (): void => {
    if (mode === 'idle') return;
    clearHold();
    clearOverlays();
    mode = 'idle';
    pressed = undefined;
    redrawIfStale();
  };
  listenTouch(root, { start: onStart, click: (e) => onClick(e) }, { guard });
  // Followed across the whole shadow root (shared with the key row): removed again in destroy.
  const stopFollowing = listenTouch(shadow, { move: onMove, end: onEnd, cancel: onCancel }, { guard, capture: true });
  // A release outside our shadow root (off the keyboard entirely) reaches the window.
  const listen = { capture: true, passive: false } as const;
  const endOutside = (e: Event): void => {
    if (!onEnd()) return;
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ['touchend', 'pointerup', 'mouseup'] as const) win?.addEventListener(type, endOutside, listen);
  win?.addEventListener('touchcancel', onCancel, listen);
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (mode === 'tones' || mode === 'drag') return; // the stick must not slide the grid under a popup
    stopGlide();
    wheelAt = now();
    const by = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (tabsEl.contains(e.target as Node | null)) { // over the tabs, the stick scrolls them
      measureTabs();
      setTabOffset(tabOffset + by);
    } else setOffset(offset + by);
  }, { passive: false });
  function onClick(e: MouseEvent): void {
    // Desktop fallback (mouse); touch already handled the press.
    if ((e.target as HTMLElement | null)?.closest?.('.trash')) {
      handlers.onClearRecent();
      return;
    }
    const tab = (e.target as HTMLElement | null)?.closest?.('.tab') as HTMLElement | null;
    if (tab) jumpTo(tab);
    else if (mode === 'idle') tap(cellAt(e.target));
  }

  /** Keep moving after a quick drag (of the grid, or of the tabs), slowing like a phone list. */
  const startGlide = (where: () => number, move: (x: number) => void, max: () => number): void => {
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
      move(where() + speed * dt);
      glide = Math.abs(speed) > 20 && where() > 0 && where() < max() ? win.requestAnimationFrame(step) : null;
    };
    glide = win.requestAnimationFrame(step);
  };

  return {
    update: (next) => {
      const rebuild = next.tone !== state.tone || next.favorites.length !== state.favorites.length
        || next.recent.join() !== state.recent.join() || next.favorites.join() !== state.favorites.join()
        || next.mode !== state.mode || next.kaomojiRecent.join('\n') !== state.kaomojiRecent.join('\n');
      if (next.mode !== state.mode) offset = tabOffset = 0; // the other mode opens at its Recent
      state = next;
      if (rebuild) build();
    },
    hoverAt: (x, y) => {
      // While the trigger is held, the laser's moves come as touch moves too. The laser moving on with
      // no touch moves means the release was lost somewhere: end the gesture there and then.
      if ((mode === 'drag' || mode === 'tones' || mode === 'scroll' || mode === 'tabscroll') && now() - lastTouchAt > RELEASE_LOST_MS
        && Math.hypot(x - last.x, y - last.y) > SLOP_PX.scroll) finish();
      if (mode === 'tones') pickTone(x, y);
      const due = tickDue;
      tickDue = false;
      if (mode === 'tones' || mode === 'drag') return due; // dragging follows touch alone: two pointer sources disagree
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      const bin = hits.includes(trash) || hits.some((h) => trash.contains(h));
      trash.classList.toggle('hover', bin);
      const cell = hits.map(cellAt).find(Boolean);
      if (cell?.el !== hovered) {
        hovered?.classList.remove('hover');
        hovered = cell?.el;
        hovered?.classList.add('hover');
      }
      const tab = hits.map((h) => h.closest<HTMLElement>('.tab')).find(Boolean);
      const was = over;
      over = cell?.at ?? (bin ? 'bin' : tab ? `tab:${tab.dataset['section']}` : '');
      // Onto another cell or tab, unless they are the ones moving: a drag, a glide, the thumbstick.
      const still = mode !== 'scroll' && mode !== 'tabscroll' && glide === null && now() - wheelAt > WHEEL_QUIET_MS;
      return due || (still && over !== '' && over !== was);
    },
    setBounds: ({ top, left, width: w, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${height}px` });
      const gridHeight = Math.max(0, height - BAR_PX - 6);
      const nextRows = Math.max(2, Math.floor(gridHeight / 40));
      const nextSize = Math.floor(gridHeight / nextRows) || 40;
      if (built && nextRows === rows && nextSize === cellSize) return; // the periodic check: nothing changed
      onCancel();
      rows = nextRows;
      cellSize = nextSize;
      built = true;
      build();
    },
    setSteam: (steam, loading) => {
      input = { ...input, steam, steamLoading: loading };
      if (mode === 'idle') build();
      else stale = true;
    },
    destroy: () => {
      clearHold();
      stopGlide();
      stopFollowing();
      for (const type of ['touchend', 'pointerup', 'mouseup'] as const) win?.removeEventListener(type, endOutside, listen);
      win?.removeEventListener('touchcancel', onCancel, listen);
      style.remove();
      root.remove();
    },
  };
};
