// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_EMOJI_STATE, toneTable, type EmojiData, type EmojiState } from '../../src/core/emoji.js';
import { EMOJI_HOLD_MS, RELEASE_LOST_MS } from '../../src/core/interaction.js';
import { createEmojiView } from '../../src/ui/emoji.js';
import { bundledBoot } from '../boot.js';

const data: EmojiData = { groups: [
  { id: 'smileys', name: 'Smileys & Emotion', items: ['😀', '😃', '😄'] },
  { id: 'people', name: 'People & Body', items: [['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'], '🙂'] },
] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (state: EmojiState = NO_EMOJI_STATE) => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const calls = { emoji: [] as [string, boolean][], tone: [] as string[], steam: [] as string[], favorites: [] as string[][], clear: 0 };
  const view = createEmojiView(document, shadow, bundledBoot().catalog.themes['themes/steam']!, {
    data, tones: toneTable(data), steam: [{ item: { kind: 'emoticon', name: 'steamhappy' }, image: 'https://cdn/e/steamhappy' }],
  }, state, {
    onEmoji: (b, r) => calls.emoji.push([b, r]),
    onTone: (t) => calls.tone.push(t),
    onSteam: (i) => calls.steam.push(i.name),
    onFavorites: (f) => calls.favorites.push(f),
    onClearRecent: () => calls.clear++,
  });
  view.setBounds({ top: 0, left: 0, width: 854, height: 195 });
  const cell = (text: string) => [...shadow.querySelectorAll<HTMLElement>('.strip .cell')].find((c) => c.textContent === text)!;
  return { view, shadow, calls, cell };
};
const touch = (el: Element, type: string, x = 0, y = 0) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
};

