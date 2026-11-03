# polykey

A modular on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and sends text through Steam's own key entry point, so it works wherever Steam's keyboard appears.

**Status: milestone 1 spike.** Two test boxes in Steam's keyboard popup:
- **polykey → テスト** sends text through `HandleVirtualKeyDown`. This works in Steam UI fields and in apps gamescope runs directly.
- **📋 → テスト** pastes through the KDE desktop's clipboard with Shift+Insert, then restores the clipboard. This is for Desktop Mode, where sent text arrives as `123`.

> Unofficial; not affiliated with Valve. It relies on private Steam internals. When a required Steam object is missing, it does nothing and leaves the stock keyboard alone.

## Develop (WSL)

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install aiohttp==3.9.3 pytest   # aiohttp matches the Frame
npm run check        # typecheck, vitest, pytest, build
```

## Deploy to the Frame

This needs key login (`ssh-copy-id steamos@frame`). It only touches `~/.local/share/polykey/` and `~/.config/systemd/user/polykey.service`. The service is started but not enabled at login.

```sh
scripts/deploy.sh            # build, copy, restart the service, follow the log
scripts/deploy.sh --fg       # run the sidecar in the foreground; Ctrl-C removes polykey from Steam
scripts/deploy.sh --probe    # read-only report of the Steam objects polykey uses
scripts/deploy.sh --stop     # stop and remove polykey from Steam
```

Set `POLYKEY_HOST` to use another host than `steamos@frame`. polykey won't draw while frame-jp-keyboard is active; stop it first.

Debug from the CDP console (`ssh -L 8080:127.0.0.1:8080 steamos@frame`, then `localhost:8080` → SharedJSContext):

```js
__polykey.debug.status()
__polykey.debug.split('chars')              // text split: 'auto' | 'run' | 'chars'
__polykey.debug.pasteChord('ctrl-shift-v')  // 'shift-insert' | 'ctrl-v' | 'ctrl-shift-v'
await __polykey.debug.tap('paste')          // tap a box without the laser
```

## Layout

```
src/core/       pure logic: output planning, key chords
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/spike.ts    the spike (bundle entry: spike-entry.ts; read-only report: probe.ts)
sidecar/        Python sidecar: CDP injector, bridge, Desktop Mode clipboard (Wayland)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs, deploy.sh
contrib/        polykey.service
```
