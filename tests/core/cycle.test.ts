import { describe, expect, it } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { stepCycle, tapKey, type TapCycle } from '../../src/core/cycle.js';

const abc: KeyDef = { type: 'char', char: 'a', cycle: ['a', 'b', 'c'] };
const xyz: KeyDef = { type: 'char', char: 'x', flick: { left: 'y', down: 'z' } };

/** What each tap types, ~ marking one that replaces what the last tap typed; null: the key does not cycle. */
const taps = (...keys: KeyDef[]): (string | null)[] => {
  let open: TapCycle | null = null;
  return keys.map((key) => {
    const tap = tapKey(open, key);
    open = tap?.cycle ?? null;
    return tap && `${tap.again ? '~' : ''}${tap.char}`;
  });
};

describe('tap cycles', () => {
  it('each tap on the same key steps once, the first again after the last; a step back wraps too', () => {
    expect(taps(abc, abc, abc, abc)).toEqual(['a', '~b', '~c', '~a']);
    expect(stepCycle({ key: 'a', chars: ['a', 'b', 'c'], index: 0 }, -1).index).toBe(2);
  });

  it('a key cycles through its own cycle, else its char then its flicks', () => {
    expect(taps(xyz, xyz, xyz)).toEqual(['x', '~y', '~z']);
    expect(taps({ ...xyz, cycle: ['x', 'w'] }, { ...xyz, cycle: ['x', 'w'] })).toEqual(['x', '~w']);
  });

  it('another key ends the cycle and starts its own', () => {
    expect(taps(abc, abc, xyz, abc)).toEqual(['a', '~b', 'x', 'a']);
  });

  it('a key with one character never cycles, nor steps an open cycle of the same character', () => {
    expect(taps(abc, { type: 'char', char: 'a' }, abc)).toEqual(['a', null, 'a']);
    expect(tapKey(null, { type: 'key', key: 'Backspace' })).toBeNull();
  });
});
