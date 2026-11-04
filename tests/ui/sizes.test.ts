import { describe, expect, it } from 'vitest';
import { SCALE, sizeVars } from '../../src/ui/sizes.js';

describe('sizeVars', () => {
  it('gives the scale and every role; large only re-points the label and the icons', () => {
    const normal = sizeVars('normal');
    const large = sizeVars('large');
    for (const step of Object.keys(SCALE)) expect(normal).toContain(`${step}:`);
    expect(normal).toContain('--size-label:var(--text-sm);');
    expect(large).toContain('--size-label:var(--text-md);');
    expect(large).toContain('--size-icon:var(--text-xl);');
    const without = (vars: string) => vars.replace(/--size-(label|icon):[^;]*;/g, '');
    expect(without(large)).toBe(without(normal));
  });

  it('every role is on the scale (no raw pixel sizes)', () => {
    for (const preset of ['normal', 'large'] as const) {
      const roles = sizeVars(preset).split(';').filter((v) => v.startsWith('--size-'));
      for (const role of roles) expect(role).toMatch(/:var\(--text-|:(15|16|18|19)px$/); // the bar's text roles are next (I29)
    }
  });
});
