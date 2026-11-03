import { describe, expect, it } from 'vitest';
import { classifyTarget, describeStatus, findStatusStore, keyboardMode, readStatus } from '../../../src/host/steam/diag.js';
import { BUFFERED, MINIMAL, STREAMED, fakeWebpack } from '../../fake-steam.js';

describe('findStatusStore', () => {
  it('finds the store through the webpack chunk registry', () => {
    const store = findStatusStore({ webpackChunksteamui: fakeWebpack(() => MINIMAL) });
    expect(readStatus(store)).toEqual(MINIMAL);
  });

  it('returns null without a registry or a matching module', () => {
    expect(findStatusStore({})).toBeNull();
    const noMatch = { push: (chunk: [unknown, unknown, (r: unknown) => void]) => chunk[2](Object.assign(() => ({}), { m: { 1: () => 'x' } })) };
    expect(findStatusStore({ webpackChunksteamui: noMatch })).toBeNull();
  });

  it('returns null when the registry throws', () => {
    expect(findStatusStore({ webpackChunksteamui: { push: () => { throw new Error('boom'); } } })).toBeNull();
  });
});

describe('keyboardMode', () => {
  it('reads buffered and minimal mode only while open', () => {
    expect(keyboardMode(MINIMAL)).toBe('minimal');
    expect(keyboardMode(BUFFERED)).toBe('buffered');
    expect(keyboardMode({ ...MINIMAL, bIsOpen: false })).toBe('unknown');
    expect(keyboardMode(null)).toBe('unknown');
  });
});

describe('classifyTarget', () => {
  it('classifies streamed games, local apps and Steam UI', () => {
    expect(classifyTarget(STREAMED)).toBe('streamed');
    expect(classifyTarget(MINIMAL)).toBe('local-app');
    expect(classifyTarget(BUFFERED)).toBe('steam-ui');
    expect(classifyTarget({ sOverlayKey: 'something.else' })).toBe('unknown');
    expect(classifyTarget(null)).toBe('unknown');
  });

  it('ignores dispatch-to-SteamVR (seen on the Frame for Steam library search)', () => {
    expect(classifyTarget({ ...BUFFERED, bMinimal: true, bDispatchEventsToSteamVR: true })).toBe('steam-ui');
  });

  it('does not classify a closed keyboard (seen on the Frame: closed status says dispatchToSteamVR=true)', () => {
    expect(classifyTarget({ bIsOpen: false, bMinimal: false, sOverlayKey: '', bDispatchEventsToSteamVR: true })).toBe('unknown');
  });
});

describe('describeStatus', () => {
  it('logs only whitelisted fields', () => {
    const line = describeStatus({ ...STREAMED, unAppID: 438100, sTypedText: 'secret' } as never);
    expect(line).toBe(
      'open=true mode=minimal target=streamed overlay=steamlink_openvr-overlay app=438100 dispatchToSteamVR=true',
    );
    expect(line).not.toContain('secret');
  });

  it('says when the status is unavailable', () => {
    expect(describeStatus(null)).toBe('status=unavailable');
  });
});
