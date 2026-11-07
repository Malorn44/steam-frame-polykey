import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_FAVORITES, steamFromKey, steamKey, placeFavorite, removeFavorite, steamItemEffects, toneTable, useRecent, withTone, type EmojiData } from '../../src/core/emoji.js';

const wave = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
const tones = toneTable({ groups: [{ id: 'people', name: 'People', items: [wave, '🙂'] }] });

describe('skin tones', () => {
  it('apply to emoji that take them, and leave others alone', () => {
    expect(withTone('👋', 'dark', tones)).toBe('👋🏿');
    expect(withTone('👋', '', tones)).toBe('👋');
    expect(withTone('🙂', 'dark', tones)).toBe('🙂');
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
  const bundled = JSON.parse(readFileSync('packs/emoji/emoji.data', 'utf8')) as EmojiData & { version: string };
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
    const tones = toneTable(bundled);
    expect(withTone('🚶‍➡️', 'dark', tones)).toBe('🚶🏿‍➡️');
    expect(withTone('🚶', 'dark', tones)).toBe('🚶🏿');
  });
});
