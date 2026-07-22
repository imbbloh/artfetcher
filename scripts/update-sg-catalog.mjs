#!/usr/bin/env node
// Builds data/sg-catalog.json — [{nsuid, name}] for Singapore eShop NSUID lookup.
// Tries multiple approaches in order:
//   1. nintendo-asia.com Solr (various locale codes)
//   2. Playwright — renders nintendo.com/sg/games/switch/index.html?sftab=all
//      and extracts NSUIDs + titles from the rendered DOM
import { mkdir, writeFile } from 'node:fs/promises';

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-SG,en;q=0.9' };
const NSUID_RE = /^700[0-9]\d{10}$/;

async function tryFetch(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fetchSolr() {
  const locales = ['en_SG', 'sg_en', 'en_MY', 'en_AU']; // try candidates
  for (const locale of locales) {
    const url = `https://searching.nintendo-asia.com/${locale}/select?q=*:*&fq=type%3AGAME&rows=9999&wt=json&fl=title,nsuid_txt`;
    try {
      console.log(`Trying Solr locale ${locale}...`);
      const res = await tryFetch(url);
      const data = await res.json();
      const docs = data?.response?.docs || [];
      if (!docs.length) { console.log(`  ${locale}: 0 docs`); continue; }
      const entries = [];
      for (const d of docs)
        for (const nsuid of (d.nsuid_txt || []))
          if (NSUID_RE.test(nsuid) && d.title) entries.push({ nsuid, name: d.title });
      if (entries.length) { console.log(`  ${locale}: ${entries.length} entries`); return entries; }
    } catch (e) { console.log(`  ${locale}: ${e.message}`); }
  }
  throw new Error('All Solr locales failed');
}

async function fetchPlaywright() {
  console.log('Trying Playwright render of nintendo.com/sg...');
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    // Try playwright-core or system chromium
    try {
      const pw = await import('playwright-core');
      chromium = pw.chromium;
    } catch { throw new Error('playwright not installed'); }
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    || '/usr/bin/chromium-browser'
    || '/usr/bin/chromium';

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] }).catch(() =>
    chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  );

  try {
    const page = await browser.newPage();
    await page.goto('https://www.nintendo.com/sg/games/switch/index.html?sftab=all', { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for game cards to appear
    await page.waitForSelector('a[href*="?id="]', { timeout: 20000 }).catch(() => {});

    const entries = await page.evaluate(() => {
      const results = [];
      // Extract from links with ?id=NSUID
      document.querySelectorAll('a[href*="?id="]').forEach(el => {
        const m = el.href.match(/\?id=(\d{14})/);
        if (!m) return;
        const nsuid = m[1];
        // Try various ways to get the title
        const name = el.querySelector('h2,h3,.title,.game-title')?.textContent?.trim()
          || el.getAttribute('title')
          || el.getAttribute('aria-label')
          || el.closest('[data-title]')?.dataset?.title
          || '';
        if (name) results.push({ nsuid, name });
      });
      return results;
    });

    console.log(`Playwright: ${entries.length} entries`);
    if (!entries.length) throw new Error('Playwright: no entries found');
    return entries;
  } finally {
    await browser.close();
  }
}

async function main() {
  await mkdir('data', { recursive: true });

  let entries = [];

  // 1. Solr
  try { entries = await fetchSolr(); } catch (e) {
    console.warn(`Solr: ${e.message}`);

    // 2. Playwright
    try { entries = await fetchPlaywright(); } catch (e2) {
      console.error(`Playwright: ${e2.message}`);
      process.exit(1);
    }
  }

  await writeFile('data/sg-catalog.json', JSON.stringify(entries));
  console.log(`✓ data/sg-catalog.json — ${entries.length} SG titles`);
}

main().catch(e => { console.error(e); process.exit(1); });
