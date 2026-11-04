// Touch timings and distances, shared by every view. Pure (no DOM), so core and ui can both use it.

/** Hold a key this long for its alternates, a toned emoji for its tones, a Recent emoji to lift it. */
export const HOLD_MS = 400;
/** Held Space, Backspace, Delete and arrows repeat: first after REPEAT_DELAY_MS, then every REPEAT_MS. */
export const REPEAT_DELAY_MS = 450;
export const REPEAT_MS = 60;
/** The laser moving this long without a touch move means the trigger was released unseen. */
export const RELEASE_LOST_MS = 600;

/** How far a press may move before it becomes something else, in CSS px. */
export const SLOP_PX = {
  /** …a flick on a 12-key key (fjk: 24). */
  flick: 20,
  /** …a scroll of the candidate list instead of a pick. */
  list: 12,
  /** …a drag on the Keyboards page. */
  reorder: 10,
  /** …a scroll of the emoji grid instead of a tap. */
  scroll: 24,
  /** …a scroll, while an emoji hold may still follow (Full Keyboard). */
  holdWander: 32,
} as const;

/**
 * After a touch, the browser also sends mouse events for it (mousedown, mouseup, click), about 300 ms
 * later. Mouse events this soon after a touch are those copies, not a real mouse.
 */
export const TOUCH_MOUSE_GUARD_MS = 600;

export interface TouchGuard {
  /** Call on touch: mouse events for the next TOUCH_MOUSE_GUARD_MS are copies of it. */
  touched(): void;
  /** True while a mouse event is probably a copy of the last touch. */
  ghost(): boolean;
}

export const touchGuard = (clock: () => number = Date.now): TouchGuard => {
  let at = -Infinity;
  return {
    touched: () => { at = clock(); },
    ghost: () => clock() - at < TOUCH_MOUSE_GUARD_MS,
  };
};
