// The version a build is stamped with (scripts/build.mjs).
// A release build gets exactly the version it is asked for, which release-please picks from the commits.
// Any other build is a dev build, named after the last release tag (vX.Y.Z), or 0.0.0 before there is one:
// 0.3.1+dev.4.gabc1234.20261105T120000 is 4 commits past v0.3.1 (".dirty" with uncommitted changes).
import { execFileSync } from 'node:child_process';

/** X.Y.Z with an optional pre-release (1.2.3-rc.1, no empty parts): the one syntax every tool accepts. */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** `git …` in `cwd`, trimmed; '' when it fails (no git, not a repository, no commits). */
const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/** <last tag>+dev.<commits since>.g<sha>[.dirty].<UTC stamp>; from 0.0.0 and the first commit before any tag. */
export const devVersion = (cwd = '.', now = new Date()) => {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  // Only tags shaped like vX.Y.Z[-pre], so a stray v1.2 cannot hide the release tag before it.
  const match = 'v[0-9]*.[0-9]*.[0-9]*';
  const described = git(cwd, 'describe', '--tags', '--match', match, '--long', '--abbrev=7', '--dirty');
  const tagged = /^v(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(described);
  if (tagged && SEMVER.test(tagged[1])) {
    const [, tag, since, sha, dirty] = tagged;
    return `${tag}+dev.${since}.g${sha}${dirty ? '.dirty' : ''}.${stamp}`;
  }
  // No tag at all (--exclude), so this is the commit's abbreviated sha whatever other tags there are.
  const head = /^([0-9a-f]+)(-dirty)?$/.exec(
    git(cwd, 'describe', '--always', '--exclude', '*', '--abbrev=7', '--dirty'),
  );
  if (!head) return `0.0.0+dev.${stamp}`; // not built from a git checkout
  return `0.0.0+dev.${git(cwd, 'rev-list', '--count', 'HEAD')}.g${head[1]}${head[2] ? '.dirty' : ''}.${stamp}`;
};
