#!/usr/bin/env bash
# The installer's life, end to end, in a throwaway home: two releases signed with a throwaway key and
# served from localhost, a stub systemctl, and the venv's python3 (it has aiohttp, as SteamOS does).
#
#   bash tests/install/test-install.sh     (npm run test:install; CI runs it on every push)
#
# Covers --check, a first install, running it again, an update, --rollback, a manifest not signed by
# the key, a tarball that does not match its hash, an install.sh cut off part way, --tarball, the
# layout from before releases, --uninstall and --uninstall --purge; what release.sh makes: the same
# tarball from the same commit, what the tarball carries, and latest.json; and sign-release.sh, which
# signs every release here (with the throwaway key, never ~/.ssh/polykey-release).
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
    scripts/release.sh "$1" --base "http://127.0.0.1:$port/$2" >/dev/null
  rm -rf "${T:?}/serve/$2"
  cp -R dist/release "$T/serve/$2"
  sign "$T/serve/$2"
}
sign() {  # sign DIR: DIR/latest.json.sig, through sign-release.sh with the throwaway key
  POLYKEY_RELEASE_KEY="$T/key" POLYKEY_ALLOWED_SIGNERS="$T/allowed_signers" scripts/sign-release.sh --local "$1" >/dev/null
}
echo "building releases"
release 0.1.0 r1
release 0.2.0 r2
first=$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d' ' -f1)
release 0.1.0 r1
expect "release.sh makes the same tarball twice" '[ "$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d" " -f1)" = "$first" ]'
printf '# no key yet\n' > "$T/no_signers"
expect "release.sh refuses to run without a release key" \
  '! POLYKEY_ALLOWED_SIGNERS="$T/no_signers" scripts/release.sh 0.1.0 > "$T/out" 2>&1 && grep -q "no release key" "$T/out"'
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
installer_sha=$(sha256sum "$T/serve/r1/install.sh" | cut -d' ' -f1)
tarball_sha=$(sha256sum "$T/serve/r1/polykey-0.1.0.tar.gz" | cut -d' ' -f1)
expect "latest.json names the release, its URL, size and sha256, and the sha256 of install.sh" \
  '"$PYTHON" -I -c "import json, sys; m = json.load(open(sys.argv[1])); sys.exit(m != {\"format\": 1, \"name\": \"polykey\", \"version\": \"0.1.0\", \"url\": sys.argv[2], \"size\": int(sys.argv[3]), \"sha256\": sys.argv[4], \"installer\": sys.argv[5]})" "$T/serve/r1/latest.json" "http://127.0.0.1:$port/r1/polykey-0.1.0.tar.gz" "$(stat -c %s "$T/serve/r1/polykey-0.1.0.tar.gz")" "$tarball_sha" "$installer_sha"'
expect "SHA256SUMS covers the tarball, install.sh and latest.json" '(cd "$T/serve/r1" && sha256sum -c --quiet SHA256SUMS) && [ "$(wc -l < "$T/serve/r1/SHA256SUMS")" = 3 ]'

echo "sign-release.sh"
verify() { ssh-keygen -Y verify -f "$T/allowed_signers" -I polykey-release -n polykey-release -s "$1.sig" < "$1" >/dev/null 2>&1; }
expect "--local signs latest.json with the key allowed_signers names" 'verify "$T/serve/r1/latest.json"'
ssh-keygen -q -t ed25519 -N '' -C polykey-test -f "$T/other-key"
cp -R "$T/serve/r1" "$T/other"
expect "--local refuses a key allowed_signers does not name, and leaves no signature" \
  '! POLYKEY_RELEASE_KEY="$T/other-key" POLYKEY_ALLOWED_SIGNERS="$T/allowed_signers" scripts/sign-release.sh --local "$T/other" > "$T/out" 2>&1 && grep -q "does not check out" "$T/out" && [ ! -e "$T/other/latest.json.sig" ]'
cp "$T/allowed_signers" "$T/signers-before"
expect "--init will not replace a key, and leaves allowed_signers as it was" \
  '! HOME="$T/nohome" POLYKEY_RELEASE_KEY="$T/key" POLYKEY_ALLOWED_SIGNERS="$T/allowed_signers" scripts/sign-release.sh --init > "$T/out" 2>&1 && grep -q "already exists" "$T/out" && cmp -s "$T/allowed_signers" "$T/signers-before"'
