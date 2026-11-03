import { describe, expect, it } from 'vitest';
import { SCALE, sizeVars } from '../../src/ui/sizes.js';

describe('sizeVars', () => {
  it('gives the scale and every role; large only re-points the label', () => {
    const normal = sizeVars('normal');
    const large = sizeVars('large');
    for (const step of Object.keys(SCALE)) expect(normal).toContain(`${step}:`);
    expect(normal).toContain('--size-label:var(--text-sm);');
    expect(large).toContain('--size-label:var(--text-md);');
    expect(large.replace('--size-label:var(--text-md);', '')).toBe(normal.replace('--size-label:var(--text-sm);', ''));
  });
});
