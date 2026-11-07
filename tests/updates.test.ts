import { describe, expect, it } from 'vitest';
import type { BridgeReply } from '../src/bridge/client.js';
import { createUpdates, parseUpdate, updateSummary, type UpdateStatus } from '../src/updates.js';

const S: UpdateStatus = { rev: 1, dev: false, state: 'idle', latest: null, available: false, skipped: false };
const labels = (s: UpdateStatus | null) => updateSummary(s).actions.map((a) => a.label);

describe('updates: the line under the version', () => {
  it('says what the updater found and offers what fits', () => {
    expect(updateSummary(null)).toEqual({ text: '', actions: [] });
    expect(updateSummary(S).text).toBe('');
    expect(labels(S)).toEqual(['Check for updates']);
    expect(updateSummary({ ...S, latest: '0.1.0' }).text).toBe('Up to date');
    expect(updateSummary({ ...S, latest: '0.2.0', available: true }).text).toBe('0.2.0 is available');
    expect(labels({ ...S, latest: '0.2.0', available: true, previous: '0.0.9' })).toEqual(['Install 0.2.0', 'Back to 0.0.9']);
    expect(updateSummary({ ...S, latest: '0.2.0', available: true, skipped: true }).text).toBe('0.2.0 is available (you went back from it)');
  });

  it('shows progress and offers nothing while something runs', () => {
    expect(updateSummary({ ...S, state: 'checking' })).toEqual({ text: 'Checking for updates…', actions: [] });
    expect(updateSummary({ ...S, state: 'downloading', latest: '0.2.0', done: 1, total: 3 }).text).toBe('Downloading 0.2.0… 33%');
    expect(updateSummary({ ...S, state: 'installing', latest: '0.2.0' }).text).toBe('Installing 0.2.0…');
    expect(updateSummary({ ...S, state: 'restarting' }).text).toBe('Restarting polykey…');
  });

  it('an installed release waits for the keyboard to close, or restarts now, or stays on the running one', () => {
    const installed: UpdateStatus = { ...S, state: 'installed', latest: '0.2.0', available: true };
    expect(updateSummary(installed)).toEqual({
      text: '0.2.0 is installed; it starts when the keyboard closes', actions: [{ action: 'install', label: 'Restart now' }],
    });
    // previous is then the release still running (0.1.0): going back keeps it, so the button says so.
    expect(updateSummary({ ...installed, previous: '0.1.0' }).actions).toEqual([
      { action: 'install', label: 'Restart now' }, { action: 'rollback', label: 'Stay on 0.1.0' }]);
  });

  it('explains a failure in words, and a dev build', () => {
    expect(updateSummary({ ...S, error: 'bad-signature' }).text).toBe('The latest release isn\'t signed with polykey\'s key, so it wasn\'t installed');
    expect(updateSummary({ ...S, error: 'weird' }).text).toBe('Update failed (weird)');
    expect(labels({ ...S, error: 'network' })).toEqual(['Check for updates']);
    expect(updateSummary({ ...S, error: 'busy' }).text).toBe('Another install or update of polykey is under way; try again in a minute');
    const dev = { ...S, dev: true, latest: '0.2.0', previous: '0.2.0' };
    expect(updateSummary(dev).text).toBe('Dev build: no updates · latest release 0.2.0');
    expect(labels(dev)).toEqual(['Check for updates', 'Use release 0.2.0']);
  });

  it('reads only well-formed replies', () => {
    expect(parseUpdate({ id: 1, ok: true, rev: 2, version: '0.1.0', state: 'idle', latest: '0.2.0', available: true }))
      .toEqual({ ...S, rev: 2, latest: '0.2.0', available: true });
    expect(parseUpdate({ id: 1, ok: true, rev: 2, version: '0.1.0', state: 'exploding' })).toBeNull();
    expect(parseUpdate({ id: 1, ok: true, rev: 3, version: '0.1.0', state: 'installed', latest: '0.2.0', available: true }))
      .toEqual({ ...S, rev: 3, state: 'installed', latest: '0.2.0', available: true });
    expect(parseUpdate({ id: 1, ok: false, error: 'unavailable' })).toBeNull();
  });
});

describe('updates: following the updater', () => {
  const reply = (fields: Partial<UpdateStatus>): BridgeReply => ({ id: 1, ok: true, ...S, ...fields });

  it('asks once when idle, and keeps asking while something runs', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const answers = [reply({ rev: 5, state: 'downloading', latest: '0.2.0' }), reply({ rev: 6, state: 'restarting' }), reply({ rev: 7 })];
    const seen: UpdateStatus[] = [];
    const updates = createUpdates({
      call: async (op, args) => { calls.push([op, args]); return answers.shift() ?? reply({ rev: 9 }); },
      active: () => true, onStatus: (s) => seen.push(s), warn: () => {},
    });
    updates.follow();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([['update.status', {}], ['update.status', { since: 5, timeoutMs: 15000 }], ['update.status', { since: 6, timeoutMs: 15000 }]]);
    expect(seen.map((s) => s.state)).toEqual(['downloading', 'restarting', 'idle']);
  });

  it('install names the release the last status offered', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const updates = createUpdates({
      call: async (op, args) => { calls.push([op, args]); return reply({ latest: '0.2.0', available: true }); },
      active: () => true, onStatus: () => {}, warn: () => {},
    });
    updates.follow();
    await new Promise((r) => setTimeout(r, 0));
    updates.run('install');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[1]).toEqual(['update.install', { version: '0.2.0' }]);
  });

  it('Restart now asks for the waiting release by name', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let shown = true;
    const updates = createUpdates({
      call: async (op, args) => { calls.push([op, args]); return reply({ state: 'installed', latest: '0.2.0', available: true }); },
      active: () => shown, onStatus: () => { shown = false; }, warn: () => {}, // the page closes after the first answer
    });
    updates.follow();
    await new Promise((r) => setTimeout(r, 0));
    expect(updateSummary(updates.status).actions).toEqual([{ action: 'install', label: 'Restart now' }]);
    updates.run('install');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([['update.status', {}], ['update.install', { version: '0.2.0' }]]);
  });

  it('asks nothing while the line is not on screen', () => {
    let asked = 0;
    createUpdates({ call: async () => { asked++; return reply({}); }, active: () => false, onStatus: () => {}, warn: () => {} }).follow();
    expect(asked).toBe(0);
  });
});
