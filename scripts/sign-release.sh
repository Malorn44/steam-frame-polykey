#!/usr/bin/env bash
# Sign a release on this PC, the step CI leaves to you, so the release key never sits in GitHub.
#
#   scripts/sign-release.sh --init           make the release key (asks for a passphrase) and put its
#                                            public half into contrib/allowed_signers; commit that
#   scripts/sign-release.sh vX.Y.Z           sign the draft release vX.Y.Z: download its latest.json,
#                                            check it against SHA256SUMS, sign it, upload
#                                            latest.json.sig, then publish the draft if you say so
#   scripts/sign-release.sh --local [DIR]    sign DIR/latest.json (default dist/release), for a release
#                                            served from this PC (release.sh --base)
#
# The key: $POLYKEY_RELEASE_KEY (default ~/.ssh/polykey-release). Run the smoke test on the Frame with
# the draft's tarball before you sign: a published, signed release reaches every installed polykey
# within the hour. Needs ssh-keygen and node, and gh (logged in; 2.4.0 will do) for a draft.
# POLYKEY_REPO (default Malorn44/steam-frame-polykey) names the GitHub repo.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="${POLYKEY_RELEASE_KEY:-$HOME/.ssh/polykey-release}"
SIGNERS="${POLYKEY_ALLOWED_SIGNERS:-contrib/allowed_signers}"
REPO="${POLYKEY_REPO:-Malorn44/steam-frame-polykey}"
NAMESPACE=polykey-release
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'  # as release.sh

die() { echo "✗ $*" >&2; exit 1; }

ask() {  # ask QUESTION: whether the answer is yes (no answer is no)
  local answer=""
  read -r -p "$1 [y/N] " answer || true
  case "$answer" in y | Y | yes) return 0 ;; *) return 1 ;; esac
}

sign() {  # sign FILE: FILE.sig, checked against the key in $SIGNERS
  [ -f "$KEY" ] || die "no release key at $KEY (scripts/sign-release.sh --init makes one)"
  rm -f "$1.sig"
  ssh-keygen -q -Y sign -f "$KEY" -n "$NAMESPACE" "$1"
  if ! ssh-keygen -q -Y verify -f "$SIGNERS" -I "$NAMESPACE" -n "$NAMESPACE" -s "$1.sig" < "$1" >/dev/null; then
    rm -f "$1.sig"
    die "the signature does not check out against $SIGNERS: is $KEY the key named there?"
  fi
}

field() {  # field LATEST_JSON NAME
  node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(m[process.argv[2]] ?? "");' "$1" "$2"
}

draft() {  # draft vX.Y.Z
  local tag=$1 version=${1#v} found id work
  [[ $tag =~ ^v$SEMVER$ ]] || die "not a release tag: $tag (like v1.2.3)"
  command -v gh >/dev/null || die "gh is needed to reach the draft release"
  # gh release download and upload find a draft by its tag on the first page of releases: look
  # there, for the release's id (gh 2.4.0 has no `gh release edit`; publishing goes through the API).
  found=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$tag\") | \"\(.id) \(.draft)\"")
  [ -n "$found" ] || die "no release $tag in $REPO (not drafted yet?)"
  [ "$(wc -l <<< "$found")" = 1 ] || die "more than one release in $REPO is tagged $tag: delete the extra drafts"
  [ "${found#* }" = true ] || die "$tag is already published in $REPO"
  id=${found% *}
  work=$(mktemp -d)
  # shellcheck disable=SC2064  # $work is fixed now
  trap "rm -rf '$work'" EXIT
  gh release download "$tag" --repo "$REPO" --dir "$work" --pattern latest.json --pattern SHA256SUMS
  [ -f "$work/latest.json" ] && [ -f "$work/SHA256SUMS" ] || die "the draft has no latest.json or SHA256SUMS"
  local sha
  sha=$(field "$work/latest.json" sha256)
  [ "$(field "$work/latest.json" version)" = "$version" ] || die "latest.json in $tag is for $(field "$work/latest.json" version)"
  grep -qx "$sha  polykey-$version.tar.gz" "$work/SHA256SUMS" || die "latest.json and SHA256SUMS disagree about the tarball"
  echo "polykey $version, tarball sha256 $sha"
  ask "Did the smoke test pass on the Frame with this draft's tarball?" || die "not signed"
  sign "$work/latest.json"
  gh release upload "$tag" --repo "$REPO" --clobber "$work/latest.json.sig"
  echo "✓ signed; latest.json.sig is on the draft"
  if ask "Publish $tag now? Installed polykeys update to it within the hour."; then
    echo "✓ published $tag: $(gh api -X PATCH "repos/$REPO/releases/$id" -F draft=false -f make_latest=true --jq .html_url)"
  else
    echo "left as a draft; publish it on GitHub, or run this again"
  fi
}

case "${1:-}" in
  --init)
    [ ! -e "$KEY" ] || die "$KEY already exists; $SIGNERS should name its public half"
    # shellcheck disable=SC2174  # only the key's own folder (~/.ssh) needs to be private
    mkdir -p -m 700 "$(dirname "$KEY")"
    echo "→ making the release key $KEY (ed25519). Choose a passphrase, and keep a backup of the key:"
    echo "  a lost key means installed releases can no longer update."
    ssh-keygen -q -t ed25519 -C "$NAMESPACE" -f "$KEY"
    printf '%s namespaces="%s" %s\n' "$NAMESPACE" "$NAMESPACE" "$(cut -d' ' -f1,2 "$KEY.pub")" >> "$SIGNERS"
    echo "✓ added to $SIGNERS; commit it: releases built from then on carry the key"
    ;;
  --local)
    dir="${2:-dist/release}"
    [ -f "$dir/latest.json" ] || die "no $dir/latest.json (scripts/release.sh makes one)"
    sign "$dir/latest.json"
    echo "✓ signed polykey $(field "$dir/latest.json" version) ($dir/latest.json.sig)"
    ;;
  v[0-9]*) draft "$1" ;;
  -h | --help | "") sed -n '2,15p' "$0" ;;
  *) die "unknown: $1 (try --help)" ;;
esac
