import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINDING, createBridge } from '../../src/bridge/client.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createBridge', () => {
  it('sends op, args and an id, and resolves with the matching reply', async () => {
    const sent: unknown[] = [];
    const g: Record<string, unknown> = { [BINDING]: (payload: string) => sent.push(JSON.parse(payload)) };
    const bridge = createBridge(g);
    const first = bridge.call('desktop.prepare', { text: 'テスト' });
    const second = bridge.call('hello');
    expect(sent).toEqual([
      { text: 'テスト', id: 1, op: 'desktop.prepare' },
      { id: 2, op: 'hello' },
    ]);
    bridge.receive({ id: 2, ok: true, version: 1 });
    bridge.receive({ id: 1, ok: false, error: 'not-desktop' });
    expect(await first).toEqual({ id: 1, ok: false, error: 'not-desktop' });
    expect(await second).toEqual({ id: 2, ok: true, version: 1 });
  });

  it('args cannot override the id or op', () => {
    const sent: unknown[] = [];
    const bridge = createBridge({ [BINDING]: (payload: string) => sent.push(JSON.parse(payload)) });
    void bridge.call('hello', { id: 99, op: 'desktop.wait' });
    expect(sent).toEqual([{ id: 1, op: 'hello' }]);
  });

  it('reports a missing bridge without waiting', async () => {
    const bridge = createBridge({});
    expect(bridge.available()).toBe(false);
    expect(await bridge.call('hello')).toEqual({ id: 0, ok: false, error: 'no-bridge' });
  });

  it('times out unanswered requests', async () => {
    const bridge = createBridge({ [BINDING]: () => {} });
    const pending = bridge.call('hello', {}, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ id: 1, ok: false, error: 'timeout' });
  });

  it('turns a throwing binding into an error kind', async () => {
    const bridge = createBridge({
      [BINDING]: () => {
        throw new TypeError('boom');
      },
    });
    expect(await bridge.call('hello')).toEqual({ id: 1, ok: false, error: 'TypeError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores junk and unknown ids, and close() answers what is pending', async () => {
    const bridge = createBridge({ [BINDING]: () => {} });
    const pending = bridge.call('hello');
    bridge.receive(null);
    bridge.receive({ id: '1', ok: true });
    bridge.receive({ id: 42, ok: true });
    bridge.close();
    expect(await pending).toEqual({ id: 1, ok: false, error: 'closed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
