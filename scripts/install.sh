#!/bin/sh
# polykey installer for the Steam Frame: run it in Desktop Mode's Konsole, no sudo needed.
#
#   curl -fsSL https://github.com/Malorn44/steam-frame-polykey/releases/latest/download/install.sh | sh
#        install the latest release, or update to it, and start polykey now and at every login
#   sh install.sh --tarball polykey-1.2.3.tar.gz
#        install that tarball (a draft release, or one you downloaded) instead
#   sh install.sh --check        report what polykey needs on this machine; changes nothing
#   sh install.sh --rollback     go back to the release before this one (updates skip the one you
#                                left until a newer release)
#   sh install.sh --uninstall    remove polykey and restore Steam's keyboard; keeps your settings
#                                and dictation models (add --purge to remove those too)
#   --base URL                   read latest.json and the tarball beside it from URL, not GitHub
#
# Through a pipe, options go after `sh -s --`: curl -fsSL …/install.sh | sh -s -- --uninstall
# It only touches ~/.local/share/polykey/, ~/.config/systemd/user/polykey.service and, with --purge,
# ~/.config/polykey/. A release is checked against the key it was signed with (below) before it is
# unpacked; --tarball trusts the file you give it.
set -eu

BASE="https://github.com/Malorn44/steam-frame-polykey/releases/latest/download"
# The release key (contrib/allowed_signers), put in by the build.
ALLOWED_SIGNERS='@ALLOWED_SIGNERS@'
NAMESPACE=polykey-release
APP=polykey
DATA="$HOME/.local/share/$APP"  # where the unit runs it from (%h/.local/share/polykey/current)
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/$APP"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PY="${POLYKEY_PYTHON:-/usr/bin/python3}"  # the unit's interpreter (the variable is for tests)
DEBUGGER="http://127.0.0.1:8080/json/version"

say() { printf '%s\n' "$*"; }
die() { say "✗ $*" >&2; exit 1; }

# Nothing runs until the last line calls main, so a download cut short (curl … | sh) does nothing.

mode=install
tarball=""
version=""  # set by download(): the release latest.json names, which the tarball must hold
purge=0
parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) mode=check ;;
      --rollback) mode=rollback ;;
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      --tarball) tarball="${2:-}"; [ -n "$tarball" ] || die "--tarball needs a file"; shift ;;
      --base) BASE="${2:-}"; [ -n "$BASE" ] || die "--base needs a URL"; BASE="${BASE%/}"; shift ;;
      -h|--help) sed -n '2,18p' "$0" 2>/dev/null || say "see https://github.com/Malorn44/steam-frame-polykey"; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
  [ "$purge" = 0 ] || [ "$mode" = uninstall ] || die "--purge goes with --uninstall"
}

# --- what polykey needs ----------------------------------------------------------------------------

# Hard requirements fail the install; the rest are warnings. Prints a line for each.
check() {
  ok=1
  if found=$("$PY" -I -c 'import platform, sys, tarfile, aiohttp; sys.version_info >= (3, 10) and hasattr(tarfile, "data_filter") or sys.exit(1); print("python3", platform.python_version(), "with aiohttp", aiohttp.__version__)' 2>/dev/null); then
    say "✓ $found"
  else
    say "✗ python3 3.10.12 or newer with aiohttp at $PY: missing. SteamOS ships both."; ok=0
  fi
  if systemctl --user show-environment >/dev/null 2>&1; then
    say "✓ systemd user session"
  else
    say "✗ systemd user session: not reachable. Run this from your desktop session (Konsole)."; ok=0
  fi
  if command -v ssh-keygen >/dev/null 2>&1; then
    say "✓ ssh-keygen (checks release signatures)"
  else
    say "! ssh-keygen: missing. polykey cannot check releases, so it will not update itself."
  fi
  if "$PY" -I -c 'import ctypes; ctypes.CDLL("libanthy.so.0")' 2>/dev/null; then
    say "✓ libanthy (Japanese conversion)"
  else
    say "! libanthy.so.0: missing. The Japanese keyboards type kana but cannot convert to kanji."
  fi
  if "$PY" -I -c "import urllib.request; urllib.request.urlopen('$DEBUGGER', timeout=3)" 2>/dev/null; then
    say "✓ Steam's debugger on 127.0.0.1:8080"
  else
    say "! Steam's debugger is not answering on 127.0.0.1:8080; polykey draws through it. Turn on"
    say "  Steam → Settings → Developer → Enable CEF remote debugging (or check that Steam is running)."
  fi
  if systemctl --user is-active --quiet frame-jp-keyboard 2>/dev/null; then
    say "! frame-jp-keyboard is running: polykey stays out of the way while it is. To switch, stop it with"
    say "  systemctl --user disable --now frame-jp-keyboard"
  fi
  [ "$ok" = 1 ]
}

# --- helpers ---------------------------------------------------------------------------------------

work=""
cleanup() { [ -z "$work" ] || rm -rf "${work:?}"; }
trap cleanup EXIT
trap 'exit 130' INT TERM  # stop there (the EXIT trap cleans up), rather than carry on

fetch() {  # fetch URL FILE
  curl -fsSL --proto '=https,http' --retry 2 --max-time 300 -o "$2" "$1" || die "could not download $1"
}

