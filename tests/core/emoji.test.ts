import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACE_MIN_PX, FACE_PX, MAX_FAVORITES, fitFace, steamFromKey, steamKey, placeFavorite, removeFavorite, steamItemEffects, nextSet, readState, recentColumns, setFor, toneTable, useRecent, withTone, type PickerSet } from '../../src/core/emoji.js';

const wave = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
const set = (items: PickerSet['categories'][0]['items'], more: Partial<PickerSet> = {}): PickerSet =>
  ({ id: 'emoji/emoji', name: 'Emoji', key: { icon: 'emoji' }, cells: 'emoji', tones: true, categories: [{ id: 'people', name: 'People', items }], ...more });
const tones = toneTable([set([wave, '🙂'])]);

describe('skin tones', () => {
  it('apply to emoji that take them, and leave others alone', () => {
    expect(withTone('👋', 'dark', tones)).toBe('👋🏿');
    expect(withTone('👋', '', tones)).toBe('👋');
    expect(withTone('🙂', 'dark', tones)).toBe('🙂');
  });
});

describe('sets', () => {
  const sets = ['emoji/emoji', 'emoji/kaomoji', 'mine/arrows'].map((id) => set(['a'], { id }));

  it('skin tones come only from the sets that offer them', () => {
    expect(toneTable([set([wave], { tones: false }), set([wave], { id: 'mine/b' })]).get('👋')).toEqual(wave);
    expect(toneTable([set([wave], { tones: false })]).size).toBe(0);
  });

  it('the set shown is the saved one, or the first when it is gone', () => {
    expect(setFor(sets, 'emoji/kaomoji')?.id).toBe('emoji/kaomoji');
    expect(setFor(sets, 'mine/gone')?.id).toBe('emoji/emoji');
    expect(setFor(sets, '')?.id).toBe('emoji/emoji');
    expect(setFor([], 'emoji/emoji')).toBeUndefined();
  });

  it('the next set follows in pack order, round to the first; from a set that is gone it is the second', () => {
    expect(['emoji/emoji', 'emoji/kaomoji', 'mine/arrows', 'mine/gone', ''].map((id) => nextSet(sets, id)?.id))
      .toEqual(['emoji/kaomoji', 'mine/arrows', 'emoji/emoji', 'emoji/kaomoji', 'emoji/kaomoji']);
    expect(nextSet(sets.slice(0, 1), 'emoji/emoji')?.id).toBe('emoji/emoji');
    expect(nextSet([], '')).toBeUndefined();
  });

  it('Recent is as wide as six emoji cells, in whole columns', () => {
    expect([1, 2, 2.5, 3, 4].map(recentColumns)).toEqual([6, 3, 2, 2, 2]);
  });
});

describe('the saved state', () => {
  it('is Recent per set, the favorites, the tone and the set last shown', () => {
    const state = { recent: { 'emoji/emoji': ['😀'], 'mine/arrows': ['→'] }, favorites: ['⭐'], tone: 'dark', set: 'mine/arrows' };
    expect(readState(state)).toEqual(state);
    expect(readState(undefined)).toEqual({ recent: {}, favorites: [], tone: '', set: '' });
    expect(readState({})).toEqual({ recent: {}, favorites: [], tone: '', set: '' });
  });

  it('from before sets were packs: recent is the emoji set\'s, kaomojiRecent the kaomoji set\'s, mode the set', () => {
    expect(readState({ recent: ['😀'], favorites: ['⭐'], tone: 'dark', kaomojiRecent: [':-)'], mode: 'kaomoji' }))
      .toEqual({ recent: { 'emoji/emoji': ['😀'], 'emoji/kaomoji': [':-)'] }, favorites: ['⭐'], tone: 'dark', set: 'emoji/kaomoji' });
    expect(readState({ recent: [], favorites: [], tone: '', kaomojiRecent: [], mode: 'emoji' }).set).toBe('emoji/emoji');
    // From before kaomoji: only the one Recent.
    expect(readState({ recent: ['😀'], favorites: [], tone: '' }))
      .toEqual({ recent: { 'emoji/emoji': ['😀'], 'emoji/kaomoji': [] }, favorites: [], tone: '', set: '' });
  });
});

describe('Recent', () => {
  it('a new emoji goes to the front; one picked from Recent keeps its place', () => {
    expect(useRecent(['😀', '🎉'], '👍', false, 24)).toEqual(['👍', '😀', '🎉']);
    expect(useRecent(['😀', '🎉', '👍'], '👍', false, 24)).toEqual(['👍', '😀', '🎉']);
    expect(useRecent(['😀', '🎉', '👍'], '👍', true, 24)).toEqual(['😀', '🎉', '👍']);
    expect(useRecent(['a', 'b', 'c'], 'd', false, 3)).toEqual(['d', 'a', 'b']);
  });
});

