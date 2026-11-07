#!/usr/bin/env bash
# Build a release into dist/release/:
#
#   polykey-<version>.tar.gz   the build (dist/stage) under polykey-<version>/, byte-for-byte
#                              reproducible from the same commit
#   install.sh                 the installer, with the release key in it
#   latest.json                what the updater and install.sh read: version, tarball URL, size, sha256
#                              (and install.sh's sha256, so the signature covers the installer too)
#   SHA256SUMS                 sha256 of the three above
#
# Usage: scripts/release.sh <version> [--base URL]
#   --base URL   where the tarball will be served (default: the GitHub release v<version>), e.g.
#                http://192.168.1.20:8000 to try a release on the Frame from this PC
#
# The version comes from the release tag (release-please picks it from the commits). latest.json.sig,
# the signature the updater and install.sh check, is made afterwards on your PC
# (scripts/sign-release.sh): the key never sits in CI. POLYKEY_REPO (default
# Malorn44/steam-frame-polykey) names the GitHub repo; POLYKEY_ALLOWED_SIGNERS another key file than
# contrib/allowed_signers (the installer tests use a throwaway key).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${POLYKEY_REPO:-Malorn44/steam-frame-polykey}"
SIGNERS="${POLYKEY_ALLOWED_SIGNERS:-contrib/allowed_signers}"
OUT=dist/release

version=""
base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:?--base needs a URL}"; base="${base%/}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) version="$1"; shift ;;
  esac
done
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "usage: scripts/release.sh <version like 1.2.3> [--base URL]" >&2
  exit 2
fi
if ! grep -q '^polykey-release .*ssh-ed25519 ' "$SIGNERS"; then
  echo "✗ no release key in $SIGNERS: run scripts/sign-release.sh --init first" >&2
  exit 1
fi

top="polykey-$version"
url="${base:-https://github.com/$REPO/releases/download/v$version}/$top.tar.gz"
notes=""
[ -n "$base" ] || notes="https://github.com/$REPO/releases/tag/v$version"

POLYKEY_ALLOWED_SIGNERS="$SIGNERS" node scripts/build.mjs --version "$version"

rm -rf "$OUT"
mkdir -p "$OUT"
# Same commit, same bytes: fixed order, owner, times and modes, and gzip without a name or time.
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --mode='u+rwX,go+rX,go-w' \
  --transform "s,^stage,$top," -C dist -cf - stage | gzip -9n > "$OUT/$top.tar.gz"
cp dist/stage/install.sh "$OUT/install.sh"

size=$(stat -c %s "$OUT/$top.tar.gz")
sha=$(sha256sum "$OUT/$top.tar.gz" | cut -d' ' -f1)
installer=$(sha256sum "$OUT/install.sh" | cut -d' ' -f1)
VERSION="$version" URL="$url" SIZE="$size" SHA="$sha" INSTALLER="$installer" NOTES="$notes" node -e '
  const e = process.env;
  const manifest = { format: 1, name: "polykey", version: e.VERSION, url: e.URL, size: Number(e.SIZE), sha256: e.SHA,
    installer: e.INSTALLER };
  if (e.NOTES) manifest.notes = e.NOTES;
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
' > "$OUT/latest.json"
(cd "$OUT" && sha256sum "$top.tar.gz" install.sh latest.json > SHA256SUMS)

echo "polykey $version: $OUT/$top.tar.gz ($((size / 1024)) KB), sha256 $sha"
echo "  tarball URL: $url"
