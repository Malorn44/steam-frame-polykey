import { describe, expect, it } from 'vitest';
import type { ThemeColors } from '../../src/core/catalog.js';
import { themeVars } from '../../src/ui/theme.js';

/** docs/PACKS.md's example theme: the colours it leaves out fall back to ones that read. */
const MIDNIGHT: ThemeColors = { surface: '#101820', key: '#1c2833', keyText: '#e8eef2', modifier: '#26333f', accent: '#4fa3e0' };

describe('themeVars', () => {
  it('maps a theme to the full set of CSS variables, filling what it leaves out', () => {
    const vars = themeVars({ id: 't/x', name: 'X', colors: MIDNIGHT });
    expect(vars).toContain('--surface:#101820;--key:#1c2833;--text:#e8eef2;--mod:#26333f;--accent:#4fa3e0;'
      + '--legend:#e8eef2;--fn:#4fa3e0;--hover:#26333f;');
    expect(vars).toContain('--accent-text:#101820;--fn-text:#101820;--error:#4fa3e0;--divider:#26333f;--ring:#4fa3e0;--indicator:#4fa3e0;');
    expect(vars).toContain('--hover-text:#e8eef2;--text-down:#e8eef2;--hover-text-down:#e8eef2;--accent-text-down:#101820;--fn-text-down:#101820;');
    expect(vars).toContain('--pressed:brightness(1.5);--raised:rgba(255, 255, 255, 0.1);');
    expect(vars).toContain('--radius:6px;--radius-sm:3px;--radius-pill:13px;');
  });

  it('a light theme shifts its states darker', () => {
    const vars = themeVars({ id: 't/l', name: 'L', tone: 'light', colors: { surface: '#ffffff', key: '#eeeeee', keyText: '#000000', modifier: '#dddddd', accent: '#0066cc' } });
    expect(vars).toContain('--pressed:brightness(0.85);--raised:rgba(0, 0, 0, 0.06);');
  });

  it('text that would not read on a state gives way to another of the theme\'s text colours, else white or black', () => {
    // White on yellow, light text on a light hover: the surface reads on both.
    const light = themeVars({ id: 't/y', name: 'Y', colors: { ...MIDNIGHT, accent: '#ffd000', accentText: '#ffffff', hover: '#d0d8e0' } });
    expect(light).toContain('--accent-text:#101820;');
    expect(light).toContain('--hover-text:#101820;');
    // On a mid blue none of the theme's text reads: black reads better than white.
    expect(themeVars({ id: 't/z', name: 'Z', colors: { ...MIDNIGHT, accent: '#5e81ac' } })).toContain('--accent-text:#000000;');
  });

  it('pressed text keeps the rest colour while it reads on the shifted background', () => {
    // White reads on this hover (4.8:1); pressed, the dark tone lifts it to #93abf6, where only dark text does.
    const vars = themeVars({ id: 't/p', name: 'P', colors: { ...MIDNIGHT, hover: '#6272a4' } });
    expect(vars).toContain('--hover-text:#ffffff;');
    expect(vars).toContain('--hover-text-down:#101820;');
    expect(vars).toContain('--text-down:#e8eef2;'); // the keys' own text still reads pressed
  });
});
