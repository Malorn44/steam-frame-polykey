import { describe, expect, it } from 'vitest';
import { themeVars } from '../../src/ui/theme.js';

describe('themeVars', () => {
  it('maps a theme to the full set of CSS variables, filling what it leaves out', () => {
    const vars = themeVars({ id: 't/x', name: 'X', colors: { surface: '#000001', key: '#000002', keyText: '#000003', modifier: '#000004', accent: '#000005' } });
    expect(vars).toContain('--surface:#000001;--key:#000002;--text:#000003;--mod:#000004;--accent:#000005;'
      + '--legend:#000003;--fn:#000005;--hover:#000004;');
    expect(vars).toContain('--accent-text:#000001;--fn-text:#000001;--divider:#000004;--ring:#000005;--indicator:#000005;');
    expect(vars).toContain('--pressed:brightness(1.5);--raised:rgba(255, 255, 255, 0.1);');
    expect(vars).toContain('--radius:6px;--radius-sm:3px;--radius-pill:13px;');
  });

  it('a light theme shifts its states darker', () => {
    const vars = themeVars({ id: 't/l', name: 'L', tone: 'light', colors: { surface: '#ffffff', key: '#eeeeee', keyText: '#000000', modifier: '#dddddd', accent: '#0066cc' } });
    expect(vars).toContain('--pressed:brightness(0.85);--raised:rgba(0, 0, 0, 0.06);');
  });
});
