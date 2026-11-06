#!/usr/bin/env bash
# Sign a release on this PC, the step CI leaves to you, so the release key never sits in GitHub.
#
#   scripts/sign-release.sh --init           make the release key (asks for a passphrase) and put its
#                                            public half into contrib/allowed_signers; commit that
#   scripts/sign-release.sh vX.Y.Z           sign the draft release vX.Y.Z (below), then publish it
#                                            if you say so
#   scripts/sign-release.sh --local [DIR]    sign DIR/latest.json (default dist/release), for a release
#                                            served from this PC (release.sh --base)
#   scripts/sign-release.sh --compare A B    whether two release tarballs hold the same release
#
# Signing a draft: download its tarball, install.sh, latest.json and SHA256SUMS; check they agree with
# each other and the tag; build the tag here, in a scratch worktree, and require the draft to hold
# exactly what that build makes (byte for byte, or file for file if CI compressed it differently);
# ask whether the smoke test passed; sign latest.json; upload latest.json.sig. So what Frames get is
# what the tagged code builds to, whatever happened in CI.
#
# The key: $POLYKEY_RELEASE_KEY (default ~/.ssh/polykey-release). Run the smoke test on the Frame with
# the draft's tarball before you sign: a published, signed release reaches every installed polykey
# within the hour. Needs ssh-keygen, node and npm, and gh (logged in; 2.4.0 will do) for a draft.
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

sha() { sha256sum "$1" | cut -d' ' -f1; }

same_release() {  # same_release A.tar.gz B.tar.gz: the same bytes, or the same files with the same modes
  [ "$(sha "$1")" = "$(sha "$2")" ] && return 0
  local dir
  dir=$(mktemp -d)
  mkdir "$dir/a" "$dir/b"
  if ! tar -xzf "$1" -C "$dir/a" || ! tar -xzf "$2" -C "$dir/b"; then rm -rf "$dir"; return 1; fi
  local listing_a listing_b
  listing_a=$(cd "$dir/a" && find . -printf '%p %y %m\n' | sort)
  listing_b=$(cd "$dir/b" && find . -printf '%p %y %m\n' | sort)
  if [ "$listing_a" = "$listing_b" ] && diff -r "$dir/a" "$dir/b" >/dev/null; then rm -rf "$dir"; return 0; fi
  diff -r "$dir/a" "$dir/b" | head -5 >&2 || true
  rm -rf "$dir"
  return 1
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
  trap "git worktree remove --force '$work/src' 2>/dev/null; rm -rf '$work'" EXIT
  mkdir "$work/draft"
  gh release download "$tag" --repo "$REPO" --dir "$work/draft" \
    --pattern latest.json --pattern SHA256SUMS --pattern install.sh --pattern "polykey-$version.tar.gz"
  local d="$work/draft" tarball="$work/draft/polykey-$version.tar.gz" f
  for f in latest.json SHA256SUMS install.sh "polykey-$version.tar.gz"; do
    [ -f "$d/$f" ] || die "the draft has no $f"
  done

  echo "→ checking the draft's files against each other"
  [ "$(field "$d/latest.json" version)" = "$version" ] || die "latest.json in $tag is for $(field "$d/latest.json" version)"
  [ "$(field "$d/latest.json" url)" = "https://github.com/$REPO/releases/download/$tag/polykey-$version.tar.gz" ] \
    || die "latest.json points somewhere else: $(field "$d/latest.json" url)"
  [ "$(field "$d/latest.json" sha256)" = "$(sha "$tarball")" ] || die "the draft's tarball does not match latest.json"
  [ "$(field "$d/latest.json" size)" = "$(stat -c %s "$tarball")" ] || die "the draft's tarball is not the size latest.json gives"
  [ "$(field "$d/latest.json" installer)" = "$(sha "$d/install.sh")" ] || die "the draft's install.sh does not match latest.json"
  (cd "$d" && sha256sum --quiet -c SHA256SUMS) || die "SHA256SUMS does not match the draft's files"

  git fetch --quiet origin "refs/tags/$tag:refs/tags/$tag" 2>/dev/null || true
  git rev-parse --verify --quiet "$tag^{commit}" >/dev/null || die "no tag $tag here (git fetch --tags)"
  echo "→ building $tag ($(git rev-parse --short "$tag^{commit}")) here to compare (a scratch worktree; npm ci takes a moment)"
  git worktree add --quiet --detach "$work/src" "$tag"
  (cd "$work/src" && npm ci --ignore-scripts --silent >/dev/null && scripts/release.sh "$version" >/dev/null) </dev/null \
    || die "could not build $tag here"
  local built="$work/src/dist/release"
  same_release "$tarball" "$built/polykey-$version.tar.gz" \
    || die "the draft's tarball differs from a build of $tag: do not sign it; delete the draft and find out why"
  cmp -s "$d/install.sh" "$built/install.sh" || die "the draft's install.sh differs from a build of $tag"
  echo "✓ the draft holds what $tag builds to (tarball sha256 $(sha "$tarball"))"

  ask "Did the smoke test pass on the Frame with this draft's tarball?" || die "not signed"
  sign "$d/latest.json"
  gh release upload "$tag" --repo "$REPO" --clobber "$d/latest.json.sig"
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
  --compare)
    [ $# = 3 ] || die "usage: scripts/sign-release.sh --compare A.tar.gz B.tar.gz"
    if same_release "$2" "$3"; then echo "same release"; else echo "different"; exit 1; fi
    ;;
  v[0-9]*) draft "$1" ;;
  -h | --help | "") sed -n '2,21p' "$0" ;;
  *) die "unknown: $1 (try --help)" ;;
esac
