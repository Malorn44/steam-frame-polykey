import { describe, expect, it } from 'vitest';
import { themeVars } from '../../src/ui/theme.js';

describe('themeVars', () => {
  it('maps a theme to the full set of CSS variables, filling what it leaves out', () => {
    const vars = themeVars({ id: 't/x', name: 'X', colors: { surface: '#000001', key: '#000002', keyText: '#000003', modifier: '#000004', accent: '#000005' } });
    expect(vars).toBe('--surface:#000001;--key:#000002;--text:#000003;--mod:#000004;--accent:#000005;'
      + '--legend:#000003;--fn:#000005;--hover:#000004;--radius:6px;--font:system-ui, sans-serif;');
  });
});
