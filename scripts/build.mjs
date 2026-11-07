// Build dist/stage/ (bundle.js, probe.js, VERSION, sidecar/): the tree deploy.sh copies to the Frame,
// and the inside of a release tarball (scripts/release.sh).
// Usage: node scripts/build.mjs [--debug] [--version X.Y.Z]   (npm run build -- --version X.Y.Z)
//   --debug    unminified, CSS as written
//   --version  a release build: exactly this version (release-please picks it from the commits)
// Without --version the build is a dev build, named after the last release tag (scripts/version.mjs).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cssMinify } from './css-minify.mjs';
import { SEMVER, devVersion } from './version.mjs';

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const at = args.indexOf('--version');
const release = at >= 0 ? (args[at + 1] ?? '') : null;
if (release !== null && !SEMVER.test(release)) {
  console.error(`build: --version needs a version like 1.2.3 or 1.2.3-rc.1, not "${release}"`);
  process.exit(2);
}
// The release key (POLYKEY_ALLOWED_SIGNERS names another key file, for the installer tests). A release
// without one could not check its updates, so a release build stops here, before it touches dist/stage.
const signersFile = process.env.POLYKEY_ALLOWED_SIGNERS || 'contrib/allowed_signers';
const signers = readFileSync(signersFile, 'utf8');
const keys = signers.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
if (keys.some((line) => line.includes("'"))) throw new Error('allowed_signers: a key line with a quote in it');
if (release !== null && !keys.some((line) => /^polykey-release .*ssh-ed25519 /.test(line))) {
  console.error(`build: no release key in ${signersFile} (the top of contrib/allowed_signers says how to add one)`);
  process.exit(1);
}
const version = `${release ?? devVersion()}${debug ? (release ? '+debug' : '.debug') : ''}`;
const stage = 'dist/stage';

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !debug,
  plugins: debug ? [] : [cssMinify],
  legalComments: 'none',
  define: { __POLYKEY_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: ['src/entry.ts'], outfile: `${stage}/bundle.js` });
await build({ ...common, entryPoints: ['src/probe.ts'], outfile: `${stage}/probe.js`, globalName: '__polykeyProbe' });

writeFileSync(`${stage}/VERSION`, `${version}\n`);
// What a release carries besides the code: its licences (where they sit in the repo, so the notices'
// ../LICENSE link holds), the unit, the installer, and the release key.
for (const file of ['LICENSE', 'docs/THIRD-PARTY-NOTICES.md']) cpSync(file, `${stage}/${file}`);
cpSync('contrib/polykey.service', `${stage}/polykey.service`);
writeFileSync(`${stage}/allowed_signers`, signers);
const installer = readFileSync('scripts/install.sh', 'utf8').replace('@ALLOWED_SIGNERS@', () => keys.join('\n'));
writeFileSync(`${stage}/install.sh`, installer, { mode: 0o755 });
cpSync('sidecar/run.py', `${stage}/sidecar/run.py`);
cpSync('packs', `${stage}/packs`, { recursive: true });
cpSync('schema', `${stage}/schema`, { recursive: true });
cpSync('sidecar/polykey', `${stage}/sidecar/polykey`, {
  recursive: true,
  filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
});

const size = statSync(`${stage}/bundle.js`).size;
console.log(`polykey ${version}: bundle.js ${(size / 1024).toFixed(1)} KB`);
