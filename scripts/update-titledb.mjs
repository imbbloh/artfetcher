#!/usr/bin/env node
// Pre-processes blawar/titledb's per-region catalogs down to just {nsuid, name, nameEn?}
// pairs for the regions where the bot's live catalog search is least reliable
// (JP, HK) — run periodically by .github/workflows/update-titledb.yml, output
// committed to data/, and read by server.js at request time. Keeps the raw
// 50-80MB source files out of the live request path entirely.
import { mkdir, writeFile } from 'node:fs/promises';

const TITLEDB_BASE = 'https://raw.githubusercontent.com/blawar/titledb/master';

async function fetchRaw(file) {
  console.log(`Fetching ${file}...`);
  const res = await fetch(`${TITLEDB_BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  await mkdir('data', { recursive: true });

  // Build titleId -> English name map from US catalog for cross-region matching
  const usRaw = await fetchRaw('US.en.json');
  const enByTitleId = new Map();
  for (const nsuid in usRaw) {
    const entry = usRaw[nsuid];
    if (entry?.id && entry?.name) enByTitleId.set(entry.id, entry.name);
  }
  console.log(`US English index: ${enByTitleId.size} titles`);

  // JP — Japanese names, enriched with English name via shared title ID
  const jpRaw = await fetchRaw('JP.ja.json');
  const jpEntries = [];
  for (const nsuid in jpRaw) {
    const entry = jpRaw[nsuid];
    if (!entry?.name) continue;
    const e = { nsuid, name: entry.name };
    const nameEn = entry.id ? enByTitleId.get(entry.id) : null;
    if (nameEn && nameEn !== entry.name) e.nameEn = nameEn;
    jpEntries.push(e);
  }
  await writeFile('data/titledb-jp.json', JSON.stringify(jpEntries));
  console.log(`✓ data/titledb-jp.json — ${jpEntries.length} titles (${jpEntries.filter(e => e.nameEn).length} with English name)`);

  // HK — often has English names already, same enrichment for any that don't
  const hkRaw = await fetchRaw('HK.zh.json');
  const hkEntries = [];
  for (const nsuid in hkRaw) {
    const entry = hkRaw[nsuid];
    if (!entry?.name) continue;
    const e = { nsuid, name: entry.name };
    const nameEn = entry.id ? enByTitleId.get(entry.id) : null;
    if (nameEn && nameEn !== entry.name) e.nameEn = nameEn;
    hkEntries.push(e);
  }
  await writeFile('data/titledb-hk.json', JSON.stringify(hkEntries));
  console.log(`✓ data/titledb-hk.json — ${hkEntries.length} titles (${hkEntries.filter(e => e.nameEn).length} with English name)`);
}

main().catch(e => { console.error(e); process.exit(1); });
