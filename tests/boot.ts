// The boot catalog built from the real bundled packs, resolved by the sidecar as it would send it.
import { execFileSync } from 'node:child_process';
import type { Boot } from '../src/core/catalog.js';

export const bundledBoot = (): Boot => {
  const out = execFileSync('python3', ['-m', 'polykey.packs', 'packs', 'packs/pack.schema.json'],
    { env: { ...process.env, PYTHONPATH: 'sidecar' }, encoding: 'utf8' });
  const { catalog, errors } = JSON.parse(out) as Pick<Boot, 'catalog' | 'errors'>;
  return { catalog, settings: { keyboards: ['en/english', 'ja/12key', 'ja/50on', 'ja/romaji', 'ja/jis'], theme: 'themes/steam' }, errors };
};
