// ⓘ on the settings page (a Dictation model or the engine, General's "Update automatically"): its details
// in a popover over the panel, shown while the laser (or mouse) is over it, or after a tap (touch has no
// hover) until the next tap. Taps and hover reach it through settings' `actions`.

import { INFO_ICON } from './icons.js';

export const INFO_CSS = `
.ic.i { width: 20px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius); color: var(--legend); font-size: var(--ui-control); }
.ic.i.hover, .ic.i.open { background: var(--accent); color: var(--accent-text); }
.info-pop { position: absolute; z-index: 4; box-sizing: border-box; padding: 5px 8px; overflow: hidden; pointer-events: none;
  background: var(--key); background-image: linear-gradient(var(--raised), var(--raised)); color: var(--text);
  border-radius: var(--radius); box-shadow: var(--shadow-lg); font-size: var(--ui-small); line-height: 1.3; }
.info-pop .t { font-weight: 600; margin-bottom: 2px; }
.info-pop p { margin: 0 0 2px; }
`;

/** The popover's widest, and the least room it needs left of its ⓘ before it goes to the right instead. */
const POP_PX = 360;
const POP_MIN_PX = 200;

/** A line of details: a class (`t` is the title) and its text; empty ones are left out. */
export type InfoLine = [string, string];

export interface InfoTips {
  /** An ⓘ showing `title` and `lines`, read when it opens. */
  icon(title: string, lines: () => InfoLine[]): HTMLElement;
  /** What the laser (or mouse) is over now, from settings' hover path: an ⓘ opens its details. */
  hover(el: HTMLElement | undefined): void;
}

/** The ⓘ inside `scope`: one popover at a time, in the settings panel, at most `maxWidth()` wide. */
export const infoTips = (
  doc: Document, scope: HTMLElement, actions: Map<HTMLElement, () => void>, maxWidth = (): number => POP_PX,
): InfoTips => {
  const details = new Map<HTMLElement, () => InfoLine[]>();
  const pop = Object.assign(doc.createElement('div'), { className: 'info-pop' });
  let pinned: HTMLElement | undefined;
  let shown: HTMLElement | undefined;
  const show = (icon: HTMLElement | undefined): void => {
    shown?.classList.remove('open');
    shown = icon;
    const panel = scope.closest<HTMLElement>('.panel');
    if (!icon || !panel) {
      pop.remove();
      return;
    }
    icon.classList.add('open');
    pop.replaceChildren(...(details.get(icon)?.() ?? []).filter(([, text]) => text)
      .map(([cls, text]) => Object.assign(doc.createElement(cls === 't' ? 'div' : 'p'), { className: cls, textContent: text })));
    panel.append(pop);
    // Beside the ⓘ, left of it (right of it if there is no room), so it never covers the ⓘ and ✕ columns
    // and the laser can go on to the next ⓘ; level with it, moved up as far as it must to stay in the panel.
    const box = panel.getBoundingClientRect();
    const at = icon.getBoundingClientRect();
    const room = at.left - box.left - 8;
    const leftSide = room >= POP_MIN_PX;
    // At most maxWidth, and half the panel's height.
    const width = Math.min(POP_PX, maxWidth() || POP_PX, leftSide ? room : box.right - at.right - 8);
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.round(box.height / 2)}px`;
    const height = pop.offsetHeight;
    pop.style.top = `${Math.max(4, Math.min(at.top - box.top - 4, box.height - height - 4))}px`;
    pop.style.left = `${leftSide ? at.left - box.left - 4 - width : at.right - box.left + 4}px`;
  };
  // A tap anywhere but on an ⓘ closes what a tap opened.
  const closeOnTap = (e: Event): void => {
    if (pinned && ![...details.keys()].some((icon) => icon.contains(e.target as Node))) {
      pinned = undefined;
      show(undefined);
    }
  };
  for (const type of ['touchstart', 'mousedown'] as const) scope.addEventListener(type, closeOnTap, { capture: true, passive: true });

  return {
    icon: (title, lines) => {
      const icon = Object.assign(doc.createElement('div'), { className: 'ic i', innerHTML: INFO_ICON });
      details.set(icon, () => [['t', title], ...lines()]);
      actions.set(icon, () => {
        pinned = pinned === icon ? undefined : icon;
        show(pinned);
      });
      return icon;
    },
    hover: (target) => {
      if (pinned) return; // a tapped ⓘ stays open until the next tap
      show(target && details.has(target) ? target : undefined);
    },
  };
};