describe('emoji picker', () => {
  it('shows tabs for Recent, Favorites, each group and the Steam items, which sit apart', () => {
    const { shadow } = setup();
    const tabs = [...shadow.querySelectorAll<HTMLElement>('.tab')].map((t) => t.dataset['section']);
    expect(tabs).toEqual(['recent', 'favorites', 'smileys', 'people', 'steam-emoticon', 'steam-sticker', 'steam-effect']);
    const notes = [...shadow.querySelectorAll('.note')].map((n) => n.textContent);
    expect(notes).toContain('No Steam stickers yet');
    expect(notes).toContain('No room effects yet');
    expect(shadow.querySelector('.label')!.textContent).toBe('Steam');
    expect(shadow.querySelector('.cell img')!.getAttribute('src')).toBe('https://cdn/e/steamhappy');
    expect(shadow.querySelector('.note')!.textContent).toContain('Recently used');
  });

  it('a tap types; a Steam item is its own kind', () => {
    const { cell, calls, shadow } = setup();
    touch(cell('😃'), 'touchstart');
    touch(cell('😃'), 'touchend');
    expect(calls.emoji).toEqual([['😃', false]]);
    const steam = shadow.querySelector('.cell img')!.parentElement!;
    touch(steam, 'touchstart');
    touch(steam, 'touchend');
    expect(calls.steam).toEqual(['steamhappy']);
  });

  it('dragging past the slop scrolls instead of typing', () => {
    const { cell, calls, shadow } = setup();
    touch(cell('😀'), 'touchstart', 100, 50);
    touch(cell('😀'), 'touchmove', 60, 50);
    touch(cell('😀'), 'touchend', 60, 50);
    expect(calls.emoji).toEqual([]);
    expect(shadow.querySelector<HTMLElement>('.strip')!.style.transform).toMatch(/translateX/);
  });

  it('holding a toned emoji offers its six tones; release picks one', () => {
    const { cell, calls, shadow } = setup();
    touch(cell('👋'), 'touchstart');
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect([...shadow.querySelectorAll('.alts .key')].map((c) => c.textContent)).toHaveLength(6);
    touch(cell('👋'), 'touchend');
    expect(calls.tone).toEqual(['']);
    expect(calls.emoji).toEqual([]);
  });

  it('shows the tone everywhere it applies', () => {
    const { cell } = setup({ ...NO_EMOJI_STATE, tone: 'dark', recent: ['👋'] });
    expect(cell('👋🏿')).toBeDefined();
  });

  it('a held Recent emoji lifts; dropping off Favorites does nothing, picking from Recent keeps its place', () => {
    const { cell, calls, shadow } = setup({ ...NO_EMOJI_STATE, recent: ['😄'] });
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart', 10, 40);
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    touch(recentCell, 'touchend', 10, 40);
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(calls.favorites).toEqual([]); // no layout in jsdom: not over Favorites
    touch(recentCell, 'touchstart');
    touch(recentCell, 'touchend');
    expect(calls.emoji).toEqual([['😄', true]]);
    expect(cell('😄')).toBeDefined();
  });

  it('a new press clears a tone popup or lifted emoji left over from a missed release', () => {
    const { cell, shadow } = setup({ ...NO_EMOJI_STATE, recent: ['😄'] });
    touch(cell('👋'), 'touchstart');
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect(shadow.querySelector('.alts')).not.toBeNull();
    touch(cell('😀'), 'touchstart'); // no touchend came for the first press
    expect(shadow.querySelector('.alts')).toBeNull();
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart');
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    touch(cell('😀'), 'touchstart');
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(shadow.querySelector('.lifted')).toBeNull();
  });

  it('dragging over Favorites opens a gap, the others slide aside, and the drop lands there', () => {
    const { calls, shadow, cell } = setup({ ...NO_EMOJI_STATE, recent: ['😄'], favorites: ['⭐', '🎉'] });
    const grid = shadow.querySelector<HTMLElement>('.grid')!;
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 854, height: 163, right: 854, bottom: 163, x: 0, y: 0, toJSON: () => ({}) });
    // 4 rows of 40 px: Recent is 6 columns (0–240), a 20 px gap, then Favorites from x = 260.
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart', 10, 10);
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    touch(recentCell, 'touchmove', 270, 50); // over 🎉, the second favorite
    expect(cell('🎉').style.top).toBe('80px'); // pushed to the third place
    expect(cell('⭐').style.top).toBe('0px');
    const ph = shadow.querySelector<HTMLElement>('.placeholder')!;
    expect([ph.style.left, ph.style.top]).toEqual(['260px', '40px']); // the empty place, in the hover colour
    touch(recentCell, 'touchend', 270, 50);
    expect(calls.favorites).toEqual([['⭐', '😄', '🎉']]);
  });

  it('a release outside the picker (a fast drag into the key row) still ends the drag', () => {
    const { shadow } = setup({ ...NO_EMOJI_STATE, recent: ['😄'] });
    const outside = document.createElement('div');
    shadow.append(outside);
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart');
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    touch(outside, 'touchend');
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(shadow.querySelector('.lifted')).toBeNull();
  });

  it('the laser moving onto the tones right after the hold does not end the pick', () => {
    const { cell, calls, view } = setup();
    touch(cell('👋'), 'touchstart', 10, 10);
    vi.advanceTimersByTime(EMOJI_HOLD_MS); // held still: no touch moves for half a second
    view.hoverAt(200, 10); // the laser heads for a tone before its touch move arrives
    expect(calls.tone).toEqual([]);
  });

  it('the periodic resize check leaves the grid (and a held emoji) alone when nothing changed', () => {
    const { cell, view, shadow } = setup();
    const held = cell('👋');
    touch(held, 'touchstart');
    view.setBounds({ top: 0, left: 0, width: 854, height: 195 });
    expect(held.isConnected).toBe(true);
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    expect(shadow.querySelector('.alts')).not.toBeNull();
  });

  it('Steam items appear in Recent and Favorites with their picture, and send as Steam items', () => {
    const { calls, shadow } = setup({ ...NO_EMOJI_STATE, recent: ['steam:emoticon:steamhappy'], favorites: ['steam:sticker:Gone'] });
    const [recent, fav] = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')];
    expect(recent!.querySelector('img')!.getAttribute('src')).toBe('https://cdn/e/steamhappy');
    expect(fav!.textContent).toBe('Gone'); // no longer owned: its name stands in
    touch(recent!, 'touchstart');
    touch(recent!, 'touchend');
    expect(calls.steam).toEqual(['steamhappy']);
  });

  it('a lost release (the laser moves on with no touch moves) drops the lifted emoji', () => {
    const { shadow, view } = setup({ ...NO_EMOJI_STATE, recent: ['😄'] });
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart', 10, 10); // a quick press whose release never arrives
    vi.advanceTimersByTime(EMOJI_HOLD_MS); // the hold still lifts it
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    vi.advanceTimersByTime(RELEASE_LOST_MS + 1);
    view.hoverAt(10, 12); // laser barely moved: may still be held
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    view.hoverAt(300, 100);
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(shadow.querySelector('.lifted')).toBeNull();
  });

  it('the bin sits in Recent\'s last place, empties it, and shows only when there is something to clear', () => {
    expect(setup().shadow.querySelector('.trash')).toBeNull();
    const { calls, shadow } = setup({ ...NO_EMOJI_STATE, recent: ['😄'] });
    const bin = shadow.querySelector<HTMLElement>('.strip .trash')!;
    expect([bin.style.left, bin.style.top]).toEqual(['200px', '120px']);
    touch(bin, 'touchstart');
    expect(calls.clear).toBe(1);
  });

  it('shows how to use Recent and Favorites while they are empty', () => {
    const notes = [...setup().shadow.querySelectorAll('.note')].map((n) => n.textContent);
    expect(notes).toContain('Recently used emoji appear here.');
    expect(notes).toContain('Drag and drop from Recent to add a favorite, drop outside to remove.');
  });

  it('a held favorite dropped outside Favorites is removed', () => {
    const { calls, shadow } = setup({ ...NO_EMOJI_STATE, favorites: ['⭐', '🎉'] });
    const fav = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')].find((c) => c.textContent === '⭐')!;
    touch(fav, 'touchstart');
    vi.advanceTimersByTime(EMOJI_HOLD_MS);
    touch(fav, 'touchend');
    expect(calls.favorites).toEqual([['🎉']]);
  });
});
