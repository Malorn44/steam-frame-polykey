// The boot catalog built from the real bundled packs, as the sidecar would send it.
import { readdirSync, readFileSync } from 'node:fs';
import type { Boot } from '../src/core/catalog.js';

export const bundledBoot = (): Boot => {
  const boot: Boot = { catalog: { layouts: {}, keyboards: {}, themes: {} }, settings: { keyboards: ['en/english', 'ja/12key'], theme: 'themes/steam' }, errors: [] };
  for (const ns of readdirSync('packs')) {
    for (const file of readdirSync(`packs/${ns}`).filter((f) => f.endsWith('.json'))) {
      const item = JSON.parse(readFileSync(`packs/${ns}/${file}`, 'utf8'));
      delete item.$schema;
      boot.catalog[`${item.kind}s` as 'layouts'][item.id] = item;
    }
  }
  return boot;
};
