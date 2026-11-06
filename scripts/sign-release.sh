#!/usr/bin/env bash
# Sign a release on this PC, the step CI leaves to you, so the release key never sits in GitHub.
#
#   scripts/sign-release.sh --init           make the release key (no passphrase: CI signs with it), put
#                                            its public half into contrib/allowed_signers, and say what
#                                            to do next
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
here=$PWD
cd "$(dirname "$0")/.."

KEY="${POLYKEY_RELEASE_KEY:-$HOME/.ssh/polykey-release}"
SIGNERS="${POLYKEY_ALLOWED_SIGNERS:-contrib/allowed_signers}"
REPO="${POLYKEY_REPO:-Malorn44/steam-frame-polykey}"
NAMESPACE=polykey-release
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'  # as release.sh

die() { echo "✗ $*" >&2; exit 1; }

from_here() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$here/$1" ;; esac; }  # a path given to us

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

manifest() {  # manifest LATEST_JSON TARBALL: LATEST_JSON as release.sh writes it for TARBALL
  SIZE=$(stat -c %s "$2") SHA=$(sha "$2") node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    m.size = Number(process.env.SIZE);
    m.sha256 = process.env.SHA;
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  ' "$1"
}

plain() {  # plain TARBALL: holds nothing but directories and regular files, as a release does
  local listing
  listing=$(tar -tvzf "$1" 2>/dev/null) || return 1
  ! grep -qv '^[-d]' <<< "$listing"
}

files() { find "$1" -mindepth 1 -printf '%P %y %m\n' | sort; }  # files DIR: every path in it, its type and mode

same_release() {  # same_release A.tar.gz B.tar.gz: the same bytes, or the same files with the same modes
  [ "$(sha "$1")" = "$(sha "$2")" ] && return 0
  local t dir same=1
  for t in "$1" "$2"; do
    plain "$t" || { echo "  $t is not a tarball of directories and files only" >&2; return 1; }
  done
  dir=$(mktemp -d)
  mkdir "$dir/a" "$dir/b"
  # -p: the modes as packed, not as this umask would leave them
  if tar -xpzf "$1" -C "$dir/a" && tar -xpzf "$2" -C "$dir/b" \
    && (cd "$dir" && diff <(files a) <(files b) && diff -rq a b) 2>&1 | head -5 >&2; then
    same=0
  fi
  chmod -R u+rwX "$dir"
  rm -rf "$dir"
  return "$same"
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
  (cd "$d" && sha256sum "polykey-$version.tar.gz" install.sh latest.json) | cmp -s - "$d/SHA256SUMS" \
    || die "SHA256SUMS is not the sums of the draft's files"

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
  # The signature covers every field of latest.json, so all of it must be what the build writes.
  manifest "$built/latest.json" "$tarball" > "$work/latest.json"
  cmp -s "$work/latest.json" "$d/latest.json" || die "the draft's latest.json is not what a build of $tag writes for its tarball"
  echo "✓ the draft holds what $tag builds to (tarball sha256 $(sha "$tarball"))"

  ask "Did the smoke test pass on the Frame with this draft's tarball?" || die "not signed"
  sign "$d/latest.json"
  gh release upload "$tag" --repo "$REPO" --clobber "$d/latest.json.sig" || die "could not upload latest.json.sig"
  echo "✓ signed; latest.json.sig is on the draft"
  if ask "Publish $tag now? Installed polykeys update to it within the hour."; then
    local url
    url=$(gh api -X PATCH "repos/$REPO/releases/$id" -F draft=false -f make_latest=true --jq .html_url) \
      || die "could not publish $tag; it is signed, so publish it on GitHub, or run this again"
    echo "✓ published $tag: $url"
  else
    echo "left as a draft; publish it on GitHub, or run this again"
  fi
}

case "${1:-}" in
  --init)
    [ ! -e "$KEY" ] || die "$KEY already exists; $SIGNERS should name its public half"
    # shellcheck disable=SC2174  # only the key's own folder (~/.ssh) needs to be private
    mkdir -p -m 700 "$(dirname "$KEY")"
    ssh-keygen -q -t ed25519 -N '' -C "$NAMESPACE" -f "$KEY"
    printf '%s namespaces="%s" %s\n' "$NAMESPACE" "$NAMESPACE" "$(cut -d' ' -f1,2 "$KEY.pub")" >> "$SIGNERS"
    cat <<EOF
✓ made the release key $KEY (ed25519, no passphrase: CI signs with it) and added its public half
  to $SIGNERS

Next:
  1. Commit $SIGNERS: releases built from then on trust this key.
  2. Store the key as the secret RELEASE_SIGNING_KEY of the environment release (create the
     environment first, in Settings → Environments, with main as its only deployment branch):
       gh secret set RELEASE_SIGNING_KEY --env release --repo $REPO < $(printf %q "$KEY")
  3. Keep an offline backup of $KEY somewhere safe (it has no passphrase). GitHub never gives a
     secret back: lose every copy and installed releases can no longer update.
  4. Then, if you like, delete it here: rm $(printf %q "$KEY"). --local signs with it; without it,
     rehearse with a throwaway key (POLYKEY_RELEASE_KEY and POLYKEY_ALLOWED_SIGNERS).
EOF
    ;;
  --local)
    dir=dist/release
    [ $# -lt 2 ] || dir=$(from_here "$2")
    [ -f "$dir/latest.json" ] || die "no $dir/latest.json (scripts/release.sh makes one)"
    sign "$dir/latest.json"
    echo "✓ signed polykey $(field "$dir/latest.json" version) ($dir/latest.json.sig)"
    ;;
  --compare)
    [ $# = 3 ] || die "usage: scripts/sign-release.sh --compare A.tar.gz B.tar.gz"
    if same_release "$(from_here "$2")" "$(from_here "$3")"; then echo "same release"; else echo "different"; exit 1; fi
    ;;
  v[0-9]*) draft "$1" ;;
  -h | --help | "") sed -n '2,22p' "$0" ;;
  *) die "unknown: $1 (try --help)" ;;
esac
