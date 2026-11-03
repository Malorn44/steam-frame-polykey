// The built bundle (minified IIFE, as injected into Steam) installs itself into a separate window,
// and stays inert without Steam's objects. Built here with esbuild, evaluated in a jsdom window.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { SURFACE_ID } from '../src/host/steam/popup.js';
import { bundledBoot } from './boot.js';
import { fakePopupWindow, fakeSteam } from './fake-steam.js';

const bundle = async (): Promise<string> => {
  const result = await build({
    entryPoints: ['src/entry.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    define: { __POLYKEY_VERSION__: JSON.stringify('bundle-test') },
  });
  return result.outputFiles[0]!.text;
};

/** A window standing in for SharedJSContext; console output is dropped. */
const steamWindow = () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.console.log = () => {};
  dom.window.console.warn = () => {};
  return dom.window;
};

type Polykey = { version: string; state: string; uninstall(): void };

describe('built bundle', () => {
  it('installs into a Steam-like window and draws the box', async () => {
    const win = steamWindow();
    const popup = fakePopupWindow(win.document.implementation);
    Object.assign(win, fakeSteam({ popup }).g, { __polykeyBoot: bundledBoot() });
    win.eval(await bundle());
    const api = (win as unknown as { __polykey: Polykey }).__polykey;
    expect(api.version).toBe('bundle-test');
    expect(api.state).toBe('running');
    expect(popup.document.getElementById(SURFACE_ID)).not.toBeNull();
    api.uninstall();
    expect(popup.document.getElementById(SURFACE_ID)).toBeNull();
  });

  it('waits without Steam', async () => {
    const win = steamWindow();
    Object.assign(win, { __polykeyBoot: bundledBoot() });
    win.eval(await bundle());
    const api = (win as unknown as { __polykey: Polykey }).__polykey;
    expect(api.state).toBe('waiting');
    api.uninstall();
  });

  it('is small', async () => {
    expect((await bundle()).length).toBeLessThan(60 * 1024);
  });
});
