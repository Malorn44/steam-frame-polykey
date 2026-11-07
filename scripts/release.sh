#!/usr/bin/env bash
# Build a release into dist/release/, the files a release serves side by side:
#
#   polykey-<version>.tar.gz   the build (dist/stage) under polykey-<version>/, byte-for-byte
#                              reproducible from the same commit
#   install.sh                 the installer, with the release key in it
#   latest.json                what the updater and install.sh read: the version, and the size and
#                              sha256 of the tarball, which they fetch from beside it
#
# Usage: scripts/release.sh <version>
#
# The version comes from the release tag (release-please picks it from the commits). latest.json.sig,
# the signature the updater and install.sh check, is made afterwards: by CI once you approve the
# release, or for a release served from this PC (dist/release/ over HTTP, with install.sh --base or
# settings.json "updateUrl" pointing at it) by
#   ssh-keygen -Y sign -f <key> -n polykey-release dist/release/latest.json
# POLYKEY_ALLOWED_SIGNERS names another key file than contrib/allowed_signers (the installer tests
# use a throwaway key).
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in -h | --help) sed -n '2,18p' "$0"; exit 0 ;; esac
[ $# = 1 ] || { echo "usage: scripts/release.sh <version>" >&2; exit 2; }
version=$1
top="polykey-$version"
OUT=dist/release

node scripts/build.mjs --version "$version"  # checks the version before it writes anything

rm -rf "$OUT"
mkdir -p "$OUT"
# Same commit, same bytes: fixed order, owner, times and modes, and gzip without a name or time.
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --mode='u+rwX,go+rX,go-w' \
  --transform "s,^stage,$top," -C dist -cf - stage | gzip -9n > "$OUT/$top.tar.gz"
cp dist/stage/install.sh "$OUT/install.sh"

size=$(stat -c %s "$OUT/$top.tar.gz")
sha=$(sha256sum "$OUT/$top.tar.gz" | cut -d' ' -f1)
VERSION="$version" SIZE="$size" SHA="$sha" node -e '
  const e = process.env;
  const manifest = { format: 1, version: e.VERSION, size: Number(e.SIZE), sha256: e.SHA };
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
' > "$OUT/latest.json"

echo "polykey $version: $OUT/$top.tar.gz ($((size / 1024)) KB), sha256 $sha"
