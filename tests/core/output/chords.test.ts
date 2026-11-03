import { describe, expect, it } from 'vitest';
import { HID_INSERT, HID_V, MODIFIER, PASTE_CHORDS, PASTE_CHORD_NAMES } from '../../../src/core/output/chords.js';

describe('PASTE_CHORDS', () => {
  it('Shift+Insert presses Shift first and releases it last', () => {
    expect(PASTE_CHORDS['shift-insert']).toEqual([
      [MODIFIER.shift, true], [HID_INSERT, true], [HID_INSERT, false], [MODIFIER.shift, false],
    ]);
  });

  it('Ctrl+Shift+V releases modifiers in reverse order', () => {
    expect(PASTE_CHORDS['ctrl-shift-v']).toEqual([
      [MODIFIER.ctrl, true], [MODIFIER.shift, true], [HID_V, true], [HID_V, false], [MODIFIER.shift, false], [MODIFIER.ctrl, false],
    ]);
  });

  it('every chord releases every key it presses', () => {
    for (const name of PASTE_CHORD_NAMES) {
      const chord = PASTE_CHORDS[name];
      const downs = chord.filter(([, d]) => d).map(([c]) => c).sort();
      const ups = chord.filter(([, d]) => !d).map(([c]) => c).sort();
      expect(ups).toEqual(downs);
    }
  });
});
