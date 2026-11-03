// Build dist/stage/ (bundle.js, probe.js, VERSION, sidecar/): the tree deploy.sh copies to the Frame.
// Usage: node scripts/build.mjs [--debug]   (--debug: unminified)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

const BUNDLE_BUDGET_BYTES = 120 * 1024;
const debug = process.argv.includes('--debug');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const version = `${pkg.version}+${stamp}${debug ? '.debug' : ''}`;
const stage = 'dist/stage';

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !debug,
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
console.log(`polykey ${version}: bundle.js ${(size / 1024).toFixed(1)} KB (budget ${BUNDLE_BUDGET_BYTES / 1024} KB)`);
if (size > BUNDLE_BUDGET_BYTES) {
  console.error('bundle.js is over budget');
  process.exit(1);
}
