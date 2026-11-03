# polykey

A modular on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and sends text through Steam's own key entry point, so it works wherever Steam's keyboard appears.

**Status: milestone 2.** A full English keyboard drawn over Steam's keyboard popup:
- **Keys:** the number row with an Fn layer (Esc, F1–F12), sticky Ctrl, Alt, Frame (Super) and Fn, and full arrows.
- **Toolbar:** settings, emoji, dictate, copy, cut and paste.
- **🌐** switches keyboards; Steam's own keyboard is one of them.

Layouts, keyboards and themes are JSON packs (`packs/`, `schema/pack.schema.json`). A user pack in `~/.config/polykey/packs/<namespace>/` replaces a bundled item with the same id. KDE Desktop Mode gets non-ASCII text by paste.

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
__polykey.debug.use('steam/stock')   // or 'en/english'
```

## Layout

```
src/core/       pure logic: catalog types, key handling, key codes, output planning
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/main.ts     wiring (bundle entry: entry.ts; read-only report: probe.ts)
src/ui/         the keyboard as DOM
packs/          bundled layouts, keyboards, themes; schema/ their JSON Schema
sidecar/        Python sidecar: CDP injector, bridge, Desktop Mode clipboard (Wayland)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs, deploy.sh
contrib/        polykey.service
```
