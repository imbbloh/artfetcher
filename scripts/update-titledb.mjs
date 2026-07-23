#!/usr/bin/env node
// Builds artefacts from blawar/titledb:
//   data/titledb-{us,jp,hk,au,ca,br,mx}.json — [{nsuid, name, nameEn?}] for word-match fallback
//   data/titledb-xref.json — {titleId: {us?,jp?,hk?,au?,ca?,br?,mx?}} for cross-region lookup
// Note: SG.en.json does not exist in blawar/titledb; SG uses HK gap-probing instead.
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

  const [usRaw, jpRaw, hkRaw, auRaw, caRaw, brRaw, mxRaw] = await Promise.all([
    fetchRaw('US.en.json'),
    fetchRaw('JP.ja.json'),
    fetchRaw('HK.zh.json'),
    fetchRaw('AU.en.json'),
    fetchRaw('CA.en.json'),
    fetchRaw('BR.pt.json'),
    fetchRaw('MX.es.json'),
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

  // xref: titleId -> { us?, jp?, hk?, au?, sg?, ca?, br?, mx? }
  const xref = {};

  function buildEntries(raw, region) {
    const entries = [];
    for (const nsuid in raw) {
      const e = raw[nsuid];
      if (!e?.name) continue;
      const entry = { nsuid, name: e.name };
      if (e.id) entry.id = e.id;
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

  // US entries: build word-match list and seed xref us field
  const usEntries = [];
  for (const nsuid in usRaw) {
    const e = usRaw[nsuid];
    if (!e?.name) continue;
    const entry = { nsuid, name: e.name };
    if (e.id) entry.id = e.id;
    usEntries.push(entry);
    if (e.id) {
      if (!xref[e.id]) xref[e.id] = {};
      xref[e.id].us = nsuid;
    }
  }

  const jpEntries = buildEntries(jpRaw, 'jp');
  const hkEntries = buildEntries(hkRaw, 'hk');
  const auEntries = buildEntries(auRaw, 'au');
  const caEntries = buildEntries(caRaw, 'ca');
  const brEntries = buildEntries(brRaw, 'br');
  const mxEntries = buildEntries(mxRaw, 'mx');

  const files = {
    'titledb-us.json': usEntries,
    'titledb-jp.json': jpEntries,
    'titledb-hk.json': hkEntries,
    'titledb-au.json': auEntries,
    'titledb-ca.json': caEntries,
    'titledb-br.json': brEntries,
    'titledb-mx.json': mxEntries,
  };

  await Promise.all([
    ...Object.entries(files).map(([f, data]) => writeFile(`data/${f}`, JSON.stringify(data))),
    writeFile('data/titledb-xref.json', JSON.stringify(xref)),
  ]);

  const count = (field) => Object.values(xref).filter(v => v[field]).length;
  for (const [f, data] of Object.entries(files)) {
    const withEn = data.filter(e => e.nameEn).length;
    console.log(`✓ data/${f} — ${data.length} titles${withEn ? ` (${withEn} with English name)` : ''}`);
  }
  const fields = ['us', 'jp', 'hk', 'au', 'ca', 'br', 'mx'];
  console.log(`✓ data/titledb-xref.json — ${Object.keys(xref).length} title IDs (${fields.map(f => `${f}:${count(f)}`).join(' ')})`);
}

main().catch(e => { console.error(e); process.exit(1); });
