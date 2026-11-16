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

  describe('a touch whose node leaves the page (drawn again under the press)', () => {
    // As in Chrome: a touch's events all go to the node it started on, so once that node is out of the
    // page they no longer reach the view's element.
    const view = (capture = false) => {
      const el = document.createElement('div');
      const label = el.appendChild(document.createElement('span'));
      const icon = label.appendChild(document.createElement('i'));
      document.body.append(el);
      const seen: string[] = [];
      const stop = listenTouch(el, {
        start: () => { seen.push('start'); },
        move: (p) => { seen.push(`move ${p?.x}`); },
        end: (p) => { seen.push(`end ${p?.x}`); },
        cancel: () => { seen.push('cancel'); },
      }, { capture });
      return { el, label, icon, seen, stop };
    };

    it('still reaches the view: its moves, its end (claimed) and its cancel', () => {
      const { label, icon, seen } = view();
      touch(icon, 'touchstart');
      label.replaceChildren(document.createElement('i'));
      expect(icon.isConnected).toBe(false);
      touch(icon, 'touchmove', 1);
      const end = touch(icon, 'touchend', 2);
      expect(end.defaultPrevented).toBe(true);
      label.replaceChildren(icon);
      touch(icon, 'touchstart');
      label.replaceChildren();
      touch(icon, 'touchcancel');
      expect(seen).toEqual(['start', 'move 1', 'end 2', 'start', 'cancel']);
    });

    it('once each, in the page or out of it, listening in either phase', () => {
      for (const capture of [false, true]) {
        const { label, icon, seen } = view(capture);
        touch(icon, 'touchstart');
        touch(icon, 'touchmove', 1);
        label.replaceChildren();
        touch(icon, 'touchmove', 2);
        touch(icon, 'touchend', 3);
        expect(seen).toEqual(['start', 'move 1', 'move 2', 'end 3']);
      }
    });

    it('no longer after its end, nor after the view stops listening', () => {
      const { label, icon, seen, stop } = view();
      touch(icon, 'touchstart');
      label.replaceChildren();
      touch(icon, 'touchend', 1);
      touch(icon, 'touchend', 2); // its touch is over: the node no longer passes anything on
      label.append(icon);
      touch(icon, 'touchstart');
      stop();
      label.replaceChildren();
      touch(icon, 'touchend', 3);
      expect(seen).toEqual(['start', 'end 1', 'start']);
    });

    it('only to the view that claims it, as in the page (one listening across the shadow root, one on its keys)', () => {
      const host = document.createElement('div');
      document.body.append(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const keys = shadow.appendChild(document.createElement('div'));
      const icon = keys.appendChild(document.createElement('i'));
      const seen: string[] = [];
      let picking = true;
      listenTouch(shadow, { end: () => { seen.push('picker'); return picking; } }, { capture: true });
      listenTouch(keys, { start: () => {}, end: () => { seen.push('keys'); } });
      for (const on of [true, false]) {
        picking = on;
        keys.append(icon);
        touch(icon, 'touchstart');
        icon.remove();
        touch(icon, 'touchend');
      }
      expect(seen).toEqual(['picker', 'picker', 'keys']); // claimed by the picker, then left to the keys
    });
  });

  it('reads the touch point, or none', () => {
    const e = new Event('touchstart');
    expect(touchPoint(e)).toBeNull();
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: 5, clientY: 6 }] });
    expect(touchPoint(e)).toEqual({ x: 5, y: 6 });
  });
});