(cd "$T/serve" && exec "$PYTHON" -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; sleep 0.1; done

# A manifest edited after it was signed, and a tarball swapped under a signed manifest.
cp -R "$T/serve/r2" "$T/serve/tampered"
sed -i 's/"size": [0-9]*/"size": 1/' "$T/serve/tampered/latest.json"
cp -R "$T/serve/r2" "$T/serve/swapped"
cp "$T/serve/r1/polykey-0.1.0.tar.gz" "$T/serve/swapped/polykey-0.2.0.tar.gz"
sed -i -e "s,/r2/,/swapped/," -e "s/\"size\": [0-9]*/\"size\": $(stat -c %s "$T/serve/swapped/polykey-0.2.0.tar.gz")/" "$T/serve/swapped/latest.json"
sign "$T/serve/swapped"

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
expect "--check passes and reports python and aiohttp" 'run --check && grep -q "✓ python3" "$T/out" && grep -q "✓ aiohttp" "$T/out"'
expect "--check changes nothing" '[ ! -e "$DATA" ]'

# The layout dev deploys used before releases.
mkdir -p "$DATA/sidecar" "$DATA/speech/models" "$HOME/.config/polykey"
touch "$DATA/bundle.js" "$DATA/speech/models/m.gguf"
echo '{"theme": "themes/nord"}' > "$HOME/.config/polykey/settings.json"

expect "installs the latest release" 'run --base "http://127.0.0.1:$port/r1" && [ "$(current)" = versions/0.1.0 ]'
expect "the unit runs current/ and is enabled and restarted" \
  'grep -q "polykey/current/sidecar/run.py" "$HOME/.config/systemd/user/polykey.service" && grep -q "enable polykey" "$HOME/systemctl.log" && grep -q "restart polykey" "$HOME/systemctl.log"'
expect "files from before releases are gone, dictation models stay" '[ ! -e "$DATA/sidecar" ] && [ ! -e "$DATA/bundle.js" ] && [ -e "$DATA/speech/models/m.gguf" ]'
expect "running it again repairs the release" 'rm "$DATA/versions/0.1.0/bundle.js" && run --base "http://127.0.0.1:$port/r1" && grep -q "reinstalling it" "$T/out" && [ -f "$DATA/versions/0.1.0/bundle.js" ]'
expect "updates to a newer release" 'run --base "http://127.0.0.1:$port/r2" && [ "$(current)" = versions/0.2.0 ] && state | grep -q "\"previous\": \"0.1.0\""'
expect "refuses a manifest changed after signing" '! run --base "http://127.0.0.1:$port/tampered" && grep -q "not signed by the polykey release key" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
expect "refuses a tarball that does not match its hash" '! run --base "http://127.0.0.1:$port/swapped" && grep -q "does not match its sha256" "$T/out" && [ "$(current)" = versions/0.2.0 ]'
echo "this release is broken" > "$DATA/versions/0.2.0/sidecar/polykey/__main__.py"
expect "--rollback leaves even a release that cannot start, and skips it" 'run --rollback && [ "$(current)" = versions/0.1.0 ] && state | grep -q "\"skip\": \"0.2.0\""'
expect "--rollback with nowhere to go fails" '! run --rollback && grep -q "no earlier release" "$T/out"'
cut_ok=1
for n in 60 120 180 240; do
  head -n "$n" "$INSTALL" > "$T/cut.sh"
  sh "$T/cut.sh" --base "http://127.0.0.1:$port/r2" > "$T/out" 2>&1 || true
  if [ "$(current)" != versions/0.1.0 ] || grep -q "polykey installer" "$T/out"; then cut_ok=0; fi
done
expect "an install.sh cut off part way does nothing" '[ "$cut_ok" = 1 ]'
expect "--tarball installs a file, and un-skips it" 'run --tarball "$T/serve/r2/polykey-0.2.0.tar.gz" && [ "$(current)" = versions/0.2.0 ] && ! state | grep -q skip'
expect "keeps the current release and the one before" '[ "$(ls "$DATA/versions")" = "$(printf "0.1.0\n0.2.0")" ]'
INSTALL=scripts/install.sh
expect "an install.sh without a key will not download" '! run && grep -q "has no release key" "$T/out"'
INSTALL="$T/serve/r2/install.sh"
expect "--uninstall removes polykey, keeps settings and models" \
  'run --uninstall && [ ! -e "$DATA/versions" ] && [ ! -e "$DATA/current" ] && [ ! -e "$HOME/.config/systemd/user/polykey.service" ] && [ -e "$DATA/speech/models/m.gguf" ] && [ -e "$HOME/.config/polykey/settings.json" ]'
expect "--uninstall --purge removes the rest" 'run --uninstall --purge && [ ! -e "$DATA" ] && [ ! -e "$HOME/.config/polykey" ]'

echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
