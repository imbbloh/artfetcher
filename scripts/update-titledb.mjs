#!/usr/bin/env node
// Pre-processes blawar/titledb's per-region catalogs down to just {nsuid, name}
// pairs for the regions where the bot's live catalog search is least reliable
// (JP, HK) — run periodically by .github/workflows/update-titledb.yml, output
// committed to data/, and read by server.js at request time. Keeps the raw
// 50-80MB source files out of the live request path entirely.
import { mkdir, writeFile } from 'node:fs/promises';

const TITLEDB_BASE = 'https://raw.githubusercontent.com/blawar/titledb/master';
const REGIONS = { jp: 'JP.ja.json', hk: 'HK.zh.json' };

async function updateRegion(region, file) {
  console.log(`Fetching ${file}...`);
  const res = await fetch(`${TITLEDB_BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const raw = await res.json();
  const entries = [];
  for (const nsuid in raw) {
    const name = raw[nsuid]?.name;
    if (name) entries.push({ nsuid, name });
  }
  await writeFile(`data/titledb-${region}.json`, JSON.stringify(entries));
  console.log(`✓ data/titledb-${region}.json — ${entries.length} titles`);
}

async function main() {
  await mkdir('data', { recursive: true });
  for (const [region, file] of Object.entries(REGIONS)) {
    await updateRegion(region, file);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
