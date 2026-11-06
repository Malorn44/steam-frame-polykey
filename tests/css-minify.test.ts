// The build's CSS minification (scripts/css-minify.mjs): comments and whitespace only.
import { readFileSync, readdirSync } from 'node:fs';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { cssTemplates, minifyCss, minifyCssTemplates } from '../scripts/css-minify.mjs';

/** The CSS as esbuild's own CSS parser reads it (minified its way): the same for the same CSS. */
const parsed = async (css: string): Promise<string> =>
  (await transform(css.replace(/\$\{[\w.]+\}/g, '1'), { loader: 'css', minify: true, logLevel: 'silent' })).code;

describe('CSS minification', () => {
  it('takes out comments and whitespace, and keeps strings, ${…}, values and the space before a pseudo-class', () => {
    expect(minifyCss('.a > .b ,\n.c :hover { color: red ; /* why */ }\n')).toBe('.a>.b,.c :hover{color:red}');
    expect(minifyCss('.k[data-k="hide"]::before { content: \' a  b \'; }')).toBe(
      '.k[data-k="hide"]::before{content:\' a  b \'}',
    );
    expect(minifyCss('@media (x: y) and (z) { .a { margin: calc(1px + 2px) 0; } }')).toBe(
      '@media (x:y) and (z){.a{margin:calc(1px + 2px) 0}}',
    );
    expect(minifyCssTemplates('const A_CSS = `\n  .a { transition: opacity ${MS}ms ease; }\n`;')).toBe(
      'const A_CSS = `.a{transition:opacity ${MS}ms ease}`;',
    );
    expect(minifyCss('.a { --x: 1px; width: var(--x, 2px); }')).toBe('.a{--x: 1px;width:var(--x, 2px)}'); // values as written
    expect(() => minifyCss('a/* x */b')).toThrow();
    expect(() => minifyCssTemplates('const CSS = `a { b: ${x ? 1 : 2} }`;')).toThrow();
  });

  it('leaves every rule, selector and value in src/ as it is', async () => {
    // The check sees what matters: a descendant's space, a value's.
    expect(await parsed('.a :hover{color:red}')).not.toBe(await parsed('.a:hover{color:red}'));
    expect(await parsed('.a{margin:1px 2px}')).not.toBe(await parsed('.a{margin:1px2px}'));
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(`src/${file}`, 'utf8');
      const before = cssTemplates(source);
      const after = cssTemplates(minifyCssTemplates(source));
      expect(after).toHaveLength(before.length);
      for (const [i, css] of before.entries()) {
        expect(after[i]!.length).toBeLessThan(css.length);
        expect(await parsed(after[i]!), `${file}, CSS ${i + 1}`).toBe(await parsed(css));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});
