#!/usr/bin/env bash
# The release key, and the signing that happens outside CI's release job.
#
#   scripts/sign-release.sh --init           make the release key (no passphrase: CI signs with it), put
#                                            its public half into contrib/allowed_signers, and say what
#                                            to do next; refused once allowed_signers holds a key
#   scripts/sign-release.sh --init --add     the same, beside the key already there: the first step of
#                                            a key change (docs/RELEASING.md, "To change keys")
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
# $POLYKEY_ALLOWED_SIGNERS (default contrib/allowed_signers). Needs ssh-keygen; --local needs node.
set -euo pipefail
here=$PWD
cd "$(dirname "$0")/.."

KEY="${POLYKEY_RELEASE_KEY:-$HOME/.ssh/polykey-release}"
SIGNERS="${POLYKEY_ALLOWED_SIGNERS:-contrib/allowed_signers}"
REPO=Malorn44/steam-frame-polykey
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

holds_key() {  # holds_key SIGNERS: a line in it, not a comment, names a key for $NAMESPACE
  [ -f "$1" ] && awk -v ns="$NAMESPACE" '$1 !~ /^#/ { n = split($1, p, ","); for (i = 1; i <= n; i++) if (p[i] == ns) found = 1 }
    END { exit !found }' "$1"
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
    add=
    if [ $# = 2 ] && [ "$2" = --add ]; then add=1; elif [ $# != 1 ]; then die "usage: scripts/sign-release.sh --init [--add]"; fi
    [ ! -e "$KEY" ] || die "$KEY already exists; $SIGNERS should name its public half"
    if [ -z "$add" ] && holds_key "$SIGNERS"; then
      die "$SIGNERS already holds a release key, so making another is a key change: see docs/RELEASING.md, \"To change keys\" (scripts/sign-release.sh --init --add)"
    fi
    # shellcheck disable=SC2174  # only the key's own folder (~/.ssh) needs to be private
    mkdir -p -m 700 "$(dirname "$KEY")"
    ssh-keygen -q -t ed25519 -N '' -C "$NAMESPACE" -f "$KEY"
    printf '%s namespaces="%s" %s\n' "$NAMESPACE" "$NAMESPACE" "$(cut -d' ' -f1,2 "$KEY.pub")" >> "$SIGNERS"
    cat <<EOF
✓ made the release key $KEY (ed25519, no passphrase: CI signs with it) and added its public half
  to $SIGNERS

Next:
EOF
    if [ -n "$add" ]; then
      cat <<EOF
  1. Commit $SIGNERS and release it. Installed polykeys trust only the keys of a release they
     already have, so the old key, still in the secret, signs this one.
  2. Once Frames have that release, store this key as the secret RELEASE_SIGNING_KEY of the
     environment release, then drop the old key's line from $SIGNERS and release again
     (docs/RELEASING.md, "To change keys"):
       gh secret set RELEASE_SIGNING_KEY --env release --repo $REPO < $(printf %q "$KEY")
EOF
    else
      cat <<EOF
  1. Commit $SIGNERS: releases built from then on trust this key.
  2. Store the key as the secret RELEASE_SIGNING_KEY of the environment release (create the
     environment first, in Settings → Environments, with main as its only deployment branch):
       gh secret set RELEASE_SIGNING_KEY --env release --repo $REPO < $(printf %q "$KEY")
EOF
    fi
    cat <<EOF
  3. Back it up, encrypted. Copy it and give only the copy a passphrase (the secret has to stay
     without one), then move the copy offline and keep the passphrase in your password manager:
       cp $(printf %q "$KEY") $(printf %q "$KEY.backup")
       ssh-keygen -p -f $(printf %q "$KEY.backup")
     Don't skip this: GitHub never gives a secret back, and installed polykeys trust only the keys
     they shipped with, so without a backup, a lost key means every user reinstalls by hand.
  4. Once the secret is set, delete the plain key here:
       rm $(printf %q "$KEY")
     --local signs with it; after that, rehearse with a throwaway key (POLYKEY_RELEASE_KEY and
     POLYKEY_ALLOWED_SIGNERS).
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
  -h | --help | "") awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" ;;  # the comment at the top
  *) die "unknown: $1 (try --help)" ;;
esac
