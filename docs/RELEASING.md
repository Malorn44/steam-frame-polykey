# Releasing polykey

```
merge a PR to main ──► CI ──► release-please updates the release PR (next version, CHANGELOG.md)
                                              │ merge it
                                              ▼
       CI: tag vX.Y.Z, draft the release, attach the tag's build, check it against a second build
                                              │
                    you: smoke-test the draft on the Frame, then approve in GitHub
                                              │
                                              ▼
       CI: sign latest.json, publish ──► every installed polykey updates within the hour
```

CI gates every commit. A release reaches Frames only after you smoke-test its draft and approve it.
`release:sign` waits for your approval in the `release` environment, the only place the signing key
is kept. It signs only the `latest.json` that `release:verify` found to be what the tagged commit
builds to, rebuilt on a fresh runner, and only while the tag still points at that commit, which
`release` found on main. No build runs in a job that can write to the repo or holds the key.
Installers and updaters refuse a `latest.json` the key didn't sign. A dev deploy
(`scripts/deploy.sh`, in `~/.local/share/polykey/dev/`) is never replaced by an update.

## Once

1. **Make the release key** and commit its public half, through a PR like any change:

   ```sh
   scripts/sign-release.sh --init     # ~/.ssh/polykey-release (ed25519, no passphrase: CI signs with it)
   git switch -c chore/release-key
   git add contrib/allowed_signers && git commit -m "chore(release): the release key"
   git push -u origin HEAD && gh pr create --fill
   ```

   Keep an offline backup of `~/.ssh/polykey-release` somewhere safe: it has no passphrase, and
   GitHub never gives a secret back. Installed releases trust only the keys they shipped with; lose
   every copy and they can no longer update (see [The key](#the-key)). Merge this before the first
   release PR: a tag without the key gets a draft with no files, and CI only says why.

2. **Make the repo public**, before the first release PR is merged. On this plan, an environment
   can require an approval (step 3) only in a public repo. GitHub also serves a private repo's
   releases only to people signed in, so neither `curl … | sh` nor the updater could reach them.

3. **The `release` environment** (Settings → Environments → New environment, named `release`):
   - **Required reviewers:** you. Leave "Prevent self-review" off: you merge the release PR and
     approve it too.
   - **Deployment branches and tags:** selected branches, `main` only.
   - **Environment secret `RELEASE_SIGNING_KEY`:** the release key, as `--init` printed:

     ```sh
     gh secret set RELEASE_SIGNING_KEY --env release --repo Malorn44/steam-frame-polykey < ~/.ssh/polykey-release
     ```

   `release:sign` checks that the repo is public and the environment requires a reviewer, and signs
   nothing otherwise. Once the key is backed up and stored here, you can delete it from this PC;
   `--local` (below) then needs a throwaway key.

4. **The token.** release-please acts with a fine-grained personal access token, so CI runs on its
   release PR (whatever the Actions token does starts no workflow, and `ci ok` is required). On
   GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate
   new token, with access to only `Malorn44/steam-frame-polykey` and the repository permissions
   **Contents: read and write** and **Pull requests: read and write** (Metadata: read comes with
   them). Keep it in an environment only main can use, not as a repository secret: a workflow run
   from any branch of this repo, a PR's included, can read a repository secret.
   - **The `release-please` environment** (Settings → Environments → New environment). First set
     **Deployment branches and tags:** selected branches, `main` only, and add no reviewer: the
     `release` job uses it on every push to main, and each shows as a deployment. If a run on main
     already created the environment, it has no branch rule yet, so set one before the secret.
   - **Its environment secret `RELEASE_PLEASE_TOKEN`:** the token, pasted when asked:

     ```sh
     gh secret set RELEASE_PLEASE_TOKEN --env release-please --repo Malorn44/steam-frame-polykey
     ```

   On this plan, both need the repo public (step 2). Only the `release` job names the environment,
   and it runs nothing but release-please and checks with gh and git. A workflow on another branch
   that names the environment is refused it, so it never gets the token. Until the secret is set,
   `release` skips with a notice saying so, and no release PR opens. Once the token expires, the job
   fails on every push to main until you put a new token in the secret.

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

2. **Merge the release PR.** CI tags vX.Y.Z on the merge commit and creates a draft release with
   the PR's notes. `release` checks that the tagged commit is on main, and the jobs after it build
   and check that commit, never the tag by name. Then:
   - `release:build` checks out the commit and runs `npm ci --ignore-scripts` and
     `scripts/release.sh X.Y.Z`. `release:assets` attaches what it built, `polykey-X.Y.Z.tar.gz`,
     `install.sh`, `latest.json` and `SHA256SUMS`, to the draft.
   - `release:rebuild` builds the same commit again, on another runner.
   - `release:verify` downloads the draft and checks its files against each other: version, URL,
     sha256, size, the installer's hash and SHA256SUMS. It then requires the rebuild's release
     (`sign-release.sh --compare`), the same `install.sh`, and exactly the `latest.json` the rebuild
     writes for the draft's tarball.
   - `release:sign` then waits for your approval.

   The two builds can only read the repo, and the jobs that write to it run nothing from npm. So a
   package's code can't change the draft or forge the check, though one that changed both builds
   alike would still pass it.

   If a job fails on something passing, such as the network, use Re-run failed jobs on that run.
   `release:assets` replaces any files already attached.

3. **Smoke test the draft on the Frame:**

   ```sh
   gh release download vX.Y.Z -p 'polykey-*.tar.gz' -p install.sh -D /tmp/polykey-vX.Y.Z
   scp /tmp/polykey-vX.Y.Z/* steamos@frame:/tmp/
   ssh steamos@frame 'sh /tmp/install.sh --tarball /tmp/polykey-X.Y.Z.tar.gz'
   ```

   Then go through the [checklist](#smoke-test).

4. **For 0.1.0, write the notes by hand, before you approve.** Its generated notes list every PR
   since releases began. Replace them on GitHub (the draft → Edit → Save draft). The notes aren't
   signed: `latest.json` only links to the release page, so editing them doesn't change what gets
   signed. Don't touch the draft's files: if `latest.json` changes after `release:verify` checked
   it, `release:sign` refuses. CHANGELOG.md keeps the generated list.

5. **Approve.** In the workflow run (Actions → the run of the release PR's merge → Review
   deployments), approve `release`. `release:sign` then:
   - downloads `latest.json` again and requires the one `release:verify` checked;
   - checks that the tag still points at the commit that was built;
   - signs it with `RELEASE_SIGNING_KEY`, written to a temporary file (mode 600) and removed after;
   - checks the signature against the tag's `contrib/allowed_signers`;
   - attaches `latest.json.sig` and publishes the draft as the latest release.

   From then on `curl … | sh` installs it, and installed releases update to it within the hour.

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

- **Before you approve:** if the smoke test fails, reject the deployment (Review deployments →
  Reject) and delete the draft on GitHub. If `release:verify` refused the draft, nothing waits for
  an approval: delete the draft and find out why. Either way, leave the tag (the next release PR's
  notes start from it) and fix forward with a new release.
- **If `release` refused the tag,** nothing was built: the tagged commit isn't on main as that run
  saw it. Unless main moved on while release-please ran, find out why first. To draft the release
  again, delete the draft and the tag, swap the merged release PR's `autorelease: tagged` label back
  to `autorelease: pending`, and re-run `release` in main's latest run.
- **After it's published:** a release that fails before it ever reaches Steam goes back by itself
  to the one before it. Otherwise Settings → Back to X (or
  `sh ~/.local/share/polykey/current/install.sh --rollback`) returns a Frame to the release
  before. Either way, automatic updates then skip the release left until a newer one is
  published. Fix forward with a new release.

## The key

- `RELEASE_SIGNING_KEY` (ed25519, no passphrase; your offline backup is the only other copy) signs
  `latest.json`. Installers and updaters check it with `ssh-keygen -Y verify` against the
  `allowed_signers` they shipped with.
- **To change keys:**
  1. Make the new one with `POLYKEY_RELEASE_KEY=~/.ssh/polykey-release-2 scripts/sign-release.sh --init`,
     which adds its line to `contrib/allowed_signers` beside the old one.
  2. Merge that and release it. The secret still holds the old key, so the old key signs it.
  3. Once Frames have that release, put the new key in `RELEASE_SIGNING_KEY`, drop the old line,
     and release again.
- **If the key is lost** (the secret replaced or deleted, and no backup), installed releases cannot
  verify anything newer. Make a new key (`--init`), replace the old line in `allowed_signers` with
  it, store it in `RELEASE_SIGNING_KEY`, and release. Each Frame then reinstalls with the one-line
  installer, whose install.sh carries the new key.

## Trying a release from this PC

To walk an install, update and rollback on the Frame without GitHub, serve a release over the LAN.
`sign-release.sh --local` signs with `~/.ssh/polykey-release`. If you deleted it from this PC, use a
throwaway key instead: a Frame installed this way then trusts only that key, so reinstall it with
the one-line installer afterwards.

```sh
# only without the release key here: a throwaway key, and the allowed_signers that trusts it
export POLYKEY_RELEASE_KEY=/tmp/rehearsal-key POLYKEY_ALLOWED_SIGNERS=/tmp/rehearsal-signers
scripts/sign-release.sh --init

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
