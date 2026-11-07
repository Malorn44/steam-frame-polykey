// The version a build is stamped with (scripts/version.mjs): a release's own, or a dev build's from git.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEMVER, devVersion } from '../scripts/version.mjs';

const NOW = new Date('2026-11-05T12:00:00Z');
const STAMP = '20261105T120000';

let dir = '';
const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (text: string): string => {
  writeFileSync(join(dir, 'file'), text);
  git('add', 'file');
  git('commit', '-q', '-m', text);
  return git('rev-parse', '--short=7', 'HEAD');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polykey-version-'));
  // Git as it comes, whoever runs this: no user or system config (signing, hooks), no repository above.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir());
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) vi.stubEnv(name, undefined);
  for (const who of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${who}_NAME`, 'test');
    vi.stubEnv(`GIT_${who}_EMAIL`, 'test@example.com');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('release versions', () => {
  it('are X.Y.Z with an optional pre-release of non-empty parts', () => {
    for (const ok of ['0.1.0', '1.2.3', '10.20.30', '1.2.3-rc.1', '1.2.3-alpha', '1.2.3-x-y.0.z-'])
      expect(ok).toMatch(SEMVER);
    for (const bad of [
      '',
      '1.2',
      'v1.2.3',
      '01.2.3',
      '1.02.3',
      '1.2.3-',
      '1.2.3-rc.',
      '1.2.3-.rc',
      '1.2.3-rc..1',
      '1.2.3-rc_1',
      '1.2.3+build',
      ' 1.2.3',
    ])
      expect(bad).not.toMatch(SEMVER);
  });
});

describe('dev versions', () => {
  it('start from 0.0.0 and the first commit before the first release tag', () => {
    expect(devVersion(dir, NOW)).toBe(`0.0.0+dev.${STAMP}`); // not a git checkout
    git('init', '-q');
    expect(devVersion(dir, NOW)).toBe(`0.0.0+dev.${STAMP}`); // no commits yet
    commit('one');
    const sha = commit('two');
    expect(devVersion(dir, NOW)).toBe(`0.0.0+dev.2.g${sha}.${STAMP}`);
    writeFileSync(join(dir, 'file'), 'changed');
    expect(devVersion(dir, NOW)).toBe(`0.0.0+dev.2.g${sha}.dirty.${STAMP}`);
  });

  it('ignore tags that are not a release', () => {
    git('init', '-q');
    commit('one');
    git('tag', '-a', '-m', 'not a release', 'demo');
    git('tag', 'v1.2');
    git('tag', 'latest');
    const sha = commit('two');
    expect(devVersion(dir, NOW)).toBe(`0.0.0+dev.2.g${sha}.${STAMP}`);
  });

  it('see past a tag that is not a release to the release tag before it', () => {
    git('init', '-q');
    commit('one');
    git('tag', 'v0.1.0');
    commit('two');
    git('tag', 'v1.2');
    const sha = commit('three');
    expect(devVersion(dir, NOW)).toBe(`0.1.0+dev.2.g${sha}.${STAMP}`);
  });

  it('count the commits since the last release tag', () => {
    git('init', '-q');
    commit('one');
    const tagged = commit('two');
    git('tag', 'v0.1.0'); // release-please tags through GitHub: a lightweight tag
    expect(devVersion(dir, NOW)).toBe(`0.1.0+dev.0.g${tagged}.${STAMP}`);
    commit('three');
    const sha = commit('four');
    expect(devVersion(dir, NOW)).toBe(`0.1.0+dev.2.g${sha}.${STAMP}`);
    writeFileSync(join(dir, 'file'), 'changed');
    expect(devVersion(dir, NOW)).toBe(`0.1.0+dev.2.g${sha}.dirty.${STAMP}`);
    git('commit', '-q', '-am', 'five');
    git('tag', '-a', '-m', 'v0.2.0-rc.1', 'v0.2.0-rc.1');
    const rc = commit('six');
    expect(devVersion(dir, NOW)).toBe(`0.2.0-rc.1+dev.1.g${rc}.${STAMP}`);
  });

  it('are a release version with build metadata', () => {
    const versions = [devVersion(dir, NOW)];
    git('init', '-q');
    commit('one');
    versions.push(devVersion(dir, NOW));
    git('tag', 'v0.2.0-rc.1');
    writeFileSync(join(dir, 'file'), 'changed');
    versions.push(devVersion(dir, NOW));
    for (const version of versions) {
      const [release = '', build = ''] = version.split('+');
      expect(release).toMatch(SEMVER);
      expect(build).toMatch(/^dev(\.[0-9A-Za-z-]+)+$/);
    }
  });
});
