import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { MAX_READING, builtOnce } from '../../src/core/composers/composer.js';
import { COMPOSERS, composerOf } from '../../src/core/composers/index.js';

type Schema = { $defs: { keyboard: { properties: { composer: { enum: string[] } } } } };
const schema = JSON.parse(readFileSync('packs/pack.schema.json', 'utf8')) as Schema;
const keyboard = (composer?: string): KeyboardDef =>
  ({ id: 'x/y', name: 'Y', layout: 'x/l', ...(composer ? { composer } : {}) }) as KeyboardDef;

describe('the composer registry', () => {
  it('is the list the schema allows, in the same order', () => {
    expect(schema.$defs.keyboard.properties.composer.enum).toEqual(Object.keys(COMPOSERS));
  });

  it('gives a keyboard its composer; direct, none, or one this build lacks types at once', () => {
    expect(composerOf(keyboard('kana'))).toBe(COMPOSERS.kana);
    expect(composerOf(keyboard('romaji'))).toBe(COMPOSERS.romaji);
    expect(composerOf(keyboard('direct'))).toBeNull();
    expect(composerOf(keyboard())).toBeNull();
    expect(composerOf(keyboard('toString'))).toBeNull(); // not an own entry
    expect(composerOf(undefined)).toBeNull();
  });
});

describe('MAX_READING', () => {
  it('is the longest reading the sidecar converts', () => {
    const engine = readFileSync('sidecar/polykey/converters/engine.py', 'utf8');
    expect(engine.match(/^MAX_READING = (\d+)$/m)?.[1]).toBe(String(MAX_READING));
  });
});

describe('builtOnce', () => {
  it('builds once per pack object, and again for another', () => {
    let builds = 0;
    const sizeOf = builtOnce((list: readonly string[]) => { builds++; return list.length; });
    const one = ['a', 'b'];
    expect([sizeOf(one), sizeOf(one), sizeOf(['c'])]).toEqual([2, 2, 1]);
    expect(builds).toBe(2);
  });
});
