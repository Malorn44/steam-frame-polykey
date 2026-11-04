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
# Only touches ~/.local/share/polykey/ and ~/.config/systemd/user/polykey.service; the unit is
# started but not enabled at login. Host: $POLYKEY_HOST (default steamos@frame), key login needed.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${POLYKEY_HOST:-steamos@frame}"
APP=polykey
DEST=".local/share/$APP"
UNIT_DIR=".config/systemd/user"
SIDE="python3 -I -B -u ~/$DEST/sidecar/run.py"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)

mode=service
tail=1
for arg in "$@"; do
  case "$arg" in
    --fg) mode=fg ;;
    --no-tail) tail=0 ;;
    --stop) mode=stop ;;
    --probe) mode=probe ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

if [ "$mode" = stop ]; then
  echo "→ stopping $APP on $HOST"
  remote "systemctl --user stop $APP 2>/dev/null || true; if [ -f ~/$DEST/sidecar/run.py ]; then $SIDE uninstall; fi"
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
remote 'printf "  frame-jp-keyboard service: %s\n" "$(systemctl --user is-active frame-jp-keyboard 2>/dev/null || true)"
        if pgrep -f "/bin/framekeyboard( |$)" >/dev/null; then echo "  TaiKeid Full Keyboard: running"; else echo "  TaiKeid Full Keyboard: not running"; fi'

echo "→ copying to $HOST:~/$DEST/"
remote "mkdir -p ~/$DEST ~/$UNIT_DIR"
# speech/ holds the speech engine and models dictation downloaded: --delete must not remove them.
rsync -a --delete --exclude __pycache__ --exclude /speech/ -e "ssh ${SSH_OPTS[*]}" dist/stage/ "$HOST:$DEST/"
rsync -a -e "ssh ${SSH_OPTS[*]}" contrib/polykey.service "$HOST:$UNIT_DIR/$APP.service"
remote "systemctl --user daemon-reload"

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
