// The views keep their CSS in template literals (`const CSS = `…``, `const FOO_CSS = `…``), which
// esbuild's minify leaves as written. This strips their comments and whitespace at build time: a comment
// goes, a run of whitespace becomes one space, and none is kept next to { } ; , > or after : and (, nor a
// ; before }. Selectors and values are never changed: quoted strings and ${…} are copied as they are, the
// space before a : (a descendant pseudo-class) or a ( stays, and so does the one starting a custom
// property's value or a var() fallback, which are kept as written. Anything it cannot follow is an error.
import { readFile } from 'node:fs/promises';

const START = /\b(?:export )?const (?:[A-Z][A-Z0-9_]*_)?CSS = `/g;
/** Stands for ${…} while the CSS around it is minified: neither whitespace nor punctuation. */
const HOLE = '\u0001';
const AFTER = new Set(['{', '}', ';', ',', '>', ':', '(']);
const BEFORE = new Set(['{', '}', ';', ',', '>', ')']);
const PUNCTUATION = new Set([...AFTER, ...BEFORE]);
const SPACE = /\s/;

/** One template literal's CSS (its ${…} as HOLE), minified. */
export const minifyCss = (css) => {
  let out = '';
  let space = false;
  /** The space after the last character is part of a value: `--x: 1px`, `var(--x, 1px)`. */
  let keep = false;
  /** The functions the CSS is inside, innermost last. */
  const calls = [];
  for (let i = 0; i < css.length;) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) throw new Error('css-minify: an unclosed comment');
      const [before, after] = [css[i - 1], css[end + 2]];
      // Dropping a comment between two words would join them.
      if ([before, after].every((x) => x !== undefined && !SPACE.test(x) && !PUNCTUATION.has(x))) {
        throw new Error('css-minify: a comment between two words');
      }
      i = end + 2;
      continue;
    }
    if (SPACE.test(c)) {
      space = true;
      i += 1;
      continue;
    }
    if (space && out && (keep || !AFTER.has(out.at(-1))) && !BEFORE.has(c)) out += ' ';
    space = false;
    keep = (c === ':' && /[{;]--[\w-]+$/.test(out)) || (c === ',' && calls.at(-1) === 'var');
    if (c === '(') calls.push(/[\w-]*$/.exec(out)[0]);
    else if (c === ')') calls.pop();
    if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== c) end += css[end] === '\\' ? 2 : 1;
      if (end >= css.length) throw new Error('css-minify: an unclosed string');
      out += css.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '}' && out.at(-1) === ';') out = out.slice(0, -1);
    const step = c === '\\' ? 2 : 1;
    out += css.slice(i, i + step);
    i += step;
  }
  return out;
};

/** Each CSS template literal in `source`: where its text starts and ends, and its ${…}. */
function* templates(source) {
  let from = 0;
  for (const match of source.matchAll(START)) {
    if (match.index < from) continue;
    const start = match.index + match[0].length;
    const holes = [];
    let css = '';
    let i = start;
    for (;;) {
      const c = source[i];
      if (c === undefined) throw new Error('css-minify: an unclosed template literal');
      if (c === '`') break;
      if (c === '$' && source[i + 1] === '{') {
        const end = source.indexOf('}', i);
        const hole = source.slice(i, end + 1);
        if (!/^\$\{[\w.]+\}$/.test(hole)) throw new Error(`css-minify: only a name may go in \${…}, not ${hole.slice(0, 40)}`);
        holes.push(hole);
        css += HOLE;
        i = end + 1;
        continue;
      }
      if (c === HOLE) throw new Error('css-minify: a U+0001 in the CSS');
      const step = c === '\\' ? 2 : 1;
      css += source.slice(i, i + step);
      i += step;
    }
    yield { start, end: i, css, holes };
    from = i;
  }
}

const fill = (css, holes) => {
  let n = 0;
  // eslint-disable-next-line no-control-regex -- \u0001 marks a hole; CSS text never holds one
  return css.replace(/\u0001/g, () => holes[n++]);
};

/** The CSS template literals' text in `source`, as written (the tests compare before and after). */
export const cssTemplates = (source) => [...templates(source)].map(({ css, holes }) => fill(css, holes));

/** `source` with each CSS template literal minified. */
export const minifyCssTemplates = (source) => {
  let out = '';
  let from = 0;
  for (const { start, end, css, holes } of templates(source)) {
    const minified = minifyCss(css);
    if (minified.split(HOLE).length !== css.split(HOLE).length) throw new Error('css-minify: a ${…} inside a comment');
    out += source.slice(from, start) + fill(minified, holes);
    from = end;
  }
  return out + source.slice(from);
};

/** esbuild plugin: src/'s TypeScript with its CSS minified as it loads. */
export const cssMinify = {
  name: 'css-minify',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, async (args) => ({
      contents: minifyCssTemplates(await readFile(args.path, 'utf8')),
      loader: 'ts',
    }));
  },
};
