#!/usr/bin/env node
// Builds artefacts from blawar/titledb:
//   data/titledb-jp.json  — [{nsuid, name, nameEn?}] for word-match fallback
//   data/titledb-hk.json  — [{nsuid, name, nameEn?}] for word-match fallback
//   data/titledb-au.json  — [{nsuid, name}] for word-match fallback
//   data/titledb-sg.json  — [{nsuid, name}] for word-match fallback
//   data/titledb-xref.json — {titleId: {jp?, hk?, us?, au?, sg?}} for direct cross-region lookup
// Run daily by .github/workflows/update-titledb.yml.
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

  const [usRaw, jpRaw, hkRaw, auRaw, sgRaw] = await Promise.all([
    fetchRaw('US.en.json'),
    fetchRaw('JP.ja.json'),
    fetchRaw('HK.zh.json'),
    fetchRaw('AU.en.json'),
    fetchRaw('SG.en.json'),
  ]);

  // titleId -> English name (from US)
  const enByTitleId = new Map();
  // titleId -> US nsuid
  const usNsuidByTitleId = new Map();
  for (const nsuid in usRaw) {
    const e = usRaw[nsuid];
    if (!e?.name) continue;
    if (e.id) {
      enByTitleId.set(e.id, e.name);
      usNsuidByTitleId.set(e.id, nsuid);
    }
  }
  console.log(`US index: ${enByTitleId.size} titles`);

  // xref: titleId -> { jp?, hk?, us?, au?, sg? }
  const xref = {};

  function buildEntries(raw, region) {
    const entries = [];
    for (const nsuid in raw) {
      const e = raw[nsuid];
      if (!e?.name) continue;
      const entry = { nsuid, name: e.name };
      const nameEn = e.id ? enByTitleId.get(e.id) : null;
      if (nameEn && nameEn !== e.name) entry.nameEn = nameEn;
      entries.push(entry);
      if (e.id) {
        if (!xref[e.id]) xref[e.id] = {};
        xref[e.id][region] = nsuid;
        const usNsuid = usNsuidByTitleId.get(e.id);
        if (usNsuid) xref[e.id].us = usNsuid;
      }
    }
    return entries;
  }

  const jpEntries = buildEntries(jpRaw, 'jp');
  const hkEntries = buildEntries(hkRaw, 'hk');
  const auEntries = buildEntries(auRaw, 'au');
  const sgEntries = buildEntries(sgRaw, 'sg');

  // Also add US entries to xref for US nsuid -> titleId reverse lookup
  for (const nsuid in usRaw) {
    const e = usRaw[nsuid];
    if (!e?.id) continue;
    if (!xref[e.id]) xref[e.id] = {};
    xref[e.id].us = nsuid;
  }

  await writeFile('data/titledb-jp.json', JSON.stringify(jpEntries));
  await writeFile('data/titledb-hk.json', JSON.stringify(hkEntries));
  await writeFile('data/titledb-au.json', JSON.stringify(auEntries));
  await writeFile('data/titledb-sg.json', JSON.stringify(sgEntries));
  await writeFile('data/titledb-xref.json', JSON.stringify(xref));

  const count = (field) => Object.values(xref).filter(v => v[field]).length;
  console.log(`✓ data/titledb-jp.json — ${jpEntries.length} titles (${jpEntries.filter(e => e.nameEn).length} with English name)`);
  console.log(`✓ data/titledb-hk.json — ${hkEntries.length} titles (${hkEntries.filter(e => e.nameEn).length} with English name)`);
  console.log(`✓ data/titledb-au.json — ${auEntries.length} titles (${auEntries.filter(e => e.nameEn).length} with English name)`);
  console.log(`✓ data/titledb-sg.json — ${sgEntries.length} titles (${sgEntries.filter(e => e.nameEn).length} with English name)`);
  console.log(`✓ data/titledb-xref.json — ${Object.keys(xref).length} title IDs (jp:${count('jp')} hk:${count('hk')} au:${count('au')} sg:${count('sg')})`);
}

main().catch(e => { console.error(e); process.exit(1); });
