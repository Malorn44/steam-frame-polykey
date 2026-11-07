# Developing polykey

How to build and check polykey, try it on a Frame, and find your way around the source.

## Set up (WSL)

```sh
npm install
npm ci --prefix tools/eslint   # ESLint on its own TypeScript 6; the project builds with TypeScript 7
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # aiohttp matches the Frame
npm run check        # lint (ESLint, ruff, shellcheck, actionlint), typecheck, vitest, pytest, build
npm run test:install # install.sh end to end: throwaway signed releases, served from localhost
```

## Deploy to the Frame

This needs key login (`ssh-copy-id steamos@frame`). It only touches `~/.local/share/polykey/` and `~/.config/systemd/user/polykey.service`. The service is started but not enabled at login. A deploy goes to `~/.local/share/polykey/dev/`, marked as a dev build by a `DEV` file, and points `current` (the link the service runs) at it. A dev build sends the page's console lines to the journal; a release keeps them out unless `"console": true` is in `~/.config/polykey/settings.json`. Releases installed beside it stay in `versions/<version>/`; `sh ~/.local/share/polykey/current/install.sh --rollback` goes back to the newest one.

```sh
scripts/deploy.sh            # build, copy, restart the service, follow the log
scripts/deploy.sh --fg       # run the sidecar in the foreground; Ctrl-C removes polykey from Steam
scripts/deploy.sh --probe    # read-only report of the Steam objects polykey uses
scripts/deploy.sh --stop     # stop and remove polykey from Steam
```

Set `POLYKEY_HOST` to use another host than `steamos@frame`. polykey won't draw while frame-jp-keyboard is active; stop it first.

## Debug

Debug from the CDP console (`ssh -L 8080:127.0.0.1:8080 steamos@frame`, then `localhost:8080` → SharedJSContext):

```js
__polykey.debug.status()
__polykey.debug.use('steam/stock')   // or 'en/english'
```

## Source layout

```
src/core/       pure logic: catalog types, key handling, key codes, output planning
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/main.ts     wiring (bundle entry: entry.ts; read-only report: probe.ts)
src/ui/         the keyboard as DOM
packs/          bundled layouts, keyboards, themes; schema/ their JSON Schema
sidecar/        Python sidecar: CDP injector, bridge, updater, Desktop Mode clipboard (Wayland), speech/ (dictation)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs (and css-minify.mjs, its CSS minification), deploy.sh, release.sh, install.sh
contrib/        polykey.service
```
