// @vitest-environment jsdom
// One bundled layout's own checks in the page: every key draws a label, and keys type what they show
// (their label, their Shift legend, their flicks and flick hints, the long-press hint). The layout is
// drawn everywhere a keyboard shows it (its modes and pages, and each option that changes what it
// shows), with no modifier, Shift, Caps and Fn. sidecar/tests/test_layout.py checks that it loads and is
// as wide as it should be. CI runs both for each layout (npm run test:layout -- ja/flick); POLYKEY_LAYOUT
// names the layout, and without it every bundled layout is checked.
import { env } from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import type { KeyDef, KeyboardDef, Layout } from '../src/core/catalog.js';
import { HOLD_MS } from '../src/core/interaction.js';
import { NO_MODS, charText, flickText, kanaSide, press, resolveKey, type Mods } from '../src/core/keyboard.js';
import { modeLetters } from '../src/core/pages.js';
import { createView } from '../src/ui/view.js';
import { bundledBoot } from './boot.js';

const boot = bundledBoot();
const only = env['POLYKEY_LAYOUT'];
const ids = only ? [only] : Object.keys(boot.catalog.layouts).sort();

/** Where a keyboard shows the layout: how the view draws it there, and how its keys type. */
interface Place {
  readonly name: string;
  /** 英数 mode, and romaji: JIS keys show and type their Latin legends (the romaji keyboard, ローマ字入力). */
  readonly latin: boolean;
  readonly romaji: boolean;
  /** Into the reading buffer: a Japanese keyboard in かな mode, where a JIS key types its kana. */
  readonly kana: boolean;
  readonly symbols: 0 | 1 | 2;
  readonly letters: string | undefined;
  /** The flick hints option. */
  readonly hints: boolean;
}

/** Both values of an option the keyboard offers; its one value otherwise. */
const values = (offered: boolean, value: boolean): boolean[] => (offered ? [false, true] : [value]);

const placesIn = (keyboard: KeyboardDef, layoutId: string): Place[] => {
  const options = keyboard.options ?? {};
  const latin = keyboard.pages?.latin;
  const latinPages = typeof latin === 'object' ? [latin.flick, latin.qwerty] : latin ? [latin] : [];
  const modes = keyboard.modes?.some((mode) => mode.latin) ? [false, true] : [false];
  // The layout as the main page (in each mode, unless 英数 has a page of its own), the 英数 page, or a symbols page.
  const pages: { latin: boolean; symbols: 0 | 1 | 2 }[] = [
    ...(keyboard.layout === layoutId
      ? (latinPages.length ? [false] : modes).map((l) => ({ latin: l, symbols: 0 as const }))
      : []),
    ...(latinPages.includes(layoutId) ? [{ latin: true, symbols: 0 as const }] : []),
    ...(keyboard.pages?.symbols ?? []).flatMap((id, i) =>
      id === layoutId ? modes.map((l) => ({ latin: l, symbols: (i + 1) as 1 | 2 })) : [],
    ),
  ];
  const buffered = keyboard.composer === 'kana' || keyboard.composer === 'romaji';
  const romajis =
    keyboard.composer === 'romaji'
      ? [true]
      : keyboard.composer === 'kana'
        ? values('romajiInput' in options, !!options.romajiInput)
        : [false];
  return pages.flatMap((page) =>
    romajis.flatMap((romaji) =>
      values('flickHints' in options, !!options.flickHints).map((hints) => ({
        name: [
          keyboard.id,
          page.latin ? '英数' : buffered ? 'かな' : '',
          page.symbols ? `symbols ${page.symbols}` : '',
          romaji && buffered ? 'romaji' : '',
          hints ? 'flick hints' : '',
        ]
          .filter(Boolean)
          .join(', '),
        latin: page.latin,
        romaji,
        kana: buffered && !page.latin,
        symbols: page.symbols,
        letters: modeLetters(keyboard, page.latin),
        hints,
      })),
    ),
  );
};

