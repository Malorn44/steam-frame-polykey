import { describe, expect, it } from 'vitest';
import { getKeyboardPopupWindow, pickKeyboardManager } from '../../../src/host/steam/globals.js';
import { otherKeyboards, fjkActive } from '../../../src/host/steam/others.js';
import { missingPrerequisites, REQUIRED } from '../../../src/host/steam/probe.js';
import { fakeManager, fakeSteam } from '../../fake-steam.js';

describe('missingPrerequisites', () => {
  it('is empty when every required object exists', () => {
    expect(missingPrerequisites(fakeSteam().g)).toEqual([]);
  });

  it('names each missing object', () => {
    expect(missingPrerequisites({})).toEqual([REQUIRED.popupManager, REQUIRED.keyboardManager]);
    expect(missingPrerequisites(fakeSteam({ popupManager: false }).g)).toEqual([REQUIRED.popupManager]);
    expect(missingPrerequisites(fakeSteam({ managers: [] }).g)).toEqual([REQUIRED.keyboardManager]);
  });

  it('survives getters that throw', () => {
    const g = {};
    Object.defineProperty(g, 'SteamUIStore', { get: () => { throw new Error('TDZ'); } });
    expect(missingPrerequisites(g)).toEqual([REQUIRED.popupManager, REQUIRED.keyboardManager]);
  });
});

describe('pickKeyboardManager', () => {
  it('prefers the manager the VR keyboard is typing for', () => {
    const plain = fakeManager();
    const typingFor = fakeManager(true);
    expect(pickKeyboardManager(fakeSteam({ managers: [plain, typingFor] }).g)).toBe(typingFor);
  });

  it('falls back to the first manager, or null', () => {
    const first = fakeManager();
    expect(pickKeyboardManager(fakeSteam({ managers: [first, fakeManager()] }).g)).toBe(first);
    expect(pickKeyboardManager(fakeSteam({ managers: [] }).g)).toBeNull();
  });
});

describe('getKeyboardPopupWindow', () => {
  const win = { document: {}, closed: false, innerWidth: 854, innerHeight: 280 };

  it('returns the popup window, or null when absent or closed', () => {
    expect(getKeyboardPopupWindow(fakeSteam({ popup: win as never }).g)).toBe(win);
    expect(getKeyboardPopupWindow(fakeSteam().g)).toBeNull();
    expect(getKeyboardPopupWindow(fakeSteam({ popup: { ...win, closed: true } as never }).g)).toBeNull();
  });

  it('returns null when the lookup throws', () => {
    const g = { g_PopupManager: { GetPopupForVROverlayKey: () => { throw new Error('boom'); } } };
    expect(getKeyboardPopupWindow(g)).toBeNull();
  });
});

describe('other keyboards', () => {
  it('detects an active frame-jp-keyboard', () => {
    expect(fjkActive({ __fjk: { state: 'running', enabled: true } })).toBe(true);
    expect(fjkActive({ __fjk: { state: 'waiting', enabled: true } })).toBe(true);
  });

  it('ignores fjk when uninstalled, failed or disabled', () => {
    expect(fjkActive({})).toBe(false);
    expect(fjkActive({ __fjk: { state: 'uninstalled', enabled: true } })).toBe(false);
    expect(fjkActive({ __fjk: { state: 'failed' } })).toBe(false);
    expect(fjkActive({ __fjk: { state: 'running', enabled: false } })).toBe(false);
  });

  it('describes fjk and TaiKeid hooks without throwing', () => {
    const found = otherKeyboards({ __fjk: { version: '0.9.3', state: 'running', enabled: true }, __fullKeyboardNativeV1: {} });
    expect(found).toEqual(['frame-jp-keyboard 0.9.3 (state=running, enabled=true)', 'TaiKeid Full Keyboard replacement hooks']);
  });
});
