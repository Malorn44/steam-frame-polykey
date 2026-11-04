// Touch handling shared by the views (the keys, settings, the Keyboards page, the emoji picker). The
// laser arrives as touch events; each one a view takes is claimed (no page scroll, no view underneath
// seeing it) and marks the touch guard, so the mouse events the browser sends after it are ignored.
// What a gesture means stays with each view.

import type { TouchGuard } from '../core/interaction.js';

export interface TouchPoint { readonly x: number; readonly y: number }

/** Where a touch event is, if it has a touch. */
export const touchPoint = (e: Event): TouchPoint | null => {
  const t = (e as TouchEvent).changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
};

/** A touch handler; returning false leaves the event unclaimed (not this view's gesture). */
export type TouchHandler = (point: TouchPoint | null, e: Event) => void | boolean;

export interface TouchHandlers {
  start?: TouchHandler;
  move?: TouchHandler;
  end?: TouchHandler;
  /** The gesture was taken away (never claimed: nothing to prevent). */
  cancel?: (e: Event) => void;
  /** A real mouse click (the desktop fallback); clicks copied from a touch are dropped, unseen by anyone. */
  click?: (e: MouseEvent) => void;
}

export interface ListenOptions {
  /** Marked on each claimed touch start and end; it drops the copied clicks. */
  readonly guard?: TouchGuard;
  /** Listen in the capture phase (to follow a gesture across a whole shadow root). */
  readonly capture?: boolean;
}

/** Listen for a view's touches (and its mouse clicks); returns a function that stops listening. */
export const listenTouch = (el: EventTarget, handlers: TouchHandlers, { guard, capture = false }: ListenOptions = {}): (() => void) => {
  const options = { capture, passive: false } as const;
  const added: [string, EventListener, boolean | AddEventListenerOptions][] = [];
  const on = (type: string, listener: EventListener, opts: boolean | AddEventListenerOptions): void => {
    el.addEventListener(type, listener, opts);
    added.push([type, listener, opts]);
  };
  const claim = (type: 'touchstart' | 'touchmove' | 'touchend', handler: TouchHandler | undefined): void => {
    if (!handler) return;
    on(type, (e) => {
      if (handler(touchPoint(e), e) === false) return;
      e.preventDefault();
      e.stopPropagation();
      if (type !== 'touchmove') guard?.touched();
    }, options);
  };
  claim('touchstart', handlers.start);
  claim('touchmove', handlers.move);
  claim('touchend', handlers.end);
  if (handlers.cancel) on('touchcancel', handlers.cancel, options);
  const click = handlers.click;
  if (click) {
    on('click', (e) => {
      if (guard?.ghost()) {
        e.stopPropagation();
        return;
      }
      click(e as MouseEvent);
    }, { capture });
  }
  return () => { for (const [type, listener, opts] of added) el.removeEventListener(type, listener, opts); };
};

/** A press on a scrolling list, which turns into a drag of it once it moves past `slop`. */
export interface DragScroll {
  /** Past the slop: a scroll, not a tap. */
  readonly moved: boolean;
  move(point: TouchPoint): void;
}

/**
 * Drag-scroll `list` along `axis` from a touch at `from`: under the slop nothing moves (a release there
 * is still a tap), past it the list follows the touch. Shared by the candidate list and the Dictation
 * tab's lists; the laser's trigger drags them as a finger would.
 */
export const dragScroll = (list: HTMLElement, from: TouchPoint, axis: 'x' | 'y', slop: number): DragScroll => {
  const left = list.scrollLeft;
  const top = list.scrollTop;
  let moved = false;
  return {
    get moved() { return moved; },
    move: (point) => {
      const dx = point.x - from.x;
      const dy = point.y - from.y;
      if (Math.hypot(dx, dy) > slop) moved = true;
      if (!moved) return;
      if (axis === 'y') list.scrollTop = top - dy;
      else list.scrollLeft = left - dx;
    },
  };
};