/** Every place a keyboard shows the layout; a layout no keyboard names (the emoji row) on its own. */
const placesOf = (layoutId: string): Place[] => {
  const places = Object.values(boot.catalog.keyboards).flatMap((keyboard) => placesIn(keyboard, layoutId));
  return places.length
    ? places
    : [{ name: 'on its own', latin: false, romaji: false, kana: false, symbols: 0, letters: undefined, hints: false }];
};

const MODS: [string, Mods][] = [
  ['no modifier', NO_MODS],
  ['Shift', { ...NO_MODS, shift: 'once' }],
  ['Caps', { ...NO_MODS, caps: true }],
  ['Fn', { ...NO_MODS, fn: 'once' }],
];
const SHIFT: Mods = { ...NO_MODS, shift: 'once' };

/** What a press types where the layout is shown (as main.ts sends it), or undefined for a key that types no text. */
const typed = (key: KeyDef, alternate: string | undefined, mods: Mods, place: Place): string | undefined => {
  if (alternate !== undefined) return key.type === 'flick' ? flickText(alternate, mods) : alternate;
  // Into the reading: a char key with Shift (a JIS key its kana); a key's Fn variant goes out as a key.
  const side = place.kana && resolveKey(key, mods) === key ? kanaSide(key, !place.romaji) : undefined;
  if (side?.type === 'char') return charText(side, mods);
  const effect = press(mods, key).effects[0];
  return effect?.kind === 'text' ? effect.text : undefined;
};

/** ゛ and ゜ are drawn as combining marks on a full-width space, where they sit on a kana. */
const MARKS: Record<string, string> = { '\u3000\u3099': '゛', '\u3000\u309a': '゜' };
const text = (el: Element | null | undefined): string => {
  const shown = el?.textContent ?? '';
  return MARKS[shown] ?? shown;
};
/** The legend that says what the key types now: its label, or a JIS key's current character. */
const mainLegend = (el: HTMLElement): string => text(el.querySelector('.s-dual')) || text(el.querySelector('.lbl'));
/** The legend that says what the key types with Shift, by where the key's arrangement puts it. */
const shiftLegend = (el: HTMLElement, place: Place): Element | null => {
  if (el.classList.contains('stack')) return el.querySelector('.lg.t');
  if (el.classList.contains('tri')) return el.querySelector('.lg.tl');
  if (el.classList.contains('quad'))
    return el.querySelector(place.romaji ? '.lg.t' : place.latin ? '.lg.tl' : '.lg.tr');
  return null;
};
/** The flick hint for each direction after the tap (left, up, right, down). */
const EDGES = ['.lg.l', '.lg.t', '.lg.r', '.lg.b'];
const STEP: [number, number][] = [
  [0, 0],
  [-1, 0],
  [0, -1],
  [1, 0],
  [0, 1],
];

const touch = (el: Element, type: string, x = 100, y = 100): void => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
};

const render = (layout: Layout, place: Place, mods: Mods) => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const pressed: { key: KeyDef; alternate: string | undefined }[] = [];
  const view = createView(
    document,
    shadow,
    layout,
    boot.catalog.themes['themes/steam']!,
    (key, alternate) => pressed.push({ key, alternate }),
    undefined,
    undefined,
    { latin: place.latin, romaji: place.romaji, symbols: place.symbols, letters: place.letters, hints: place.hints },
  );
  view.update(mods);
  const keys = [
    ...[...shadow.querySelectorAll<HTMLElement>('.bar .key')].map((el) => ({
      el,
      where: `toolbar "${el.dataset['k']}"`,
    })),
    ...[...shadow.querySelectorAll('.row')].flatMap((row, r) =>
      [...row.querySelectorAll<HTMLElement>('.key')].map((el, c) => ({
        el,
        where: `row ${r} key ${c} "${el.dataset['k']}"`,
      })),
    ),
  ].filter(({ el }) => !['gap', 'tall-middle', 'tall-bottom'].some((cls) => el.classList.contains(cls))); // drawn on the top piece
  const tap = (el: HTMLElement) => {
    pressed.length = 0;
    touch(el, 'touchstart');
    touch(el, 'touchend');
    return pressed.length === 1 ? pressed[0] : undefined;
  };
  return {
    shadow,
    pressed,
    keys,
    tap,
    done: () => {
      view.destroy();
      host.remove();
    },
  };
};

