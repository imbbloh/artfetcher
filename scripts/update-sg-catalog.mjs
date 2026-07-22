#!/usr/bin/env node
// Builds data/sg-catalog.json — [{nsuid, name}] for Singapore eShop NSUID lookup.
// Primary: nintendo-asia.com Solr endpoint (same style as EU/HK catalogs)
// Fallback: scrape nintendo.com/sg/games/switch/index.html?sftab=all
import { mkdir, writeFile } from 'node:fs/promises';

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-SG,en;q=0.9' };

async function fetchSolr() {
  console.log('Trying nintendo-asia.com Solr (en_SG)...');
  const url = 'https://searching.nintendo-asia.com/en_SG/select?q=*:*&fq=type%3AGAME&rows=9999&wt=json&fl=title,nsuid_txt';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Solr HTTP ${res.status}`);
  const data = await res.json();
  const docs = data?.response?.docs || [];
  if (!docs.length) throw new Error('Solr returned 0 docs');
  const entries = [];
  for (const d of docs) {
    for (const nsuid of (d.nsuid_txt || [])) {
      if (/^700[0-9]\d{10}$/.test(nsuid) && d.title) {
        entries.push({ nsuid, name: d.title });
      }
    }
  }
  console.log(`Solr: ${entries.length} entries`);
  return entries;
}

async function fetchHtml() {
  console.log('Trying nintendo.com/sg HTML scrape...');
  const url = 'https://www.nintendo.com/sg/games/switch/index.html?sftab=all';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTML HTTP ${res.status}`);
  const html = await res.text();

  // Extract NSUIDs from detail page links: /sg/games/detail.html?id=70010000122828
  const linkRe = /\/sg\/games\/detail\.html\?id=(\d{14})/g;
  const nsuidSet = new Set();
  let m;
  while ((m = linkRe.exec(html)) !== null) nsuidSet.add(m[1]);

  if (!nsuidSet.size) throw new Error('HTML: no NSUIDs found');

  // Try to extract titles from JSON blob (Nintendo often embeds __NEXT_DATA__ or similar)
  const nameMap = new Map();
  const jsonBlob = html.match(/<script[^>]*>\s*window\.__.*?=\s*(\{[\s\S]*?\})\s*;<\/script>/);
  if (jsonBlob) {
    try {
      const extractTitles = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.nsuid && obj.title) nameMap.set(String(obj.nsuid), obj.title);
        for (const v of Object.values(obj)) extractTitles(v);
      };
      extractTitles(JSON.parse(jsonBlob[1]));
    } catch {}
  }

  // Fallback: try to match title text near each NSUID link in raw HTML
  for (const nsuid of nsuidSet) {
    if (nameMap.has(nsuid)) continue;
    const idx = html.indexOf(`?id=${nsuid}`);
    if (idx === -1) continue;
    // Look for a title-like string in the surrounding 800 chars
    const snippet = html.slice(Math.max(0, idx - 400), idx + 400);
    const titleMatch = snippet.match(/(?:alt|title|aria-label)="([^"]{3,80})"/);
    if (titleMatch) nameMap.set(nsuid, titleMatch[1]);
  }

  const entries = [...nsuidSet].map(nsuid => ({ nsuid, name: nameMap.get(nsuid) || '' })).filter(e => e.name);
  console.log(`HTML: ${entries.length} entries with names (${nsuidSet.size} NSUIDs total)`);
  return entries.length ? entries : [...nsuidSet].map(nsuid => ({ nsuid, name: '' }));
}

async function main() {
  await mkdir('data', { recursive: true });

  let entries = [];
  try {
    entries = await fetchSolr();
  } catch (e) {
    console.warn(`Solr failed: ${e.message} — falling back to HTML scrape`);
    try {
      entries = await fetchHtml();
    } catch (e2) {
      console.error(`HTML scrape also failed: ${e2.message}`);
      process.exit(1);
    }
  }

  await writeFile('data/sg-catalog.json', JSON.stringify(entries));
  console.log(`✓ data/sg-catalog.json — ${entries.length} SG titles`);
}

main().catch(e => { console.error(e); process.exit(1); });