describe('Favorites', () => {
  it('drop places at the slot, moves an existing one, and a full list takes no new ones', () => {
    expect(placeFavorite(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']);
    expect(placeFavorite(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
    expect(placeFavorite(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    const full = Array.from({ length: MAX_FAVORITES }, (_, i) => String(i));
    expect(placeFavorite(full, 'new', 0)).toEqual(full);
    expect(removeFavorite(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('Steam items', () => {
  it('round-trip through the key kept in Recent and Favorites; emoji are not keys', () => {
    const item = { kind: 'sticker' as const, name: 'Intense Gaming' };
    expect(steamKey(item)).toBe('steam:sticker:Intense Gaming');
    expect(steamFromKey(steamKey(item))).toEqual(item);
    expect(steamFromKey('😀')).toBeNull();
    expect(steamFromKey('steam:hat:x')).toBeNull();
  });

  it('type like Steam\'s keyboard: emoticons as text, stickers and effects as chat commands', () => {
    expect(steamItemEffects({ kind: 'emoticon', name: 'steamhappy' })).toEqual([{ kind: 'text', text: ':steamhappy:' }]);
    expect(steamItemEffects({ kind: 'sticker', name: 'Intense Gaming' })).toEqual([
      { kind: 'text', text: '/sticker Intense Gaming' }, { kind: 'key', key: 'Enter' }]);
    expect(steamItemEffects({ kind: 'effect', name: 'confetti' })[0]).toEqual({ kind: 'text', text: '/roomeffect confetti' });
  });
});

describe('the bundled data', () => {
  const bundled = JSON.parse(readFileSync('packs/emoji/emoji.data', 'utf8')) as { version: string; groups: PickerSet['categories'] };
  const group = (id: string) => bundled.groups.find((g) => g.id === id)!.items;

  it('is Emoji 15.1: its fully-qualified emoji (3,773) less the 260 with mixed skin tones', () => {
    expect(bundled.version).toBe('15.1');
    expect(bundled.groups.flatMap((g) => g.items).flat()).toHaveLength(3773 - 260);
  });

  it('has the 15.1 additions in their groups; a person facing right takes tones under its own base', () => {
    expect(group('animals')).toContain('🐦‍🔥'); // phoenix
    expect(group('food')).toContain('🍋‍🟩'); // lime
    // Person walking facing right: the skin tone goes before the ZWJ and ➡️. Person walking keeps its own.
    expect(group('people')).toContainEqual(['🚶‍➡️', '🚶🏻‍➡️', '🚶🏼‍➡️', '🚶🏽‍➡️', '🚶🏾‍➡️', '🚶🏿‍➡️']);
    expect(group('people')).toContainEqual(['🚶', '🚶🏻', '🚶🏼', '🚶🏽', '🚶🏾', '🚶🏿']);
    const tones = toneTable([{ id: 'emoji/emoji', name: 'Emoji', key: { icon: 'emoji' }, cells: 'emoji', tones: true, categories: bundled.groups }]);
    expect(withTone('🚶‍➡️', 'dark', tones)).toBe('🚶🏿‍➡️');
    expect(withTone('🚶', 'dark', tones)).toBe('🚶🏿');
  });
});

describe('fitting a face to its cell', () => {
  it('a face that fits is drawn as it is', () => {
    expect(fitFace(60, 90)).toEqual({ font: FACE_PX, scaleX: 1 });
    expect(fitFace(90, 90)).toEqual({ font: FACE_PX, scaleX: 1 });
    expect(fitFace(0, 90)).toEqual({ font: FACE_PX, scaleX: 1 }); // not measured (yet)
  });

  it('a wider one shrinks until it just fits', () => {
    const fit = fitFace(100, 90);
    expect(fit.scaleX).toBe(1);
    expect(fit.font).toBeCloseTo(13.5);
    expect(100 * fit.font / FACE_PX).toBeCloseTo(90);
  });

  it('shrinks no further than the smallest size, then is squeezed to fit', () => {
    const edge = 90 * FACE_PX / FACE_MIN_PX; // exactly fits at the smallest size
    expect(fitFace(edge, 90).scaleX).toBe(1);
    expect(fitFace(edge, 90).font).toBeCloseTo(FACE_MIN_PX);
    const fit = fitFace(180, 90);
    expect(fit.font).toBe(FACE_MIN_PX);
    expect(fit.scaleX).toBeCloseTo(90 / (180 * FACE_MIN_PX / FACE_PX));
    expect(180 * (fit.font / FACE_PX) * fit.scaleX).toBeCloseTo(90);
  });

  it('a cell with no room leaves the face alone', () => {
    expect(fitFace(50, 0)).toEqual({ font: FACE_PX, scaleX: 1 });
  });
});