/** A key whose label is its own (a label, a legend in c or an icon) shows a name, not what it types. */
const labelled = (key: KeyDef, el: HTMLElement): boolean =>
  ('label' in key && key.label !== undefined)
  || ('legends' in key && key.legends?.c !== undefined)
  || el.querySelector('.lbl svg') !== null;

describe.each(ids)('%s', (id) => {
  const layout = boot.catalog.layouts[id];
  it('is a bundled layout', () => expect(layout, `no bundled layout ${id}`).toBeDefined());
  if (!layout) return;

  describe.each(placesOf(id))('$name', (place) => {
    it.each(MODS)('every key draws a label (%s)', (_, mods) => {
      const { keys, done } = render(layout, place, mods);
      expect(
        keys.filter(({ el }) => !(el.textContent ?? '').trim() && !el.querySelector('svg')).map(({ where }) => where),
      ).toEqual([]);
      done();
    });

    it.each(MODS)('keys type what they show (%s)', (_, mods) => {
      const { shadow, pressed, keys, tap, done } = render(layout, place, mods);
      const wrong: string[] = [];
      // A press that sends a key or a chord (Fn's F1) types no text to compare.
      const check = (where: string, shows: string, types: string | undefined) => {
        if (types !== undefined && shows !== types)
          wrong.push(`${where} shows ${JSON.stringify(shows)} but types ${JSON.stringify(types)}`);
      };
      for (const { el, where } of keys.filter(({ where: w }) => w.startsWith('row'))) {
        const shown = mainLegend(el);
        const hit = tap(el);
        if (!hit || (hit.key.type !== 'char' && hit.key.type !== 'flick')) continue;
        const { key } = hit;
        if (!labelled(key, el) || (key.type === 'flick' && (place.hints || key.hints)))
          check(where, shown, typed(key, undefined, mods, place));
        const shift = mods === NO_MODS ? shiftLegend(el, place) : null;
        if (shift) check(`${where} (Shift legend)`, text(shift), typed(key, undefined, SHIFT, place));
        if (key.type === 'flick') {
          // Each way: the guide shows what the flick types, and so does its hint when hints are shown.
          STEP.forEach(([dx, dy], way) => {
            pressed.length = 0;
            touch(el, 'touchstart');
            if (way) touch(el, 'touchmove', 100 + dx * 40, 100 + dy * 40);
            const cell = shadow.querySelector('.fl div.pick');
            const guide = cell?.classList.contains('empty') ? '' : text(cell);
            touch(el, 'touchend', 100 + dx * 40, 100 + dy * 40);
            const out =
              pressed.length === 1
                ? typed(pressed[0]!.key, pressed[0]!.alternate, mods, place)
                : pressed.length
                  ? `${pressed.length} presses`
                  : '';
            check(`${where} (flick ${way}, its guide)`, guide, out);
            if (way && (place.hints || key.hints))
              check(`${where} (flick ${way}, its hint)`, text(el.querySelector(EDGES[way - 1]!)), out);
          });
        }
        // The small legend top right: the character a long press offers.
        const hint = key.type === 'char' && key.hint !== undefined ? el.querySelector('.lg.tr:not(.t-fn)') : null;
        if (hint) {
          vi.useFakeTimers();
          touch(el, 'touchstart');
          vi.advanceTimersByTime(HOLD_MS);
          const offered = [...shadow.querySelectorAll('.alts .key')].map((cell) => text(cell));
          touch(el, 'touchend');
          vi.useRealTimers();
          if (!offered.includes(text(hint)))
            wrong.push(
              `${where} shows ${JSON.stringify(text(hint))} to hold for, but holding offers ${JSON.stringify(offered)}`,
            );
        }
      }
      expect(wrong).toEqual([]);
      done();
    });
  });
});
