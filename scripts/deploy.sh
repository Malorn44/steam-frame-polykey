#!/usr/bin/env bash
# Build polykey, copy it to the Frame, re-inject, and follow the log. Run from WSL.
#
#   scripts/deploy.sh            check (npm run check: types, tests, build), copy, restart the user
#                                service, follow its journal; a failing check deploys nothing
#   scripts/deploy.sh --fg       build, copy, run the sidecar in the foreground over ssh (Ctrl-C stops
#                                it and removes polykey from Steam)
#   scripts/deploy.sh --no-tail  as the default, without following the journal
#   scripts/deploy.sh --stop     stop the service and remove polykey from Steam
#   scripts/deploy.sh --probe    read-only report of the Steam objects polykey uses
#
# The build goes to ~/.local/share/polykey/dev/ with a DEV marker, and `current` is pointed at it.
# The DEV marker makes it a dev build: the page's console lines go to the journal.
# Installed releases in versions/ stay as they are; to go back to the newest one:
#   sh ~/.local/share/polykey/current/install.sh --rollback
# Only touches ~/.local/share/polykey/ and ~/.config/systemd/user/polykey.service; the unit is
# started but not enabled at login. Host: $POLYKEY_HOST (default steamos@frame), key login needed.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${POLYKEY_HOST:-steamos@frame}"
APP=polykey
DEST=".local/share/$APP"
UNIT_DIR=".config/systemd/user"
SIDE="python3 -I -B -u ~/$DEST/current/sidecar/run.py"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)

mode=service
tail=1
for arg in "$@"; do
  case "$arg" in
    --fg) mode="fg" ;;
    --no-tail) tail=0 ;;
    --stop) mode=stop ;;
    --probe) mode=probe ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The commands are built here on purpose (local values like $DEST expand before ssh).
# shellcheck disable=SC2029
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

if [ "$mode" = stop ]; then
  echo "→ stopping $APP on $HOST"
  remote "systemctl --user stop $APP 2>/dev/null || true; if [ -f ~/$DEST/current/sidecar/run.py ]; then $SIDE uninstall; fi"
  exit 0
fi

if [ "$mode" = probe ]; then
  remote "$SIDE probe"
  exit $?
fi

# Nothing goes to the Frame unless the full check passes (typecheck, vitest, pytest, build).
echo "→ checking and building"
if ! npm run --silent check >/tmp/polykey-check.log 2>&1; then
  grep -E "error|×|FAILED|Error" /tmp/polykey-check.log | head -20 >&2
  echo "✗ check failed; not deployed (full log: /tmp/polykey-check.log)" >&2
  exit 1
fi

echo "→ other keyboards on $HOST (read-only)"
# shellcheck disable=SC2016  # expands on the Frame
remote 'printf "  frame-jp-keyboard service: %s\n" "$(systemctl --user is-active frame-jp-keyboard 2>/dev/null || true)"
        if pgrep -f "/bin/framekeyboard( |$)" >/dev/null; then echo "  TaiKeid Full Keyboard: running"; else echo "  TaiKeid Full Keyboard: not running"; fi'

echo "→ copying to $HOST:~/$DEST/dev/"
# Before releases, a deploy filled ~/.local/share/polykey/ itself: those files go (never speech/, the
# engine and models dictation downloaded, or versions/).
remote "mkdir -p ~/$DEST/dev ~/$UNIT_DIR && cd ~/$DEST && if [ -d sidecar ] && [ ! -L sidecar ]; then rm -rf bundle.js probe.js VERSION sidecar packs schema; fi"
rsync -a --delete --exclude __pycache__ -e "ssh ${SSH_OPTS[*]}" dist/stage/ "$HOST:$DEST/dev/"
rsync -a -e "ssh ${SSH_OPTS[*]}" contrib/polykey.service "$HOST:$UNIT_DIR/$APP.service"
# `current` is swapped in one rename, as run.py activate does: it never goes missing.
remote "touch ~/$DEST/dev/DEV && ln -sfn dev ~/$DEST/.current.new && mv -fT ~/$DEST/.current.new ~/$DEST/current && systemctl --user daemon-reload"

if [ "$mode" = fg ]; then
  echo "→ running in the foreground (Ctrl-C stops it and removes polykey from Steam)"
  remote "systemctl --user stop $APP 2>/dev/null || true"
  exec ssh -t "${SSH_OPTS[@]}" "$HOST" "$SIDE run"
fi

echo "→ restarting $APP (re-injects; not enabled at login)"
remote "systemctl --user restart $APP"
if [ "$tail" = 1 ]; then
  echo "→ following the log (Ctrl-C stops following; the service keeps running)"
  exec ssh -t "${SSH_OPTS[@]}" "$HOST" "journalctl --user -u $APP -f -n 30 -o cat"
fi