# Download latest.json and its signature, check the signature, then the tarball beside them against
# the size and hash latest.json gives. Sets $tarball and $version.
download() {
  command -v curl >/dev/null 2>&1 || die "curl is needed to download polykey"
  command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is needed to check the download"
  say "→ reading $BASE/latest.json"
  fetch "$BASE/latest.json" "$work/latest.json"
  fetch "$BASE/latest.json.sig" "$work/latest.json.sig"
  printf '%s\n' "$ALLOWED_SIGNERS" > "$work/allowed_signers"
  ssh-keygen -Y verify -f "$work/allowed_signers" -I "$NAMESPACE" -n "$NAMESPACE" \
    -s "$work/latest.json.sig" < "$work/latest.json" >/dev/null 2>&1 \
    || die "latest.json is not signed by the polykey release key; nothing was installed"
  # The release key signed it: read the fields, and keep the version to what a URL and a path can hold.
  fields=$("$PY" -I -c 'import json, sys; m = json.load(open(sys.argv[1])); print(m["version"], m["size"], m["sha256"])' \
    "$work/latest.json" 2>/dev/null) || die "latest.json is not a polykey release manifest"
  read -r version size sha256 <<EOF
$fields
EOF
  case "$version" in "" | [!0-9]* | *[!0-9A-Za-z.-]*) die "latest.json is not a polykey release manifest" ;; esac
  say "→ downloading polykey $version"
  tarball="$work/polykey-$version.tar.gz"
  fetch "$BASE/polykey-$version.tar.gz" "$tarball"
  [ "$(wc -c < "$tarball" | tr -d ' ')" = "$size" ] || die "the download is the wrong size; nothing was installed"
  [ "$(sha256sum "$tarball" | cut -d' ' -f1)" = "$sha256" ] || die "the download does not match its sha256; nothing was installed"
}

restart() {
  systemctl --user daemon-reload
  systemctl --user restart "$APP"
  sleep 2
  if systemctl --user is-active --quiet "$APP"; then
    say "✓ polykey is running; it starts with your session from now on"
  else
    say "! the service did not stay up; see: journalctl --user -u $APP -n 30"
  fi
}

# --- commands --------------------------------------------------------------------------------------

rollback() {
  [ -f "$DATA/current/sidecar/run.py" ] || die "polykey is not installed"
  # The current release's own code does it; if that cannot run, an earlier release's tarball still can.
  "$PY" -I -B "$DATA/current/sidecar/run.py" rollback \
    || die "could not roll back; to go back by hand, install an earlier release's tarball (from https://github.com/Malorn44/steam-frame-polykey/releases): sh install.sh --tarball polykey-X.Y.Z.tar.gz"
  restart
}

uninstall() {
  say "→ stopping polykey (Steam's own keyboard comes back)"
  systemctl --user disable --now "$APP" >/dev/null 2>&1 || true
  rm -f "${UNIT_DIR:?}/${APP:?}.service"
  systemctl --user daemon-reload 2>/dev/null || true
  if [ "$purge" = 1 ]; then
    rm -rf "${DATA:?}" "${CONFIG:?}"
    say "✓ removed polykey, its settings and dictation models"
  else
    [ ! -d "$DATA" ] || find "$DATA" -mindepth 1 -maxdepth 1 ! -name speech -exec rm -rf {} +
    say "✓ removed polykey; settings ($CONFIG) and dictation models ($DATA/speech) stay"
    say "  (sh install.sh --uninstall --purge removes them too)"
  fi
}

install() {
  say "polykey installer"
  check || die "fix what is marked ✗, then run this again (sh install.sh --check reports the same)"
  work=$(mktemp -d)
  if [ -n "$tarball" ]; then
    [ -f "$tarball" ] || die "no such file: $tarball"
    say "→ installing polykey from $tarball"
  else
    download
  fi

  # The release's own run.py unpacks it into versions/ and switches to it, under the lock the updater
  # takes too; a release already there is unpacked afresh, which repairs it. Here the tarball is
  # unpacked only to find that run.py.
  mkdir "$work/unpacked"
  tar -xzf "$tarball" -C "$work/unpacked" --no-same-owner 2>/dev/null || die "$tarball is not a polykey release tarball"
  set -- "$work"/unpacked/polykey-*/sidecar/run.py
  [ -f "$1" ] || die "$tarball is not a polykey release tarball"
  # The switch first: if it fails, nothing else has changed.
  version=$("$PY" -I -B "$1" unpack "$tarball" --root "$DATA" ${version:+--version "$version"}) || die "could not install polykey"
  mkdir -p "$UNIT_DIR"
  cp "$DATA/versions/$version/polykey.service" "$UNIT_DIR/$APP.service"
  systemctl --user daemon-reload
  systemctl --user enable "$APP" >/dev/null 2>&1 || say "! could not enable $APP at login"
  say "✓ polykey $version installed in $DATA/versions/$version"
  restart
  say "  Open any text field: the keyboard is polykey's. Settings: the ⚙ key on its toolbar."
}

main() {
  parse "$@"
  case "$mode" in
    check)
      if check; then say "polykey can run here."; exit 0; fi
      say "polykey cannot run here yet (see ✗ above)."
      exit 1 ;;
    rollback) rollback ;;
    uninstall) uninstall ;;
    *) install ;;
  esac
}

main "$@"
