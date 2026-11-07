# Developing polykey

How to build and check polykey, try it on a Frame, release it, and find your way around the source.

## Set up (WSL)

```sh
npm install
npm ci --prefix tools/eslint   # ESLint on its own TypeScript 6; the project builds with TypeScript 7
python3 -m venv --upgrade-deps .venv && .venv/bin/pip install --group dev   # pip 25.1+; aiohttp matches the Frame
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

## Releasing

Each merge to main updates release-please's release PR, which holds the next version and its changelog. Merging that PR has CI tag the release, build a draft and check it against a second build. Once you have smoke-tested the draft on a Frame and approved it in GitHub, CI signs and publishes it, and installed copies pick it up at their next hourly check. [RELEASING.md](RELEASING.md) has the details.

## Source layout

```
src/core/       pure logic: catalog types, key handling, key codes, output planning
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/main.ts     wiring (bundle entry: entry.ts; read-only report: probe.ts)
                dictation.ts, updates.ts: the page side of dictation and of the updater
src/ui/         the keyboard as DOM
packs/          bundled layouts, keyboards, themes; pack.schema.json, their JSON Schema
sidecar/        Python sidecar: CDP injector, bridge, updater, Desktop Mode clipboard (Wayland), speech/ (dictation)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs (and css-minify.mjs, its CSS minification; version.mjs, its version), deploy.sh, install.sh,
                release.sh, test-layout.sh; make-*.py rebuild the word list, blocklist and emoji data
contrib/        polykey.service; allowed_signers, the release key
```
