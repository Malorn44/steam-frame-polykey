#!/usr/bin/env bash
# The installer's life, end to end, in a throwaway home: two releases signed with a throwaway key and
# served from localhost, a stub systemctl, and the venv's python3 (it has aiohttp, as SteamOS does).
#
#   bash tests/install/test-install.sh     (npm run test:install; CI runs it on every push)
#
# The checks are strings that expect() evaluates later, so they stay in single quotes.
# shellcheck disable=SC2016,SC2034
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
PYTHON="${POLYKEY_TEST_PYTHON:-$REPO/.venv/bin/python}"

T=$(mktemp -d)
server=""
cleanup() { [ -z "$server" ] || kill "$server" 2>/dev/null || true; rm -rf "${T:?}"; }
trap cleanup EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); printf '  ✓ %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf '  ✗ %s\n' "$1"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }  # expect "what" 'test'

# --- two signed releases, served from localhost --------------------------------------------------

ssh-keygen -q -t ed25519 -N '' -C polykey-test -f "$T/key"
printf 'polykey-release namespaces="polykey-release" %s\n' "$(cut -d' ' -f1,2 "$T/key.pub")" > "$T/allowed_signers"
port=$("$PYTHON" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
mkdir -p "$T/serve"
release() {  # release VERSION DIR: build, sign and serve a release under /DIR
  POLYKEY_ALLOWED_SIGNERS="$T/allowed_signers" SOURCE_DATE_EPOCH=1700000000 \
    scripts/release.sh "$1" >/dev/null
  rm -rf "${T:?}/serve/$2"
  cp -R dist/release "$T/serve/$2"
  sign "$T/serve/$2"
}
sign() {  # sign DIR: DIR/latest.json.sig, with the throwaway key
  rm -f "$1/latest.json.sig"
  ssh-keygen -q -Y sign -f "$T/key" -n polykey-release "$1/latest.json"
}
echo "building releases"
release 0.1.0 r1
release 0.2.0 r2
first=$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d' ' -f1)
release 0.1.0 r1
expect "release.sh makes the same tarball twice" '[ "$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d" " -f1)" = "$first" ]'
printf '# no key yet\n' > "$T/no_signers"
expect "a release build refuses an allowed_signers without a release key, and leaves dist/ alone" \
  '! POLYKEY_ALLOWED_SIGNERS="$T/no_signers" scripts/release.sh 0.3.0 > "$T/out" 2>&1 && grep -q "no release key" "$T/out" && [ "$(cat dist/stage/VERSION)" = 0.1.0 ] && [ -f dist/release/polykey-0.1.0.tar.gz ]'
tar -tzvf "$T/serve/r1/polykey-0.1.0.tar.gz" > "$T/listing"
expect "the tarball holds polykey-0.1.0/ only, owned by 0/0, modes 644, 755 or dirs 755" \
  'awk "\$2 != \"0/0\" || \$6 !~ /^polykey-0\\.1\\.0\\// || \$1 !~ /^(-rw-r--r--|-rwxr-xr-x|drwxr-xr-x)\$/ { bad = 1 } END { exit bad }" "$T/listing"'
mkdir "$T/unpacked"
tar -xzf "$T/serve/r1/polykey-0.1.0.tar.gz" -C "$T/unpacked"
R="$T/unpacked/polykey-0.1.0"
expect "it carries the licences, the unit, the release key and the installer with the key in it" \
  'cmp -s LICENSE "$R/LICENSE" && cmp -s docs/THIRD-PARTY-NOTICES.md "$R/docs/THIRD-PARTY-NOTICES.md" && cmp -s contrib/polykey.service "$R/polykey.service" && cmp -s "$T/allowed_signers" "$R/allowed_signers" && grep -qF "$(cut -d" " -f3,4 "$T/allowed_signers")" "$R/install.sh" && [ -x "$R/install.sh" ] && cmp -s "$R/install.sh" "$T/serve/r1/install.sh"'
expect "and the code: VERSION, the bundle, the sidecar, the packs" \
  '[ "$(cat "$R/VERSION")" = 0.1.0 ] && [ -s "$R/bundle.js" ] && [ -f "$R/sidecar/run.py" ] && [ -d "$R/packs" ] && [ -d "$R/schema" ] && ! find "$R" -name __pycache__ | grep -q .'
tarball_sha=$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d' ' -f1)
expect "latest.json names the release and the tarball's size and sha256" \
  '"$PYTHON" -I -c "import json, sys; m = json.load(open(sys.argv[1])); sys.exit(m != {\"format\": 1, \"version\": \"0.1.0\", \"size\": int(sys.argv[2]), \"sha256\": sys.argv[3]})" "$T/serve/r1/latest.json" "$(stat -c %s "$T/serve/r1/polykey-0.1.0.tar.gz")" "$tarball_sha"'

(cd "$T/serve" && exec "$PYTHON" -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; sleep 0.1; done

# A manifest edited after it was signed, a tarball swapped under a signed manifest, and a signed
# version that would leave versions/.
cp -R "$T/serve/r2" "$T/serve/tampered"
sed -i 's/"size": [0-9]*/"size": 1/' "$T/serve/tampered/latest.json"
cp -R "$T/serve/r2" "$T/serve/swapped"
cp "$T/serve/r1/polykey-0.1.0.tar.gz" "$T/serve/swapped/polykey-0.2.0.tar.gz"
sed -i "s/\"size\": [0-9]*/\"size\": $(stat -c %s "$T/serve/swapped/polykey-0.2.0.tar.gz")/" "$T/serve/swapped/latest.json"
sign "$T/serve/swapped"
cp -R "$T/serve/r2" "$T/serve/climbs"
sed -i 's,"version": "0.2.0","version": "0.2.0/../..",' "$T/serve/climbs/latest.json"
sign "$T/serve/climbs"

# --- a Frame-like home ---------------------------------------------------------------------------

export HOME="$T/home"
unset XDG_CONFIG_HOME XDG_DATA_HOME
mkdir -p "$HOME" "$T/bin"
cat > "$T/bin/systemctl" <<'EOF'
#!/bin/sh
echo "$*" >> "$HOME/systemctl.log"
case "$*" in
  *is-active*frame-jp-keyboard*) exit 3 ;;
