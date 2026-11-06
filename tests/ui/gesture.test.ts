// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { touchGuard } from '../../src/core/interaction.js';
import { listenTouch, touchPoint } from '../../src/ui/gesture.js';

const touch = (el: Element, type: string, x = 0, y = 0): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
  return e;
};

describe('listenTouch', () => {
  it('claims the touches a view takes, marks the guard, and leaves the ones it returns false for', () => {
    const outer = document.createElement('div');
    const el = document.createElement('div');
    outer.append(el);
    document.body.append(outer);
    const t = 0;
    const guard = touchGuard(() => t);
    const seen: string[] = [];
    outer.addEventListener('touchmove', () => seen.push('outer saw move'));
    outer.addEventListener('touchstart', () => seen.push('outer saw start'));
    listenTouch(el, {
      start: (p) => { seen.push(`start ${p?.x},${p?.y}`); },
      move: () => false, // not ours
      end: () => { seen.push('end'); },
    }, { guard });
    const start = touch(el, 'touchstart', 3, 4);
    expect(start.defaultPrevented).toBe(true);
    expect(guard.ghost()).toBe(true); // marked
    expect(touch(el, 'touchmove').defaultPrevented).toBe(false);
    touch(el, 'touchend');
    expect(seen).toEqual(['start 3,4', 'outer saw move', 'end']); // the claimed ones stop here
  });

  it('drops the mouse click copied from a touch, unseen; passes a real click; stops listening', () => {
    const outer = document.createElement('div');
    const el = document.createElement('div');
    outer.append(el);
    document.body.append(outer);
    let t = 1000;
    const guard = touchGuard(() => t);
    const clicks: string[] = [];
    outer.addEventListener('click', () => clicks.push('outer'));
    const stop = listenTouch(el, { end: () => {}, click: () => clicks.push('view') }, { guard });
    touch(el, 'touchend');
    el.click(); // the copy, at once
    expect(clicks).toEqual([]);
    t += 1000;
    el.click(); // a real mouse
    expect(clicks).toEqual(['view', 'outer']);
    stop();
    el.click();
    expect(clicks).toEqual(['view', 'outer', 'outer']); // no longer ours
  });

  it('reads the touch point, or none', () => {
    const e = new Event('touchstart');
    expect(touchPoint(e)).toBeNull();
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: 5, clientY: 6 }] });
    expect(touchPoint(e)).toEqual({ x: 5, y: 6 });
  });
});
