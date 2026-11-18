// A view drawn in the test's document, and touches on it, as Steam's laser sends them.
import type { KeyDef, Layout } from '../src/core/catalog.js';
import { NO_MODS } from '../src/core/keyboard.js';
import { createView } from '../src/ui/view.js';
import { bundledBoot } from './boot.js';

export const touch = (el: Element, type: string, x = 0, y = 0): void => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
};

export const tap = (el: Element): void => {
  touch(el, 'touchstart');
  touch(el, 'touchend');
};

const boot = bundledBoot();

type CreateView = Parameters<typeof createView>;
type DrawOptions = NonNullable<CreateView[7]> & {
  theme?: string; onKey?: CreateView[4]; onSuggestion?: CreateView[5]; onCandidate?: CreateView[6];
};

/**
 * A layout (a bundled one, by id) drawn in a shadow root of its own, with no modifier. Without onKey, the
 * keys it reports are kept: pressed, or chosen when held.
 */
export const drawView = (layout: string | Layout, { theme = 'themes/steam', onKey, onSuggestion, onCandidate, ...options }: DrawOptions = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const pressed: KeyDef[] = [];
  const chosen: string[] = [];
  const view = createView(document, shadow, typeof layout === 'string' ? boot.catalog.layouts[layout]! : layout, boot.catalog.themes[theme]!,
    onKey ?? ((k, alternate) => (alternate === undefined ? pressed.push(k) : chosen.push(alternate))), onSuggestion, onCandidate, options);
  view.update(NO_MODS);
  const keyOf = (id: string) => [...shadow.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
  return { view, host, shadow, pressed, chosen, keyOf };
};
