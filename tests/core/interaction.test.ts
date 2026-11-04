import { describe, expect, it } from 'vitest';
import { TOUCH_MOUSE_GUARD_MS, touchGuard } from '../../src/core/interaction.js';

describe('touchGuard', () => {
  it('treats mouse events soon after a touch as its copies', () => {
    let t = 1000;
    const guard = touchGuard(() => t);
    expect(guard.ghost()).toBe(false); // no touch yet: a real mouse
    guard.touched();
    t += 300;
    expect(guard.ghost()).toBe(true);
    t += TOUCH_MOUSE_GUARD_MS;
    expect(guard.ghost()).toBe(false);
  });
});
