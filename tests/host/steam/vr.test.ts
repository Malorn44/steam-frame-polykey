// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HAPTIC, haptic, onCursor, steamKeyboardStyle } from '../../../src/host/steam/vr.js';

describe('steamKeyboardStyle', () => {
  it('reads colours from the stock keys, skipping transparent ones', () => {
    document.body.innerHTML =
      '<div class="Layout_x" style="background: rgb(35, 38, 46)">'
      + '<div data-key="a"><div style="background: rgb(14, 20, 27); color: rgb(255, 255, 255)"></div></div>'
      + '<div data-key="Shift"><div style="background: rgba(0, 0, 0, 0)"></div></div></div>';
    const { colors } = steamKeyboardStyle(window);
    expect(colors).toEqual({ surface: '#23262e', key: '#0e141b', keyText: '#ffffff' });
  });

  it('returns nothing on a page without Steam keys', () => {
    document.body.innerHTML = '';
    expect(steamKeyboardStyle(window).colors).toEqual({});
  });
});

describe('haptic and onCursor', () => {
  it('call Steam when it has the calls, and do nothing otherwise', () => {
    const calls: unknown[][] = [];
    let move: ((hand: number, flag: unknown, x: number, y: number) => void) | undefined;
    let unregistered = false;
    const win = {
      SteamClient: {
        OpenVR: {
          TriggerOverlayHapticEffect: (...args: unknown[]) => calls.push(args),
          VROverlay: {
            RegisterForCursorMovement: (fn: typeof move) => {
              move = fn;
              return {
                unregister: () => {
                  unregistered = true;
                },
              };
            },
          },
        },
      },
    } as unknown as Window;
    haptic(win, HAPTIC.enter, 1);
    expect(calls).toEqual([[1, 1]]);
    const seen: number[][] = [];
    const stop = onCursor(win, (x, y, hand) => seen.push([x, y, hand]));
    move!(0, false, 284, 103); // as measured on the Frame: (hand, flag, x, y)
    move!(1, true, Number.NaN, 5); // no position
    expect(seen).toEqual([[284, 103, 0]]);
    stop();
    expect(unregistered).toBe(true);
    expect(() => {
      haptic({} as Window, 1, 0);
      onCursor({} as Window, () => {})();
    }).not.toThrow();
  });
});