esac
exit 0
EOF
chmod +x "$T/bin/systemctl"
export PATH="$T/bin:$PATH" POLYKEY_PYTHON="$PYTHON"
DATA="$HOME/.local/share/polykey"
INSTALL="$T/serve/r2/install.sh"
run() { sh "$INSTALL" "$@" > "$T/out" 2>&1; }
current() { readlink "$DATA/current" 2>/dev/null || echo none; }
state() { cat "$DATA/updates/state.json" 2>/dev/null || echo '{}'; }

echo "installer"
expect "--check passes and reports python and aiohttp" 'run --check && grep -q "^✓ python3 3\.[0-9.]* with aiohttp [0-9]" "$T/out"'
expect "--check changes nothing" '[ ! -e "$DATA" ]'

# The layout dev deploys used before releases.
mkdir -p "$DATA/sidecar" "$DATA/speech/models" "$HOME/.config/polykey"
touch "$DATA/bundle.js" "$DATA/speech/models/m.gguf"
echo '{"theme": "themes/nord"}' > "$HOME/.config/polykey/settings.json"

expect "installs the latest release" 'run --base "http://127.0.0.1:$port/r1" && [ "$(current)" = versions/0.1.0 ]'
expect "the unit runs current/ and is enabled and restarted" \
  'grep -q "polykey/current/sidecar/run.py" "$HOME/.config/systemd/user/polykey.service" && grep -q "enable polykey" "$HOME/systemctl.log" && grep -q "restart polykey" "$HOME/systemctl.log"'
expect "files from before releases are gone, dictation models stay" '[ ! -e "$DATA/sidecar" ] && [ ! -e "$DATA/bundle.js" ] && [ -e "$DATA/speech/models/m.gguf" ]'
expect "running it again repairs the release" 'rm "$DATA/versions/0.1.0/bundle.js" && run --base "http://127.0.0.1:$port/r1" && [ -f "$DATA/versions/0.1.0/bundle.js" ]'
expect "updates to a newer release" 'run --base "http://127.0.0.1:$port/r2" && [ "$(current)" = versions/0.2.0 ] && state | grep -q "\"previous\": \"0.1.0\""'
expect "refuses a manifest changed after signing" '! run --base "http://127.0.0.1:$port/tampered" && grep -q "not signed by the polykey release key" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
expect "refuses a tarball that does not match its hash" '! run --base "http://127.0.0.1:$port/swapped" && grep -q "does not match its sha256" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
expect "refuses a signed version that is not a folder name" '! run --base "http://127.0.0.1:$port/climbs" && grep -q "not a polykey release manifest" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
echo "this release is broken" > "$DATA/versions/0.2.0/sidecar/polykey/injector.py"
expect "--rollback leaves even a release that cannot start, and skips it" 'run --rollback && [ "$(current)" = versions/0.1.0 ] && state | grep -q "\"skip\": \"0.2.0\""'
expect "--rollback with nowhere to go fails" '! run --rollback && grep -q "no earlier release" "$T/out"'
cut_ok=1
for n in $(seq 20 40 $(($(wc -l < "$INSTALL") - 1))); do
  head -n "$n" "$INSTALL" > "$T/cut.sh"
  sh "$T/cut.sh" --base "http://127.0.0.1:$port/r2" > "$T/out" 2>&1 || true
  if [ "$(current)" != versions/0.1.0 ] || grep -q "polykey installer" "$T/out"; then cut_ok=0; fi
done
expect "an install.sh cut off part way does nothing" '[ "$cut_ok" = 1 ]'
expect "--tarball installs a file, and un-skips it" 'run --tarball "$T/serve/r2/polykey-0.2.0.tar.gz" && [ "$(current)" = versions/0.2.0 ] && ! state | grep -q skip'
# The service's updater at work: the installer waits for it, rather than unpack beside it.
flock "$DATA/updates/lock" sh -c 'touch "$1/held"; sleep 3; touch "$1/released"' sh "$T" &
holder=$!
for _ in $(seq 50); do [ -e "$T/held" ] && break; sleep 0.1; done
expect "waits while another install or update holds the lock" \
  'run --tarball "$T/serve/r2/polykey-0.2.0.tar.gz" && [ -e "$T/released" ] && [ "$DATA/versions" -nt "$T/released" ]'
wait "$holder"
expect "keeps the current release and the one before" '[ "$(ls "$DATA/versions")" = "$(printf "0.1.0\n0.2.0")" ]'
INSTALL=scripts/install.sh
expect "an install.sh without a release key installs nothing" \
  '! run --base "http://127.0.0.1:$port/r2" && grep -q "not signed by the polykey release key" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
INSTALL="$T/serve/r2/install.sh"
expect "--uninstall removes polykey, keeps settings and models" \
  'run --uninstall && [ ! -e "$DATA/versions" ] && [ ! -e "$DATA/current" ] && [ ! -e "$HOME/.config/systemd/user/polykey.service" ] && [ -e "$DATA/speech/models/m.gguf" ] && [ -e "$HOME/.config/polykey/settings.json" ]'
expect "--uninstall --purge removes the rest" 'run --uninstall --purge && [ ! -e "$DATA" ] && [ ! -e "$HOME/.config/polykey" ]'

echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
