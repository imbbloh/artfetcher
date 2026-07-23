#!/usr/bin/env node
// Builds data/hk-catalog.json — [{nsuid, name}] for Hong Kong eShop NSUID lookup.
// Uses the searching.nintendo-asia.com/zh_HK Solr API.
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://searching.nintendo-asia.com/zh_HK/select';
const ROWS = 200;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://store.nintendo.com.hk/',
};

const NSUID_RE = /^700[0-9]\d{10}$/;
const TITLE_ID_RE = /^0[14]00[0-9a-f]{12}$/i;

async function fetchPage(start) {
  const params = new URLSearchParams({
    q: '*',
    fq: 'type:GAME',
    rows: String(ROWS),
    start: String(start),
    wt: 'json',
    fl: 'title,nsuid_txt,title_id_txt,image_url_h2x1_txt',
  });
  const res = await fetch(`${BASE}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  await mkdir('data', { recursive: true });

  console.log('Fetching HK catalog from searching.nintendo-asia.com...');
  const first = await fetchPage(0);
  const total = first?.response?.numFound ?? 0;
  const totalPages = Math.ceil(total / ROWS);
  console.log(`Total: ${total} games, ${totalPages} pages`);

  const entries = [];
  const addDocs = (docs) => {
    for (const doc of (docs || [])) {
      const nsuid = (doc.nsuid_txt || [])[0];
      if (!nsuid || !NSUID_RE.test(String(nsuid)) || !doc.title) continue;
      const entry = { nsuid: String(nsuid), name: doc.title };
      const id = (doc.title_id_txt || [])[0];
      if (id && TITLE_ID_RE.test(String(id))) entry.id = String(id).toLowerCase();
      entries.push(entry);
    }
  };

  addDocs(first?.response?.docs);

  for (let page = 1; page < totalPages; page++) {
    const data = await fetchPage(page * ROWS);
    addDocs(data?.response?.docs);
    process.stdout.write(`\r  Page ${page + 1}/${totalPages} — ${entries.length} entries`);
  }
  console.log();

  await writeFile('data/hk-catalog.json', JSON.stringify(entries));
  console.log(`✓ data/hk-catalog.json — ${entries.length} HK titles`);
  if (entries.length) console.log('Sample:', JSON.stringify(entries[0]));
}

main().catch(e => { console.error(e); process.exit(1); });
