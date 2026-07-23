#!/usr/bin/env node
// Builds data/hk-catalog.json — [{nsuid, name}] for Hong Kong eShop NSUID lookup.
// Tries search.nintendo.jp/nintendo_soft_hk first, falls back to searching.nintendo-asia.com/zh_HK.
import { mkdir, writeFile } from 'node:fs/promises';

const ENDPOINTS = [
  {
    base: 'https://search.nintendo.jp/nintendo_soft_hk/search.json',
    fetchPage: async (page, headers) => {
      const params = new URLSearchParams({ opt_sshow: '1', limit: '200', page: String(page + 1) });
      const res = await fetch(`https://search.nintendo.jp/nintendo_soft_hk/search.json?${params}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.result?.total) throw new Error('empty result');
      return data;
    },
    getTotal: d => d?.result?.total ?? 0,
    getItems: d => d?.result?.items ?? [],
  },
  {
    base: 'https://searching.nintendo-asia.com/zh_HK/select',
    fetchPage: async (page, headers) => {
      const params = new URLSearchParams({ q: '*', fq: 'type:GAME', rows: '200', start: String(page * 200), wt: 'json', fl: 'title,nsuid_txt,title_id_txt' });
      const res = await fetch(`https://searching.nintendo-asia.com/zh_HK/select?${params}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    getTotal: d => d?.response?.numFound ?? 0,
    getItems: d => (d?.response?.docs ?? []).map(doc => ({
      nsuid: (doc.nsuid_txt || [])[0],
      title: doc.title,
      title_id: (doc.title_id_txt || [])[0],
    })),
  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://store.nintendo.com.hk/',
};

async function main() {
  await mkdir('data', { recursive: true });

  const NSUID_RE = /^700[0-9]\d{10}$/;
  const TITLE_ID_RE = /^0[14]00[0-9a-f]{12}$/i;

  for (const ep of ENDPOINTS) {
    console.log(`Trying ${ep.base}...`);
    try {
      const first = await ep.fetchPage(0, HEADERS);
      const total = ep.getTotal(first);
      const LIMIT = 200;
      const totalPages = Math.ceil(total / LIMIT);
      console.log(`Total: ${total} games, ${totalPages} pages`);

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

      addItems(ep.getItems(first));

      for (let page = 1; page < totalPages; page++) {
        const data = await ep.fetchPage(page, HEADERS);
        addItems(ep.getItems(data));
        process.stdout.write(`\r  Page ${page + 1}/${totalPages} — ${entries.length} entries`);
      }
      console.log();

      await writeFile('data/hk-catalog.json', JSON.stringify(entries));
      console.log(`✓ data/hk-catalog.json — ${entries.length} HK titles`);
      if (entries.length) console.log('Sample:', JSON.stringify(entries[0]));
      return;
    } catch (e) {
      console.log(`  ✗ ${e.message} — trying next endpoint`);
    }
  }

  // All endpoints failed — keep existing file if present
  console.log('All HK catalog endpoints unavailable — keeping existing data/hk-catalog.json');
}

main().catch(e => { console.error(e); process.exit(1); });
