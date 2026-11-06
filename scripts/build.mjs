// Build dist/stage/ (bundle.js, probe.js, VERSION, sidecar/): the tree deploy.sh copies to the Frame.
// Usage: node scripts/build.mjs [--debug] [--version X.Y.Z]   (npm run build -- --version X.Y.Z)
//   --debug    unminified, CSS as written
//   --version  a release build: exactly this version (release-please picks it from the commits)
// Without --version the build is a dev build, named after the last release tag (scripts/version.mjs).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
cpSync('sidecar/run.py', `${stage}/sidecar/run.py`);
cpSync('packs', `${stage}/packs`, { recursive: true });
cpSync('schema', `${stage}/schema`, { recursive: true });
cpSync('sidecar/polykey', `${stage}/sidecar/polykey`, {
  recursive: true,
  filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
});

const size = statSync(`${stage}/bundle.js`).size;
console.log(`polykey ${version}: bundle.js ${(size / 1024).toFixed(1)} KB`);
