# Contributing to polykey

Thanks for helping. Bug reports, packs (layouts, keyboards, themes) and fixes are all welcome.

## Set up and check

You need Node 24 and Python 3.12 (the Frame's Python). Set up as the README's
[Develop](../README.md#develop-wsl) section shows. `npm run check` runs lint (ESLint, ruff, shellcheck,
actionlint), typecheck, vitest, pytest and the build.

`npm run check` must pass before you open a PR; CI runs the same check. To try a change on a Frame,
see the README's [Deploy to the Frame](../README.md#deploy-to-the-frame).

## Pull requests

- **One change per PR.** A fix, a feature or a pack, not several at once.
- **The title is a [Conventional Commit](https://www.conventionalcommits.org/):** `type(scope): summary`,
  with a lowercase type (feat, fix, perf, refactor, docs, test, build, ci, chore, style, revert) and an
  imperative summary, e.g. `fix(ime): keep the reading after a cancelled conversion`. PRs are
  squash-merged, so the title becomes the commit on main.
- Say what changed and why, and how you checked it (tests, on a Frame, or both).
- If you use someone else's code, data or assets, check that its licence allows it, credit it where you
  use it, and add it to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Rules that never bend

A keyboard sees everything its user types, so a PR that breaks one of these won't be merged:

- **Never log typed text**: not in the sidecar's journal, not in the page's console, not in errors.
- **Never leave a modifier key held down**: every press of Ctrl, Alt, Shift or Super has its release,
  on every path, including errors and the keyboard closing.
- **Dictation never logs text or audio**, and never writes either to disk.
- **The debugger stays localhost only**: the sidecar talks to Steam's debugger on 127.0.0.1 and refuses
  any other host, and nothing exposes it to the network. Reach it from another machine through an SSH
  tunnel, as the [README](../README.md#deploy-to-the-frame) shows.

## Licence

polykey is under the [MIT licence](../LICENSE). By contributing, you agree that your contribution is
licensed under it too.
