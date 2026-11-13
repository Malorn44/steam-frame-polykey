// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_EMOJI_STATE, toneTable, type EmojiData, type EmojiState } from '../../src/core/emoji.js';
import { HOLD_MS, RELEASE_LOST_MS } from '../../src/core/interaction.js';
import { KAOMOJI_RECENT_NOTE, STEAM_LOADING_NOTE, createEmojiView, type EmojiPickerInput } from '../../src/ui/emoji.js';
import { bundledBoot } from '../boot.js';

const data: EmojiData = { groups: [
  { id: 'smileys', name: 'Smileys & Emotion', items: ['😀', '😃', '😄'] },
  { id: 'people', name: 'People & Body', items: [['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'], '🙂'] },
] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const steamhappy: EmojiPickerInput['steam'] = [{ item: { kind: 'emoticon', name: 'steamhappy' }, image: 'https://cdn/e/steamhappy' }];
const setup = (state: EmojiState = NO_EMOJI_STATE, steam: Partial<EmojiPickerInput> = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const calls = { emoji: [] as [string, boolean][], tone: [] as string[], steam: [] as string[], favorites: [] as string[][], clear: 0, kaomoji: [] as [string, boolean, number][] };
  const view = createEmojiView(document, shadow, bundledBoot().catalog.themes['themes/steam']!, {
    data, tones: toneTable(data), steam: steamhappy, ...steam,
  }, state, {
    onEmoji: (b, r) => calls.emoji.push([b, r]),
    onTone: (t) => calls.tone.push(t),
    onSteam: (i) => calls.steam.push(i.name),
    onFavorites: (f) => calls.favorites.push(f),
    onClearRecent: () => calls.clear++,
    onKaomoji: (f, r, room) => calls.kaomoji.push([f, r, room]),
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
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS);
    expect(shadow.querySelector('.alts')).not.toBeNull();
    touch(cell('😀'), 'touchstart'); // no touchend came for the first press
    expect(shadow.querySelector('.alts')).toBeNull();
    const recentCell = [...shadow.querySelectorAll<HTMLElement>('.strip .cell')][0]!;
    touch(recentCell, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS);
    expect(shadow.querySelector('.ghost')).not.toBeNull();
    touch(outside, 'touchend');
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(shadow.querySelector('.lifted')).toBeNull();
  });

  it('the laser moving onto the tones right after the hold does not end the pick', () => {
    const { cell, calls, view } = setup();
    touch(cell('👋'), 'touchstart', 10, 10);
    vi.advanceTimersByTime(HOLD_MS); // held still: no touch moves for the whole hold
    view.hoverAt(200, 10); // the laser heads for a tone before its touch move arrives
    expect(calls.tone).toEqual([]);
  });

  it('the periodic resize check leaves the grid (and a held emoji) alone when nothing changed', () => {
    const { cell, view, shadow } = setup();
    const held = cell('👋');
    touch(held, 'touchstart');
    view.setBounds({ top: 0, left: 0, width: 854, height: 195 });
    expect(held.isConnected).toBe(true);
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS); // the hold still lifts it
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
    vi.advanceTimersByTime(HOLD_MS);
    touch(fav, 'touchend');
    expect(calls.favorites).toEqual([['🎉']]);
  });

  it('Steam items still loading say so, then arrive in place, the scroll kept', () => {
    const { shadow, view } = setup({ ...NO_EMOJI_STATE, recent: ['steam:emoticon:steamhappy'] }, { steam: [], steamLoading: true });
    const notes = () => [...shadow.querySelectorAll('.note')].map((n) => n.textContent);
    expect(notes().filter((n) => n === STEAM_LOADING_NOTE)).toHaveLength(3); // emoticons, stickers, effects
    shadow.querySelector('.emoji')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
    const strip = shadow.querySelector<HTMLElement>('.strip')!;
    const scrolled = strip.style.transform;
    view.setSteam(steamhappy, false);
    expect(notes()).not.toContain(STEAM_LOADING_NOTE);
    expect(notes()).toContain('No Steam stickers yet');
    expect([...shadow.querySelectorAll('.cell img')].map((i) => i.getAttribute('src'))).toEqual(['https://cdn/e/steamhappy', 'https://cdn/e/steamhappy']); // Recent's too
    expect(strip.style.transform).toBe(scrolled);
  });

  it('Steam items arriving during a press wait for it to end, so a hold still offers skin tones', () => {
    const { cell, calls, shadow, view } = setup(NO_EMOJI_STATE, { steam: [], steamLoading: true });
    const wave = cell('👋');
    touch(wave, 'touchstart');
    view.setSteam(steamhappy, false);
    expect(shadow.querySelector('.cell img')).toBeNull();
    vi.advanceTimersByTime(HOLD_MS);
    expect(shadow.querySelectorAll('.alts .key')).toHaveLength(6);
    touch(wave, 'touchend');
    expect(calls.tone).toEqual(['']);
    expect(shadow.querySelector('.cell img')).not.toBeNull();
  });
});

