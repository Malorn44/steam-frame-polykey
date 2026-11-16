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

/** Touch events a view claimed: a node following its touch (see listenTouch) passes on only the others. */
const claimed = new WeakSet<Event>();
/** What follows a touch's start, all sent to the node it started on. */
const LATER = ['touchmove', 'touchend', 'touchcancel'] as const;

/** Listen for a view's touches (and its mouse clicks); returns a function that stops listening. */
export const listenTouch = (el: EventTarget, handlers: TouchHandlers, { guard, capture = false }: ListenOptions = {}): (() => void) => {
  const options = { capture, passive: false } as const;
  const added: [string, EventListener, boolean | AddEventListenerOptions][] = [];
  const on = (type: string, listener: EventListener, opts: boolean | AddEventListenerOptions): void => {
    el.addEventListener(type, listener, opts);
    added.push([type, listener, opts]);
  };
  const listeners: Partial<Record<string, EventListener>> = {};
  const claim = (type: 'touchstart' | 'touchmove' | 'touchend', handler: TouchHandler | undefined): void => {
    if (!handler) return;
    on(type, listeners[type] = (e) => {
      if (handler(touchPoint(e), e) === false) return;
      claimed.add(e);
      e.preventDefault();
      e.stopPropagation();
      if (type !== 'touchmove') guard?.touched();
    }, options);
  };
  claim('touchstart', handlers.start);
  claim('touchmove', handlers.move);
  claim('touchend', handlers.end);
  if (handlers.cancel) on('touchcancel', listeners['touchcancel'] = handlers.cancel, options);

  // A touch's later events go to the node it started on, even once that node has left the page (a key's
  // icon drawn again under a held press). Then they never reach `el`, and the gesture never ends: a held
  // Backspace repeats on. So that node passes them on itself, until no touch that started on it is left.
  const followed = new Set<EventTarget>();
  const unfollow = (node: EventTarget): void => {
    for (const type of LATER) node.removeEventListener(type, relay);
    followed.delete(node);
  };
  const relay = (e: Event): void => {
    // Still in the page it reaches `el` as ever; one claimed by a view already followed is that view's.
    if (!e.composedPath().includes(el) && !claimed.has(e)) listeners[e.type]?.(e);
    if (e.type !== 'touchmove' && !(e as TouchEvent).targetTouches?.length && e.currentTarget) unfollow(e.currentTarget);
  };
  if (LATER.some((type) => listeners[type])) {
    on('touchstart', (e) => {
      // The only touch down: any node still followed lost its touch's end.
      if (((e as TouchEvent).touches?.length ?? 0) <= 1) for (const node of followed) unfollow(node);
      const node = e.composedPath()[0];
      if (!node || node === el || followed.has(node)) return;
      followed.add(node);
      for (const type of LATER) node.addEventListener(type, relay, { passive: false });
    }, { capture, passive: true });
  }
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
  return () => {
    for (const [type, listener, opts] of added) el.removeEventListener(type, listener, opts);
    for (const node of followed) unfollow(node);
  };
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
