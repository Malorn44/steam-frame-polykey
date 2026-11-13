import { describe, expect, it } from 'vitest';
import { nameFor } from '../../src/core/names.js';

describe('nameFor', () => {
  it('a plain string is every language\'s name', () => {
    expect(nameFor('QWERTY', 'ja')).toBe('QWERTY');
    expect(nameFor('QWERTY')).toBe('QWERTY');
  });

  it('picks the language\'s name', () => {
    const name = { en: 'Smiling', ja: '笑顔', 'pt-BR': 'Sorrindo', pt: 'A sorrir' };
    expect(nameFor(name, 'ja')).toBe('笑顔');
    expect(nameFor(name, 'en')).toBe('Smiling');
    expect(nameFor(name, 'pt-BR')).toBe('Sorrindo');
  });

  it('falls back to the base language, then English, then the first name', () => {
    expect(nameFor({ en: 'Smiling', pt: 'A sorrir' }, 'pt-BR')).toBe('A sorrir');
    expect(nameFor({ zh: '微笑', en: 'Smiling' }, 'zh-Hant-TW')).toBe('微笑');
    expect(nameFor({ ja: '笑顔', en: 'Smiling' }, 'fr')).toBe('Smiling');
    expect(nameFor({ ja: '笑顔', en: 'Smiling' })).toBe('Smiling');
    expect(nameFor({ ja: '笑顔', de: 'Lächeln' }, 'fr')).toBe('笑顔');
    expect(nameFor({ ja: '笑顔' }, 'en-GB')).toBe('笑顔');
  });

  it('a language is never an inherited property', () => {
    expect(nameFor({ en: 'Smiling' }, 'constructor')).toBe('Smiling');
    expect(nameFor({}, 'en')).toBe('');
  });
});