describe('the tab strip', () => {
  /** Seven tabs of 100 px in a 250 px bar, over a 300 px grid (jsdom lays nothing out). */
  const laidOut = () => {
    const is = (el: Element, name: string) => el.classList.contains(name);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return is(this, 'tab') ? 100 : is(this, 'tabstrip') ? this.children.length * 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return is(this, 'tab') ? [...this.parentElement!.children].indexOf(this) * 100 : 0;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return is(this, 'tabs') ? 250 : is(this, 'grid') ? 300 : 0;
    });
    const made = setup();
    const { shadow } = made;
    const tabs = shadow.querySelector<HTMLElement>('.tabstrip')!;
    const grid = shadow.querySelector<HTMLElement>('.strip')!;
    const tab = (id: string) => shadow.querySelector<HTMLElement>(`.tab[data-section="${id}"]`)!;
    const on = () => shadow.querySelector<HTMLElement>('.tab.on')!.dataset['section'];
    const wheel = (el: Element, by: number) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: by, bubbles: true, cancelable: true }));
    return { ...made, tabs, grid, tab, on, wheel };
  };
  afterEach(() => vi.restoreAllMocks());

  it('a drag scrolls the tabs, as far as they go, and is not a tap on a tab', () => {
    const { tabs, grid, tab, on } = laidOut();
    touch(tab('people'), 'touchstart', 220, 10);
    touch(tab('people'), 'touchmove', 210, 10); // within the slop: nothing moves yet
    expect(tabs.style.transform).toBe('translateX(0px)');
    touch(tab('people'), 'touchmove', 120, 10);
    expect(tabs.style.transform).toBe('translateX(-100px)');
    touch(tab('people'), 'touchmove', -900, 10);
    expect(tabs.style.transform).toBe('translateX(-450px)'); // 700 px of tabs in 250
    touch(tab('people'), 'touchmove', 900, 10);
    expect(tabs.style.transform).toBe('translateX(0px)');
    touch(tab('people'), 'touchend', 900, 10);
    expect(grid.style.transform).toBe('translateX(0px)'); // the grid did not jump to People
    expect(on()).toBe('recent');
  });

  it('a quick drag glides on, slowing to a stop', () => {
    const { tabs, tab } = laidOut();
    const offset = () => -parseFloat(/-?[\d.]+/.exec(tabs.style.transform)![0]);
    touch(tab('people'), 'touchstart', 240, 10);
    vi.advanceTimersByTime(20);
    touch(tab('people'), 'touchmove', 200, 10);
    vi.advanceTimersByTime(20);
    touch(tab('people'), 'touchmove', 160, 10);
    touch(tab('people'), 'touchend', 160, 10);
    expect(offset()).toBe(80);
    vi.advanceTimersByTime(100);
    const soon = offset();
    expect(soon).toBeGreaterThan(80);
    vi.advanceTimersByTime(5000);
    expect(offset()).toBeGreaterThan(soon);
    const rest = offset();
    vi.advanceTimersByTime(1000);
    expect(offset()).toBe(rest);
  });

  it('the wheel over the tabs scrolls them, not the grid', () => {
    const { shadow, tabs, grid, tab, wheel } = laidOut();
    wheel(tab('favorites'), 120);
    expect(tabs.style.transform).toBe('translateX(-120px)');
    expect(grid.style.transform).toBe('translateX(0px)');
    wheel(shadow.querySelector('.tabs')!, 5000);
    expect(tabs.style.transform).toBe('translateX(-450px)');
    wheel(shadow.querySelector('.grid')!, 40);
    expect(grid.style.transform).toBe('translateX(-40px)');
  });

  it('keeps the current tab in view, with its neighbours, as the grid scrolls or a tab is tapped', () => {
    const { shadow, tabs, grid, tab, on, wheel } = laidOut();
    wheel(tab('favorites'), 100); // People (300 to 400) is now at the bar's right edge
    touch(tab('people'), 'touchstart', 240, 10);
    touch(tab('people'), 'touchend', 240, 10);
    expect(on()).toBe('people');
    expect(grid.style.transform).toBe('translateX(-460px)');
    expect(tabs.style.transform).toBe('translateX(-250px)'); // the tab after it has come into view
    wheel(shadow.querySelector('.grid')!, -5000); // back to Recent: its tab was out of view
    expect(on()).toBe('recent');
    expect(tabs.style.transform).toBe('translateX(0px)');
    wheel(shadow.querySelector('.grid')!, 5000); // the grid's end: the last tabs
    expect(on()).toBe('steam-sticker');
    expect(tabs.style.transform).toBe('translateX(-450px)');
  });
});

