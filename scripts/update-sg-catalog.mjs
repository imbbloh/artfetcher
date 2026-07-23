#!/usr/bin/env node
// Builds data/sg-catalog.json — [{nsuid, name}] for Singapore eShop NSUID lookup.
// Uses the search.nintendo.jp/nintendo_soft_sg API (same backend as nintendo.com/sg).
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://search.nintendo.jp/nintendo_soft_sg/search.json';
const LIMIT = 200;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.nintendo.com/',
};

async function fetchPage(page) {
  const params = new URLSearchParams({
    opt_sshow: '1',
    limit: String(LIMIT),
    page: String(page),
  });
  // No opt_hard filter — return all hardware so Switch 1 and Switch 2 titles are included
  const res = await fetch(`${BASE}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  await mkdir('data', { recursive: true });

  console.log('Fetching SG catalog from search.nintendo.jp...');
  const first = await fetchPage(1);
  const total = first?.result?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);
  console.log(`Total: ${total} games, ${totalPages} pages`);

  const NSUID_RE = /^700[0-9]\d{10}$/;
  const TITLE_ID_RE = /^0[14]00[0-9a-f]{12}$/i;
  const entries = [];
  const addItems = (items) => {
    for (const item of (items || [])) {
      if (!item.nsuid || !NSUID_RE.test(String(item.nsuid)) || !item.title) continue;
      const entry = { nsuid: String(item.nsuid), name: item.title };
      const id = item.title_id || item.titleId || item.product_id;
      if (id && TITLE_ID_RE.test(String(id))) entry.id = String(id).toLowerCase();
      entries.push(entry);
    }
  };

  addItems(first?.result?.items);

  for (let page = 2; page <= totalPages; page++) {
    const data = await fetchPage(page);
    addItems(data?.result?.items);
    process.stdout.write(`\r  Page ${page}/${totalPages} — ${entries.length} entries`);
  }
  console.log();

  await writeFile('data/sg-catalog.json', JSON.stringify(entries));
  console.log(`✓ data/sg-catalog.json — ${entries.length} SG titles`);
}

main().catch(e => { console.error(e); process.exit(1); });
