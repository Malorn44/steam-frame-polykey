#!/usr/bin/env bash
# The release key, and the signing that happens outside CI's release job.
#
#   scripts/sign-release.sh --init           make the release key (no passphrase: CI signs with it), put
#                                            its public half into contrib/allowed_signers, and say what
#                                            to do next
#   scripts/sign-release.sh --local [DIR]    sign DIR/latest.json (default dist/release), for a release
#                                            served from this PC (release.sh --base)
#   scripts/sign-release.sh --compare A B    whether two release tarballs hold the same release: the
#                                            same bytes, or the same files with the same modes
#
# Releases are signed in CI: once you have smoke-tested a draft on the Frame and approved the release
# environment (main only), its job checks the draft against a rebuild of the tag (--compare), signs
# latest.json with the key in the environment's secret RELEASE_SIGNING_KEY, and publishes. Installed
# polykeys trust only the keys in the allowed_signers they shipped with.
#
# The key: $POLYKEY_RELEASE_KEY (default ~/.ssh/polykey-release); the keys releases trust:
# $POLYKEY_ALLOWED_SIGNERS (default contrib/allowed_signers). POLYKEY_REPO (default
# Malorn44/steam-frame-polykey) names the GitHub repo. Needs ssh-keygen; --local needs node.
set -euo pipefail
here=$PWD
cd "$(dirname "$0")/.."

KEY="${POLYKEY_RELEASE_KEY:-$HOME/.ssh/polykey-release}"
SIGNERS="${POLYKEY_ALLOWED_SIGNERS:-contrib/allowed_signers}"
REPO="${POLYKEY_REPO:-Malorn44/steam-frame-polykey}"
NAMESPACE=polykey-release

die() { echo "✗ $*" >&2; exit 1; }

from_here() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$here/$1" ;; esac; }  # a path given to us

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
  -h | --help | "") sed -n '2,19p' "$0" ;;
  *) die "unknown: $1 (try --help)" ;;
esac