describe('kaomoji mode', () => {
  const categories = [
    { id: 'smiling', en: 'Smiling', ja: '笑顔', faces: ['(^_^)', '(≧▽≦)', '(◕‿◕)', '(*^▽^*)', '(＾▽＾)', '(´▽`)'] },
    { id: 'tableflip', en: 'Table flip', ja: 'ちゃぶ台返し', faces: ['(╯°□°)╯︵ ┻━┻', '┻━┻ ︵╰(°□°)╯︵ ┻━┻'] },
  ];
  const kaomoji = (state: Partial<EmojiState> = {}, japanese = false) =>
    setup({ ...NO_EMOJI_STATE, mode: 'kaomoji', ...state }, { kaomoji: { categories, japanese } });
  /** As a browser would measure: 10 px a character at the face size. */
  const measured = () => {
    const read: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.parentElement?.classList.contains('face')) return 0;
      read.push(this.textContent ?? '');
      return [...this.textContent ?? ''].length * 10;
    });
    return read;
  };
  afterEach(() => vi.restoreAllMocks());

  it('shows Recent\'s icon tab and a text tab for each category, and wide cells filled down each column', () => {
    const { shadow, cell } = kaomoji();
    const tabs = [...shadow.querySelectorAll<HTMLElement>('.tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['', 'Smiling', 'Table flip']);
    expect(tabs.map((t) => [t.className, !!t.querySelector('svg')])).toEqual([['tab on', true], ['tab text', false], ['tab text', false]]);
    expect(tabs[0]!.innerHTML).toBe(setup().shadow.querySelector('.tab')!.innerHTML); // the emoji picker's Recent icon
    expect(tabs.map((t) => t.dataset['section'])).toEqual(['recent', 'smiling', 'tableflip']);
    expect(shadow.querySelector('.note')!.textContent).toBe(KAOMOJI_RECENT_NOTE);
    expect(shadow.querySelector('.trash')).toBeNull();
    expect([...shadow.querySelectorAll('.label')].map((l) => l.textContent)).toEqual(['Smiling', 'Table flip']);
    expect(shadow.querySelectorAll('.divider')).toHaveLength(2);
    // A 195 px picker has 4 rows of 40 px: cells are 100 × 40, Recent 2 columns, then half a cell's gap.
    expect(cell('(^_^)').style.cssText).toContain('left: 220px; top: 0px; width: 100px; height: 40px');
    expect(cell('(≧▽≦)').style.top).toBe('40px');
    expect(cell('(＾▽＾)').style.cssText).toContain('left: 320px; top: 0px');
    expect(cell('(╯°□°)╯︵ ┻━┻').style.left).toBe('440px');
  });

  it('names tabs and labels in Japanese on a Japanese keyboard, the labels upright', () => {
    const { shadow } = kaomoji({}, true);
    expect([...shadow.querySelectorAll('.tab')].map((t) => t.textContent)).toEqual(['', '笑顔', 'ちゃぶ台返し']);
    expect([...shadow.querySelectorAll('.label.upright')].map((l) => l.textContent)).toEqual(['笑顔', 'ちゃぶ台返し']);
  });

  it('a tap types the face and says how much Recent holds; from Recent it says so', () => {
    const { cell, calls, shadow } = kaomoji({ kaomojiRecent: ['(´▽`)'] });
    touch(cell('(≧▽≦)'), 'touchstart');
    touch(cell('(≧▽≦)'), 'touchend');
    const recent = shadow.querySelector<HTMLElement>('.strip .cell.face')!;
    touch(recent, 'touchstart');
    touch(recent, 'touchend');
    expect(calls.kaomoji).toEqual([['(≧▽≦)', false, 8], ['(´▽`)', true, 8]]);
    expect(calls.emoji).toEqual([]);
  });

  it('Recent shows what fits in its two columns, and follows the state', () => {
    const many = Array.from({ length: 12 }, (_, i) => `(${i})`);
    const { shadow, view } = kaomoji({ kaomojiRecent: many });
    const shown = () => [...shadow.querySelectorAll<HTMLElement>('.strip .cell.face')].map((c) => c.textContent);
    expect(shown().slice(0, 9)).toEqual([...many.slice(0, 8), '(^_^)']);
    view.update({ ...NO_EMOJI_STATE, mode: 'kaomoji', kaomojiRecent: [':-)'] });
    expect(shown().slice(0, 2)).toEqual([':-)', '(^_^)']);
  });

  it('holding a face opens nothing and lifts nothing: the release still types it', () => {
    const { calls, shadow } = kaomoji({ kaomojiRecent: ['(^_^)'] });
    const recent = shadow.querySelector<HTMLElement>('.strip .cell.face')!;
    touch(recent, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(shadow.querySelector('.ghost')).toBeNull();
    expect(shadow.querySelector('.alts')).toBeNull();
    touch(recent, 'touchend');
    expect(calls.kaomoji).toEqual([['(^_^)', true, 8]]);
    expect(calls.favorites).toEqual([]);
  });

  it('a face too wide for its cell shrinks, and the widest is squeezed as well', () => {
    const widths = measured();
    const { cell, view } = kaomoji();
    const text = (face: string) => cell(face).querySelector<HTMLElement>('span')!;
    expect(text('(^_^)').style.cssText).toBe(''); // 50 px in 90
    expect(text('(╯°□°)╯︵ ┻━┻').style.fontSize).toBe('11.25px'); // 120 px: 15 × 90 / 120
    expect(text('(╯°□°)╯︵ ┻━┻').style.transform).toBe('');
    expect(text('┻━┻ ︵╰(°□°)╯︵ ┻━┻').style.fontSize).toBe('11px'); // 170 px: 125 at 11 px, squeezed to 90
    expect(text('┻━┻ ︵╰(°□°)╯︵ ┻━┻').style.transform).toBe('scaleX(0.722)');
    // Widths are measured once: drawing again (a new Recent) reads only the faces not seen before.
    expect(widths).toHaveLength(8);
    view.update({ ...NO_EMOJI_STATE, mode: 'kaomoji', kaomojiRecent: ['(^_^)'] });
    expect(widths).toHaveLength(8);
    expect(text('(╯°□°)╯︵ ┻━┻').style.fontSize).toBe('11.25px');
  });

  it('a tab jumps to its section, showing its divider and label; scrolling marks the tab', () => {
    const { shadow } = kaomoji();
    const strip = shadow.querySelector<HTMLElement>('.strip')!;
    const tab = (id: string) => shadow.querySelector<HTMLElement>(`.tab[data-section="${id}"]`)!;
    Object.defineProperty(shadow.querySelector('.grid')!, 'clientWidth', { value: 300 });
    expect(tab('recent').classList.contains('on')).toBe(true);
    touch(tab('smiling'), 'touchstart');
    expect(strip.style.transform).toBe('translateX(0px)'); // a tab is tapped when it is released
    touch(tab('smiling'), 'touchend');
    expect(strip.style.transform).toBe('translateX(-200px)'); // 220, less the gap its label sits in
    expect(tab('smiling').classList.contains('on')).toBe(true);
    shadow.querySelector('.emoji')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));
    expect(tab('recent').classList.contains('on')).toBe(true);
    // The last section cannot reach the left edge: its tab is marked all the same, until the grid moves.
    touch(tab('tableflip'), 'touchstart');
    touch(tab('tableflip'), 'touchend');
    expect(strip.style.transform).toBe('translateX(-260px)'); // the strip is 560 wide, the grid 300
    expect(tab('tableflip').classList.contains('on')).toBe(true);
    shadow.querySelector('.emoji')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, cancelable: true }));
    expect(tab('smiling').classList.contains('on')).toBe(true);
  });

  it('switching mode draws the other picker from its start; without kaomoji data it stays on emoji', () => {
    const { shadow, view } = kaomoji();
    view.update({ ...NO_EMOJI_STATE, mode: 'emoji' });
    expect(shadow.querySelector('.cell.face')).toBeNull();
    expect([...shadow.querySelectorAll<HTMLElement>('.tab')].map((t) => t.dataset['section'])).toContain('favorites');
    const none = setup({ ...NO_EMOJI_STATE, mode: 'kaomoji' });
    expect(none.shadow.querySelector('.cell.face')).toBeNull();
    expect(none.shadow.querySelector('.note')!.textContent).toContain('Recently used emoji');
  });
});
