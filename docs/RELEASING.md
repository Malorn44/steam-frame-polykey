# Releasing polykey

```
merge a PR to main ──► CI ──► release-please updates the release PR (next version, CHANGELOG.md)
                                              │ merge it
                                              ▼
           CI: tag vX.Y.Z, draft GitHub release, build the tag and attach its files
                                              │
   every installed polykey ◄── publish ◄── sign (TODO) ◄── smoke test on the Frame
   updates within the hour                                   (the draft's tarball)
```

CI gates every commit. A release needs a passed smoke test and a signature from the release key
before any Frame sees it: installers and updaters refuse a `latest.json` the key didn't sign, and
CI's draft has no signature. A dev deploy (`scripts/deploy.sh`, in `~/.local/share/polykey/dev/`)
is never replaced by an update.

> **TODO (signing):** where releases are signed and published isn't settled yet. Either it happens
> on your PC with `scripts/sign-release.sh vX.Y.Z`, as now, or in CI after an approval in GitHub.
> Each part of this page that depends on the choice is marked TODO (signing).

## Once

1. **Make the release key** and commit its public half, through a PR like any change:

   ```sh
   scripts/sign-release.sh --init     # ~/.ssh/polykey-release, asks for a passphrase
   git switch -c chore/release-key
   git add contrib/allowed_signers && git commit -m "chore(release): the release key"
   git push -u origin HEAD && gh pr create --fill
   ```

   Back the key up somewhere safe. Installed releases trust only the key they shipped with; lose
   it and they can no longer update (see [The key](#the-key)). Merge this before the first release
   PR: a tag without the key gets a draft with no files, and CI only says why.

   > **TODO (signing):** whether the private key stays on this PC or goes to GitHub, as a secret
   > that only an approved signing job can read.

2. **The token.** release-please acts with a fine-grained personal access token, so CI runs on its
   release PR (whatever the Actions token does starts no workflow, and `ci ok` is required). On
   GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate
   new token, with access to only `Malorn44/steam-frame-polykey` and the repository permissions
   **Contents: read and write** and **Pull requests: read and write** (Metadata: read comes with
   them). Add it to the repo as the Actions secret `RELEASE_PLEASE_TOKEN` (Settings → Secrets and
   variables → Actions). Only the `release` job sees it, and that job runs nothing but
   release-please. Without the secret, or once the token expires, that job fails on every push to
   main until you put a new token in the secret.

3. **Go public before 0.1.0 is published.** GitHub serves a private repo's releases only to people
   signed in, so neither `curl … | sh` nor the updater can reach them. Until then, install a draft
   with `--tarball` (below). Make the repo public before you publish 0.1.0.

## Each release

1. **The release PR.** After a push to main passes CI, release-please opens or updates a PR titled
   `chore(main): release X.Y.Z`. It sets `.release-please-manifest.json` to the next version and adds
   that version's notes to CHANGELOG.md. Pull requests are squash-merged, so their titles are the
   conventional commits it reads:
   - `feat` bumps the minor version, and `fix` and `perf` bump the patch.
   - While polykey is 0.x, a breaking change (`feat!:` or `BREAKING CHANGE:`) bumps the minor too.
   - `docs`, `chore`, `test`, `refactor`, `build`, `ci` and `style` don't show in the notes. On
     their own (a Dependabot bump, say) they open no release PR.

   CI checks the release PR like any other. Leave it open until you want to release; each merge to
   main updates it.

2. **Merge the release PR.** CI then tags vX.Y.Z on the merge commit and creates a draft release
   with the PR's notes. Next, `release:assets` checks out the tag, runs `npm ci --ignore-scripts`
   and `scripts/release.sh X.Y.Z`, and attaches `polykey-X.Y.Z.tar.gz`, `install.sh`,
   `latest.json` and `SHA256SUMS` to the draft. The draft has no signature, so no Frame takes it.
   If `release:assets` fails on something passing, such as the network, use Re-run failed jobs on
   that run; it replaces any files already attached.

3. **Smoke test the draft on the Frame:**

   ```sh
   gh release download vX.Y.Z -p 'polykey-*.tar.gz' -p install.sh -D /tmp/polykey-vX.Y.Z
   scp /tmp/polykey-vX.Y.Z/* steamos@frame:/tmp/
   ssh steamos@frame 'sh /tmp/install.sh --tarball /tmp/polykey-X.Y.Z.tar.gz'
   ```

   Then go through the [checklist](#smoke-test).

4. **For 0.1.0, write the notes by hand.** Its generated notes list every PR since releases began.
   Replace them on GitHub (the draft → Edit → Save draft). The notes aren't signed: `latest.json`
   only links to the release page, so editing them doesn't change what gets signed. CHANGELOG.md
   keeps the generated list.

5. **Sign and publish.**

   > **TODO (signing):** this step depends on where releases are signed. Either way, it signs
   > `latest.json` only after the smoke test passed, and only for a draft that holds what the tag
   > builds to, then publishes the draft. From then on `curl … | sh` installs it, and installed
   > releases update to it within the hour.

### Smoke test

CI can't run Steam, so this is by hand, on the Frame, with the draft installed:

- [ ] Settings shows `polykey X.Y.Z`
- [ ] the keyboard opens in a game and in the Steam dashboard, and types there
- [ ] English: letters, Shift, the number row, Fn, a word suggestion (and a swipe, if swipe typing is on)
- [ ] Japanese: 12-key flick, then convert with Anthy (かな → 漢字) and send
- [ ] 🌐 goes through your keyboards; with one keyboard in the list it is hidden
- [ ] dictation with one model types a phrase
- [ ] a change in Settings survives `systemctl --user restart polykey`
- [ ] once the release is published: Settings → Check for updates says "Up to date"

## When it goes wrong

A release that fails before it ever reaches Steam goes back by itself to the one before it.
Otherwise Settings → Back to X (or `sh ~/.local/share/polykey/current/install.sh --rollback`)
returns a Frame to the release before. Either way, automatic updates then skip the release left
until a newer one is published.

Fix forward with a new release. Delete a bad draft or release on GitHub, but leave its tag: the next
release PR's notes start from it.

## Trying a release from this PC

To walk an install, update and rollback on the Frame without GitHub, serve a release over the LAN:

```sh
scripts/release.sh 0.1.0-rc.1 --base http://<this PC's IP>:8000
scripts/sign-release.sh --local
python3 -m http.server -d dist/release 8000
```

On the Frame:

```sh
curl -fsSL http://<PC>:8000/install.sh | sh -s -- --base http://<PC>:8000
```

To have the updater follow this server instead of GitHub, put `"updateUrl": "http://<PC>:8000/"` in
`~/.config/polykey/settings.json`. Build the next version (`0.1.0-rc.2`) the same way, and Settings →
Check for updates finds it. Pre-releases sort before their release (0.1.0-rc.2 < 0.1.0). From WSL,
the Frame reaches the PC only with WSL's mirrored networking or a Windows port proxy, and a firewall
rule for the port.

> **TODO (signing):** `sign-release.sh --local` needs the release key on this PC. If the key moves
> to GitHub, a rehearsal needs another way to sign.

## Checking install.sh by hand

`latest.json` carries the sha256 of `install.sh` (`installer`), so the signature covers the
installer too. Before piping it into `sh`, a careful user can check it with the key in
`contrib/allowed_signers`:

```sh
base=https://github.com/Malorn44/steam-frame-polykey/releases/latest/download
curl -fsSL -O "$base/install.sh" -O "$base/latest.json" -O "$base/latest.json.sig"
ssh-keygen -Y verify -f allowed_signers -I polykey-release -n polykey-release -s latest.json.sig < latest.json \
  && grep -q "\"installer\": \"$(sha256sum install.sh | cut -d' ' -f1)\"" latest.json && sh install.sh
```

## The key

- `~/.ssh/polykey-release` (ed25519, with a passphrase) signs `latest.json`; installers and
  updaters check it with `ssh-keygen -Y verify` against the `allowed_signers` they shipped with.
- **To change keys**: make the new one with
  `POLYKEY_RELEASE_KEY=~/.ssh/polykey-release-2 scripts/sign-release.sh --init`, which adds its line
  to `contrib/allowed_signers` beside the old one. Release that, signed with the old key. Once
  Frames have it, sign the next release with the new key and drop the old line.
- **If the key is lost**, installed releases cannot verify anything newer. Make a new key
  (`--init`), replace the old line with it, and release. Each Frame then reinstalls with the
  one-line installer, whose install.sh carries the new key.

> **TODO (signing):** these steps assume the key is on this PC. If it moves to GitHub, changing keys
> also means replacing the secret there.
