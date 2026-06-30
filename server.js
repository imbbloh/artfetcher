#!/usr/bin/env node
'use strict';
const express = require('express');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const COUNTRY_CODE = {
  'United States': 'US', 'Singapore': 'SG', 'Hong Kong': 'HK',
  'Brazil': 'BR', 'Japan': 'JP', 'Canada': 'CA', 'Mexico': 'MX', 'Australia': 'AU',
};
const TARGET_COUNTRIES = Object.keys(COUNTRY_CODE);

const COUNTRY_CURRENCY = {
  'United States': 'USD', 'Singapore': 'SGD', 'Hong Kong': 'HKD',
  'Brazil': 'BRL', 'Japan': 'JPY', 'Canada': 'CAD', 'Mexico': 'MXN', 'Australia': 'AUD',
};

const COUNTRY_FLAG = {
  'United States': '🇺🇸', 'Singapore': '🇸🇬', 'Hong Kong': '🇭🇰',
  'Brazil': '🇧🇷', 'Japan': '🇯🇵', 'Canada': '🇨🇦', 'Mexico': '🇲🇽', 'Australia': '🇦🇺',
};

const GIFT_CARD_DENOMS = {
  USD: [5, 10], SGD: null, HKD: null, BRL: [30, 50],
  JPY: [500, 1000], CAD: [10, 20, 25], MXN: [100, 200, 350], AUD: [15],
};

// eShop URL per country using the matched nsuid
const ESHOP_URL = {
  'United States': (id) => `https://ec.nintendo.com/US/en/titles/${id}`,
  'Canada':        (id) => `https://ec.nintendo.com/CA/en/titles/${id}`,
  'Brazil':        (id) => `https://ec.nintendo.com/BR/pt/titles/${id}`,
  'Mexico':        (id) => `https://ec.nintendo.com/MX/es/titles/${id}`,
  'Australia':     (id) => `https://ec.nintendo.com/AU/en/titles/${id}`,
  'Japan':         (id) => `https://ec.nintendo.com/JP/ja/titles/${id}`,
  'Hong Kong':     (id) => `https://ec.nintendo.com/HK/zh/titles/${id}`,
  'Singapore':     (id) => `https://ec.nintendo.com/SG//titles/${id}`,
};

// CNY price per gift-card denomination. null = not set (falls back to live rate).
// Structure: { USD: { '5': 33, '10': 60 }, BRL: { '30': 40.9, '50': 62.9 }, ... }
const GC_CURRENCIES = ['USD', 'BRL', 'CAD', 'MXN', 'AUD'];
const GC_PRICES_FILE = path.join(__dirname, 'data', 'giftcard-prices.json');

let gcPrices = {
  USD: { '5': 30.5, '10': 59 },
  BRL: { '30': 40.9, '50': 59 },
  CAD: { '10': 49, '25': 124 },
  MXN: { '100': 34, '350': 119 },
  AUD: { '15': 77.5 },
};

function loadGcPrices() {
  try {
    const fs = require('fs');
    if (fs.existsSync(GC_PRICES_FILE)) {
      const saved = JSON.parse(fs.readFileSync(GC_PRICES_FILE, 'utf8'));
      // Fully replace gcPrices from file — avoids stale hardcoded denominations
      for (const [cur, denoms] of Object.entries(saved))
        if (cur in gcPrices && denoms && typeof denoms === 'object')
          gcPrices[cur] = Object.fromEntries(Object.entries(denoms).filter(([, v]) => typeof v === 'number' && v > 0));
    }
  } catch {}
}

function saveGcPrices() {
  try {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(GC_PRICES_FILE), { recursive: true });
    fs.writeFileSync(GC_PRICES_FILE, JSON.stringify(gcPrices, null, 2));
  } catch {}
}

loadGcPrices();
console.log('Gift card prices loaded:', JSON.stringify(gcPrices));

const cache = new Map();
let browserBusy = false; // only one Chromium at a time (Render 512MB RAM limit)
const CACHE_TTL = 4 * 60 * 60 * 1000;

let rateCache = null;
let rateCacheTime = 0;
const RATE_TTL = 60 * 60 * 1000;

let algoliaKeyCache = { key: null, time: 0 };
const ALGOLIA_KEY_TTL = 12 * 60 * 60 * 1000;
const ALGOLIA_APP_ID = 'U3B6GR4UA3';

// JP XML catalog cache — refreshed hourly
// Maps lowercase title → nsuid (14-digit string)
let jpXmlCache = { map: null, time: 0 };
const JP_XML_TTL = 60 * 60 * 1000;

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findChromiumExecutable() {
  const fs = require('fs');
  try { const p = require('playwright-core').chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  const known = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of known) { try { if (fs.existsSync(p)) return p; } catch {} }
}

// Returns the minimum total CNY cost to cover `amount` using available denominations.
// Uses DP (coin-change variant) to find cheapest combination of gift cards.
function minGiftCardCNY(amount, currency) {
  const denomPriceMap = gcPrices[currency];
  if (!denomPriceMap) return null;
  const denoms = Object.entries(denomPriceMap)
    .map(([d, cny]) => ({ denom: Number(d), cny }))
    .filter(d => d.cny != null && d.denom > 0);
  if (!denoms.length) return null;

  const target = Math.round(amount);
  const dp = new Array(target + 1).fill(Infinity);
  dp[0] = 0;
  for (let i = 1; i <= target; i++)
    for (const { denom, cny } of denoms)
      if (denom <= i && dp[i - denom] + cny < dp[i])
        dp[i] = dp[i - denom] + cny;

  return dp[target] === Infinity ? null : Math.round(dp[target] * 100) / 100;
}

function minGiftCardAmount(price, denoms) {
  if (!denoms || !denoms.length) return price;
  const target = Math.ceil(price);
  const maxSearch = target + Math.max(...denoms) * 2;
  const reachable = new Uint8Array(maxSearch + 1);
  reachable[0] = 1;
  for (let i = 1; i <= maxSearch; i++)
    for (const d of denoms)
      if (d <= i && reachable[i - d]) { reachable[i] = 1; break; }
  for (let i = target; i <= maxSearch; i++) if (reachable[i]) return i;
  return null;
}

function toNintendoSlug(name) {
  return String(name).toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ─── Exchange rates ────────────────────────────────────────────────────────────

async function getExchangeRates(emit) {
  const now = Date.now();
  if (rateCache && now - rateCacheTime < RATE_TTL) { emit('Using cached exchange rates.'); return rateCache; }
  emit('Fetching live exchange rates...');
  const baseCurrencies = [...new Set([...Object.values(COUNTRY_CURRENCY).filter(c => c !== 'SGD'), 'CNY'])].join(',');
  const res = await axios.get(`https://api.frankfurter.app/latest?from=SGD&to=${baseCurrencies}`, { timeout: 10000 });
  const rates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(res.data.rates)) rates[cur] = 1 / rate;
  rateCache = { rates, source: 'frankfurter.app / ECB (live daily)' };
  rateCacheTime = now;
  emit('Exchange rates ready.');
  return rateCache;
}

// ─── Algolia key (Nintendo.com JS bundle scan) ────────────────────────────────

async function getAlgoliaKey(emit) {
  const now = Date.now();
  if (algoliaKeyCache.key && now - algoliaKeyCache.time < ALGOLIA_KEY_TTL) return algoliaKeyCache.key;
  emit('Scanning Nintendo.com bundles for Algolia key...');
  try {
    const root = await axios.get('https://www.nintendo.com/', { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const bundles = [...new Set((String(root.data).match(/\/_next\/static\/[^"' ]+\.js/g) || []))].slice(0, 20);
    const results = await Promise.allSettled(bundles.map(p => axios.get(`https://www.nintendo.com${p}`, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } })));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const text = String(r.value.data);
      if (!text.includes(ALGOLIA_APP_ID)) continue;
      const m = text.match(new RegExp(`${ALGOLIA_APP_ID}.{0,150}?([a-f0-9]{32})|([a-f0-9]{32}).{0,150}?${ALGOLIA_APP_ID}`, 's'));
      const key = m?.[1] || m?.[2];
      if (key) { algoliaKeyCache = { key, time: now }; emit(`Algolia key: ${key.slice(0, 8)}...`); return key; }
    }
  } catch (e) { emit(`Algolia scan: ${e.message.slice(0, 60)}`); }
  return algoliaKeyCache.key;
}

// ─── JP XML catalog ───────────────────────────────────────────────────────────
// Nintendo publishes a full list of on-sale JP Switch titles as XML.
// We cache it for 1 hour and fuzzy-match by title to resolve JP NSUIDs.

async function getJpXmlCatalog(emit) {
  const now = Date.now();
  if (jpXmlCache.map && now - jpXmlCache.time < JP_XML_TTL) return jpXmlCache.map;

  const urls = [
    'https://www.nintendo.co.jp/data/software/xml-system/switch-onsale.xml',
    'https://www.nintendo.co.jp/data/software/xml-system/switch-coming.xml',
  ];

  const map = new Map(); // lowercase title → nsuid
  let fetched = 0;

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/xml,application/xml,*/*',
          'Accept-Language': 'ja,en;q=0.9',
          'Referer': 'https://www.nintendo.co.jp/',
        },
      });
      const xml = String(res.data);
      // Nintendo JP XML uses <TitleName> + <LinkURL>...D{nsuid}... per <TitleInfo> block.
      // Also try legacy <title>+<nsuid> and <nsuid>+<title> patterns as fallback.
      const titleNsuidPairs = [];
      let m;
      // Pattern A (primary): <TitleName>...</TitleName> ... <LinkURL>...D{nsuid}...</LinkURL>
      const pA = /<TitleName[^>]*>([\s\S]+?)<\/TitleName>[\s\S]{0,800}?<LinkURL>[^<]*D(700[0-9]\d{10})[^<]*<\/LinkURL>/gi;
      while ((m = pA.exec(xml)) !== null) titleNsuidPairs.push([m[1].trim(), m[2]]);
      // Pattern B: <TitleName> near <nsuid> tag (alternate schema)
      const pB = /<TitleName[^>]*>([\s\S]+?)<\/TitleName>[\s\S]{0,500}?<nsuid>(\d{14})<\/nsuid>/gi;
      while ((m = pB.exec(xml)) !== null) titleNsuidPairs.push([m[1].trim(), m[2]]);
      // Pattern C: <title> near <nsuid>
      const pC = /<title[^>]*>([^<]+)<\/title>[\s\S]{0,500}?<nsuid>(\d{14})<\/nsuid>/gi;
      while ((m = pC.exec(xml)) !== null) titleNsuidPairs.push([m[1].trim(), m[2]]);
      // Pattern D: any D{nsuid} anywhere (last resort — log count only)
      const allIds = [...new Set((xml.match(/D(700[0-9]\d{10})/g) || []).map(x => x.slice(1)))];
      if (!titleNsuidPairs.length && allIds.length) {
        emit(`JP XML (${url.includes('coming') ? 'coming' : 'onsale'}): 0 title pairs but ${allIds.length} D-prefixed nsuids — XML schema unknown, logging sample: ${xml.slice(0, 300)}`);
      }

      for (const [title, nsuid] of titleNsuidPairs) {
        if (/^700[0-9]\d{10}$/.test(nsuid)) map.set(title.toLowerCase(), nsuid);
      }
      fetched += titleNsuidPairs.length;
      const label = url.includes('coming') ? 'coming' : 'onsale';
      emit(`JP XML (${label}): ${titleNsuidPairs.length} title-nsuid pairs, ${allIds.length} D-nsuids in raw XML, size=${xml.length}`);
    } catch (e) {
      emit(`JP XML catalog: ${e.response?.status || e.code || e.message.slice(0, 50)}`);
    }
  }

  if (map.size > 0) {
    jpXmlCache = { map, time: now };
    emit(`JP XML catalog: ${map.size} titles cached`);
  }
  return map;
}

// Find the best-matching JP NSUID from the XML catalog for a given English/Japanese query.
// Uses word-overlap scoring; returns nsuid string or null.
function matchJpXmlTitle(catalogMap, query) {
  if (!catalogMap || catalogMap.size === 0) return null;
  const qLower = query.toLowerCase();
  // Exact match first
  if (catalogMap.has(qLower)) return catalogMap.get(qLower);
  // Tokenize query into significant words (length ≥ 2)
  const qWords = qLower.replace(/[™®©:！？。、]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  if (!qWords.length) return null;

  let best = null, bestScore = 0;
  for (const [title, nsuid] of catalogMap) {
    const tWords = title.replace(/[™®©:！？。、]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    // Count matching words in both directions (title contains query words AND query contains title words)
    const fwd = qWords.filter(w => title.includes(w)).length / qWords.length;
    const rev = tWords.filter(w => qLower.includes(w)).length / Math.max(tWords.length, 1);
    const score = (fwd + rev) / 2;
    if (score > bestScore && score >= 0.5) { bestScore = score; best = nsuid; }
  }
  return best;
}

// ─── Nsuid fetch helpers ──────────────────────────────────────────────────────

async function fetchNsuidsFrom(url, label, emit) {
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json' } });
    const found = [...new Set((String(res.data).match(/700[0-9]\d{10}/g) || []))];
    if (found.length) emit(`${label}: ${found.length} nsuid(s)`);
    return found;
  } catch (e) { emit(`${label}: ${e.message.slice(0, 60)}`); return []; }
}

// Use Playwright to load eshop-prices.com and capture nsuids from all network responses
// and the rendered page state. eshop-prices uses its own backend, so we scan everything.
async function fetchNsuidsFromEshopPricesBrowser(gameUrl, emit) {
  if (!gameUrl.includes('eshop-prices.com')) return [];
  emit('Browser: loading eshop-prices.com...');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-default-apps', '--no-first-run', '--no-zygote'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    const found = new Set();
    page.on('response', async resp => {
      try { (await resp.text()).match(/700[0-9]\d{10}/g)?.forEach(id => found.add(id)); } catch {}
    });
    page.on('request', req => { req.url().match(/700[0-9]\d{10}/g)?.forEach(id => found.add(id)); });
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const t = await page.title();
    if (t.includes('Just a moment') || t.includes('Attention Required')) {
      emit('Browser: Cloudflare — waiting...');
      await page.waitForFunction(() => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'), { timeout: 25000 }).catch(() => {});
    }
    await page.waitForTimeout(8000);
    const html = await page.content();
    html.match(/700[0-9]\d{10}/g)?.forEach(id => found.add(id));
    const state = await page.evaluate(() => { try { return JSON.stringify(window.__NUXT__ || window.__NEXT_DATA__ || {}); } catch { return ''; } }).catch(() => '');
    state.match(/700[0-9]\d{10}/g)?.forEach(id => found.add(id));
    emit(`Browser: ${found.size} nsuid(s) captured from eshop-prices.com`);
    return [...found];
  } catch (e) { emit(`Browser: ${e.message.slice(0, 70)}`); return []; }
  finally { if (browser) await browser.close().catch(() => {}); }
}

// Scrape a DekuDeals item page for ec.nintendo.com regional links.
// DekuDeals embeds href="https://ec.nintendo.com/{CC}/{lang}/titles/{nsuid}" for every region,
// giving us all regional nsuids in one page load.
// Returns { regionMap: {CC: nsuid}, title: string }
// DekuDeals slugs often differ from Nintendo titles (e.g. "phantom-liberty-bundle" vs "Ultimate Edition"),
// so we scrape the page itself for both the title and all regional ec.nintendo.com links.
async function fetchNsuidsFromDekuDealsBrowser(gameUrl, emit) {
  if (!gameUrl.includes('dekudeals.com')) return { regionMap: {}, title: '' };
  if (browserBusy) { emit('DekuDeals browser: skipped (another browser already running)'); return { regionMap: {}, title: '' }; }
  browserBusy = true;
  emit('DekuDeals browser: loading page...');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-default-apps', '--no-first-run', '--no-zygote'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const t = await page.title();
    if (t.includes('Just a moment') || t.includes('Attention Required')) {
      emit('DekuDeals browser: Cloudflare — waiting...');
      await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 25000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);
    const html = await page.content();
    // Extract game title from page: DekuDeals title format is "Game Name | Deku Deals"
    const pageTitle = await page.title();
    const title = pageTitle.replace(/\s*\|\s*Deku Deals.*$/i, '').trim();
    // Extract ec.nintendo.com/{CC}/{lang}/titles/{nsuid} links
    const regionMap = {};
    const matches = html.matchAll(/ec\.nintendo\.com\/([A-Z]{2})\/[a-z_]+\/titles\/(\d+)/g);
    for (const [, cc, nsuid] of matches) {
      if (/^700[0-9]\d{10}$/.test(nsuid)) regionMap[cc] = nsuid;
    }
    const regions = Object.keys(regionMap);
    emit(`DekuDeals browser: title="${title}", found ${regions.length} regional nsuids [${regions.map(c => `${c}:${regionMap[c]}`).join(', ')}]`);
    return { regionMap, title };
  } catch (e) { emit(`DekuDeals browser: ${e.message.slice(0, 70)}`); return { regionMap: {}, title: '' }; }
  finally { if (browser) await browser.close().catch(() => {}); browserBusy = false; }
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

const SUPPORTED_URL = /eshop-prices\.com\/games\/|dekudeals\.com\/items\/|(?:www\.)?nintendo\.com\/[a-z]{2}\/store\/products\/|store-jp\.nintendo\.com\/item\/software\/D\d+|ec\.nintendo\.com\/[A-Z]{2}\/[a-z_]+\/titles\/\d+/i;

// Extract a seed NSUID directly from URLs that embed it, e.g.:
//   store-jp.nintendo.com/item/software/D70010000095201  → 70010000095201
//   ec.nintendo.com/JP/ja/titles/70010000095201          → 70010000095201
function extractNsuidFromUrl(gameUrl) {
  const jpStore = gameUrl.match(/store-jp\.nintendo\.com\/item\/software\/D(\d+)/i);
  if (jpStore) return jpStore[1];
  const ecNintendo = gameUrl.match(/ec\.nintendo\.com\/[A-Z]{2}\/[a-z_]+\/titles\/(\d+)/i);
  if (ecNintendo) return ecNintendo[1];
  return null;
}

function extractSlugFromUrl(gameUrl) {
  // nintendo.com/us/store/products/{slug}/ → strip trailing -switch/-nintendo-switch
  const nintendoMatch = gameUrl.match(/nintendo\.com\/[a-z]{2}\/store\/products\/([^/?#]+)/i);
  if (nintendoMatch) {
    // Strip platform suffixes: -switch-2, -nintendo-switch-2, -switch, -nintendo-switch
    return nintendoMatch[1]
      .replace(/-(nintendo-)?switch-2$/, '')
      .replace(/-(nintendo-)?switch$/, '');
  }
  // eshop-prices: /games/123-some-slug  → strip numeric prefix
  // dekudeals: /items/some-slug
  return gameUrl.split('/').pop().split('?')[0].replace(/^\d+-/, '');
}

// ─── Phase 1: fast nsuid discovery (EU catalog + Algolia + nintendo.com page) ─

async function findNsuidsPhase1(gameUrl, emit) {
  const rawSlug = extractSlugFromUrl(gameUrl);
  const slug = rawSlug.replace(/-/g, ' ');
  const gameId = gameUrl.match(/\/games\/(\d+)/)?.[1];
  const q = encodeURIComponent(slug);
  const words = slug.toLowerCase().split(' ').filter(w => w.length > 2);

  const seen = new Set();
  const nsuids = [];
  const euNsuids = [];
  const jpNsuids = [];
  const hkNsuids = [];
  let usNsuid = null;
  let gameName = '';
  let hkLocalTitle = '';  // Chinese title from zh_HK catalog
  let jpLocalTitle = '';  // Japanese title from JP catalog

  const add = (id) => { const s = String(id || ''); if (/^700[0-9]\d{10}$/.test(s) && !seen.has(s)) { seen.add(s); nsuids.push(s); } };
  const addMany = (ids) => { for (const id of (ids || [])) add(id); };

  // If the URL itself contains the NSUID (store-jp or ec.nintendo.com), seed it immediately
  const seedNsuid = extractNsuidFromUrl(gameUrl);
  if (seedNsuid) {
    add(seedNsuid);
    // Determine which region bucket it belongs to by querying JP price API
    const isJp = gameUrl.includes('store-jp') || /ec\.nintendo\.com\/JP\//i.test(gameUrl);
    if (isJp) jpNsuids.push(seedNsuid);
    emit(`Seed NSUID from URL: ${seedNsuid}${isJp ? ' (JP)' : ''}`);
  }

  emit(`Searching for "${slug}"...`);

  // EU catalog + Algolia key in parallel
  const [, algoliaKey] = await Promise.all([
    (async () => {
      try {
        const res = await axios.get(`https://searching.nintendo-europe.com/en/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`, { timeout: 12000 });
        const docs = res.data?.response?.docs || [];
        // Require all distinctive keywords (length ≥5) to match — prevents "Resident Evil"
        // matching a search for "Resident Evil Requiem" and anchoring probes to the wrong game.
        const distinctWords = words.filter(w => w.length >= 5);
        const scored = docs
          .filter(d => distinctWords.every(w => (d.title || '').toLowerCase().includes(w)))
          .map(d => ({ d, score: words.filter(w => (d.title || '').toLowerCase().includes(w)).length }))
          .sort((a, b) => b.score - a.score);
        if (scored[0]?.d.title) gameName = scored[0].d.title;
        const before = nsuids.length;
        const euIds = [];
        for (const { d } of scored.slice(0, 5)) for (const id of (d.nsuid_txt || [])) { add(id); euNsuids.push(id); euIds.push(id); }
        emit(`EU catalog: +${nsuids.length - before} nsuid(s) [${euIds.join(',')}]`);
      } catch (e) { emit(`EU catalog: ${e.message.slice(0, 60)}`); }
    })(),
    // Nintendo Asia catalog (covers HK and SG nsuids)
    (async () => {
      for (const locale of ['en_SG', 'zh_HK']) {
        try {
          const res = await axios.get(`https://searching.nintendo-asia.com/${locale}/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`, { timeout: 10000 });
          const docs = res.data?.response?.docs || [];
          const scored = docs.map(d => ({ d, score: words.filter(w => (d.title || '').toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score);
          const before = nsuids.length;
          const ids = [];
          for (const { d } of scored.slice(0, 5)) {
            for (const id of (d.nsuid_txt || [])) { add(id); ids.push(id); if (locale === 'zh_HK') hkNsuids.push(id); }
            if (locale === 'zh_HK' && d.title && !hkLocalTitle) hkLocalTitle = d.title;
          }
          emit(`Asia catalog (${locale}): +${nsuids.length - before} nsuid(s)${hkLocalTitle && locale === 'zh_HK' ? ` title="${hkLocalTitle}"` : ''} [${ids.join(',')}]`);
        } catch (e) { emit(`Asia catalog (${locale}): ${e.message.slice(0, 50)}`); }
      }
    })(),
    // Nintendo Japan catalog — JP nsuids are far from US/EU, can't be found by probing US/EU anchors
    (async () => {
      for (const endpoint of [
        `https://searching.nintendo.co.jp/j01/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
        `https://searching.nintendo-asia.com/ja_JP/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
      ]) {
        try {
          const res = await axios.get(endpoint, { timeout: 10000 });
          const docs = res.data?.response?.docs || [];
          if (!docs.length) continue;
          const before = nsuids.length;
          const ids = [];
          for (const d of docs.slice(0, 5)) {
            for (const id of (d.nsuid_txt || [])) { add(id); ids.push(id); jpNsuids.push(id); }
            if (d.title && !jpLocalTitle) jpLocalTitle = d.title;
          }
          emit(`JP catalog: +${nsuids.length - before} nsuid(s)${jpLocalTitle ? ` title="${jpLocalTitle}"` : ''} [${ids.join(',')}]`);
          break;
        } catch (e) { emit(`JP catalog (${endpoint.includes('co.jp') ? 'co.jp' : 'asia'}): ${e.message.slice(0, 50)}`); }
      }
    })(),
    // store-jp.nintendo.com search — NSUIDs appear directly in product URLs as D{nsuid}
    // Most reliable JP source: works even when catalog keyword match fails for non-English titles
    (async () => {
      // Use a shorter query (first 3 words) for better JP store match rate
      const jpQ = encodeURIComponent(words.slice(0, 3).join(' '));
      for (const searchUrl of [
        `https://store-jp.nintendo.com/search/?q=${jpQ}&genre=Game`,
        `https://store-jp.nintendo.com/search/?q=${q}&genre=Game`,
      ]) {
        try {
          const res = await axios.get(searchUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'ja,en;q=0.9' },
          });
          const ids = [...new Set((String(res.data).match(/D(700[0-9]\d{10})/g) || []).map(m => m.slice(1)))];
          if (!ids.length) continue;
          const before = nsuids.length;
          for (const id of ids) { add(id); jpNsuids.push(id); }
          emit(`JP store search: +${nsuids.length - before} nsuid(s) [${ids.join(',')}]`);
          break;
        } catch (e) { emit(`JP store search: ${e.message.slice(0, 60)}`); }
      }
    })(),
    getAlgoliaKey(emit),
    // JP XML catalog — fetch all on-sale JP titles in parallel with other searches
    (async () => {
      try {
        const xmlMap = await getJpXmlCatalog(emit);
        const nsuid = matchJpXmlTitle(xmlMap, slug);
        if (nsuid) { add(nsuid); jpNsuids.push(nsuid); emit(`JP XML match (P1): nsuid=${nsuid}`); }
        else emit(`JP XML match (P1): no match for "${slug.slice(0, 30)}" — will retry in Phase 2`);
      } catch (e) { emit(`JP XML: ${e.message.slice(0, 50)}`); }
    })(),
  ]);

  const nameSlug = toNintendoSlug(gameName || slug);
  // originalSlug: for nintendo.com inputs, the full slug before stripping (e.g. subnautica-nintendo-switch-2-edition-switch-2)
  const nintendoMatch = gameUrl.match(/nintendo\.com\/[a-z]{2}\/store\/products\/([^/?#]+)/i);
  const originalSlug = nintendoMatch ? nintendoMatch[1] : null;
  const slugVariants = [...new Set([
    nameSlug + '-switch', rawSlug + '-switch', nameSlug, rawSlug,
    ...(originalSlug ? [originalSlug] : []),
  ])];
  const titleWords = (gameName || slug).toLowerCase().split(/\W+/).filter(w => w.length > 2);

  await Promise.allSettled([
    // If input was a nintendo.com URL, fetch it directly first (contains nsuid in HTML)
    originalSlug
      ? fetchNsuidsFrom(gameUrl, 'Nintendo.com (direct)', emit).then(addMany)
      : Promise.resolve(),

    // Nintendo.com product pages (no-region and /us/ variants) → US/Americas nsuid
    // Only keep 7001 nsuids from these pages; 7005/7007 are platform catalog IDs not usable in the price API
    ...slugVariants.flatMap(s => [
      fetchNsuidsFrom(`https://www.nintendo.com/store/products/${s}/`, `Nintendo.com (${s})`, emit).then(ids => { const kept = ids.filter(id => id.startsWith('7001')); if (ids.length) emit(`Nintendo.com (${s}): ${ids.length} total, keeping ${kept.length} 7001: [${kept.join(',')}]`); addMany(kept); }),
      fetchNsuidsFrom(`https://www.nintendo.com/us/store/products/${s}/`, `Nintendo.com US (${s})`, emit).then(ids => { const kept = ids.filter(id => id.startsWith('7001')); if (ids.length) emit(`Nintendo.com US (${s}): ${ids.length} total, keeping ${kept.length} 7001: [${kept.join(',')}]`); addMany(kept); }),
    ]),

    // Algolia → verified US nsuid
    algoliaKey ? (async () => {
      for (const indexName of ['store_game_en_us_release_date', 'store_game_en_us', 'noa_aem_game_en_us']) {
        try {
          const res = await axios.post('https://u3b6gr4ua3-dsn.algolia.net/1/indexes/*/queries',
            { requests: [{ indexName, params: `query=${q}&hitsPerPage=5` }] },
            { headers: { 'X-Algolia-Application-Id': ALGOLIA_APP_ID, 'X-Algolia-API-Key': algoliaKey, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
          const hits = res.data?.results?.[0]?.hits || [];
          // Pick usNsuid from the hit whose title best matches gameName (avoid bundles)
          let best = null, bestScore = -1;
          for (const h of hits) {
            if (!h.nsuid || !/^700[0-9]\d{10}$/.test(String(h.nsuid))) continue;
            const score = titleWords.filter(w => (h.title || '').toLowerCase().includes(w)).length;
            if (score > bestScore) { bestScore = score; best = h; }
          }
          if (best && !usNsuid) usNsuid = String(best.nsuid);
          const before = nsuids.length;
          const algIds = [];
          for (const h of hits) { if (h.nsuid) algIds.push(`${h.nsuid}(txt:${(h.nsuid_txt||[]).join('+')})`); add(h.nsuid); addMany(h.nsuid_txt || []); if (!gameName && h.title) gameName = h.title; }
          emit(`Algolia ${indexName}: ${hits.length} hits, +${nsuids.length - before} new, usNsuid=${usNsuid} [${algIds.join(', ')}]`);
          if (nsuids.length > before) break;
        } catch (e) { emit(`Algolia ${indexName}: ${e.message.slice(0, 50)}`); if (e.response?.status === 403) algoliaKeyCache.time = 0; }
      }
    })() : Promise.resolve(),

    // eshop-prices.com JSON API (fast, usually 403 on Render)
    gameId ? axios.get(`https://eshop-prices.com/games/${gameId}.json`, { timeout: 8000 }).then(r => {
      const ids = (JSON.stringify(r.data).match(/700[0-9]\d{10}/g) || []);
      addMany(ids); if (ids.length) emit(`eshop-prices API: +${ids.length} nsuid(s)`);
    }).catch(e => emit(`eshop-prices API: ${e.message.slice(0, 50)}`)) : Promise.resolve(),

    // eshop-prices.com HTML page — Nuxt SSR embeds all regional nsuids (incl. SG/HK) before JS
    gameId ? axios.get(`https://eshop-prices.com/games/${gameId}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' },
    }).then(r => {
      const ids = [...new Set((String(r.data).match(/700[0-9]\d{10}/g) || []))];
      const before = nsuids.length;
      addMany(ids);
      if (nsuids.length > before) emit(`eshop-prices HTML: +${nsuids.length - before} nsuid(s) [${ids.join(',')}]`);
      else emit(`eshop-prices HTML: fetched but no new nsuids`);
    }).catch(e => emit(`eshop-prices HTML: ${e.message.slice(0, 60)}`)) : Promise.resolve(),
  ]);

  if (!gameName) gameName = slug;

  // Prefer a non-EU 7001 nsuid as usNsuid (Americas eShop, correct anchor for JP probing).
  // Exclude EU catalog nsuids — they are AU/EU region IDs, not US.
  const euNsuidSet = new Set(euNsuids);
  const amer7001 = nsuids.filter(id => id.startsWith('7001') && !euNsuidSet.has(id));
  if (amer7001.length && (!usNsuid || !usNsuid.startsWith('7001'))) {
    usNsuid = amer7001[0];
    emit(`usNsuid: overriding with 7001 nsuid ${usNsuid}`);
  }

  emit(`Phase 1 done: "${gameName}", ${nsuids.length} nsuids found, hkTitle="${hkLocalTitle}" jpTitle="${jpLocalTitle}"`);
  return { nsuids, seen, gameName, euNsuids, jpNsuids, hkNsuids, usNsuid, rawSlug, hkLocalTitle, jpLocalTitle };
}

// ─── Phase 2: catalog search for HK and JP using English + localized titles ────

async function findNsuidsPhase2(gameUrl, { seen, gameName, euNsuids, jpNsuids, hkNsuids, usNsuid, hkLocalTitle, jpLocalTitle }, emit) {
  const newNsuids = [];
  const addNew = (id) => { const s = String(id || ''); if (/^700[0-9]\d{10}$/.test(s) && !seen.has(s)) { seen.add(s); newNsuids.push(s); } };

  // Search a Nintendo catalog endpoint with a query, return { ids, localTitles }
  async function searchCatalog(url, label) {
    try {
      const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja,zh,en' } });
      const docs = res.data?.response?.docs || [];
      const ids = [];
      const localTitles = [];
      for (const d of docs.slice(0, 5)) {
        for (const id of (d.nsuid_txt || [])) ids.push(id);
        if (d.title) localTitles.push(d.title);
      }
      if (ids.length) emit(`${label}: ${ids.length} nsuid(s), titles=[${localTitles.slice(0, 2).map(t => t.slice(0, 20)).join(' / ')}]`);
      else emit(`${label}: no results`);
      return { ids, localTitles };
    } catch (e) { emit(`${label}: ${e.message.slice(0, 50)}`); return { ids: [], localTitles: [] }; }
  }

  // HK: search zh_HK catalog with Chinese title from Phase 1.
  // Falls back to gap probe off EU nsuids when catalog is unreachable (blocked on Render).
  async function findHK() {
    if (hkLocalTitle) {
      const zhQ = encodeURIComponent(hkLocalTitle);
      const { ids } = await searchCatalog(
        `https://searching.nintendo-asia.com/zh_HK/select?q=${zhQ}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
        `HK search (ZH: "${hkLocalTitle.slice(0, 20)}")`
      );
      ids.forEach(addNew);
    } else {
      // Fallback: gap probe off EU nsuids (HK and EU nsuids are typically within ±50)
      const hkBase = hkNsuids.length ? hkNsuids : euPrimary;
      if (!hkBase.length) { emit('HK probe: no base'); return; }
      const HK_GAP = 50n;
      const probeIds = [...new Set(hkBase.flatMap(b => {
        const bn = BigInt(b);
        return Array.from({ length: Number(HK_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
      }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))].slice(0, 50);
      if (!probeIds.length) return;
      try {
        const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=HK&lang=zh&ids=${probeIds.join(',')}`, { timeout: 20000 });
        const found = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
        found.forEach(p => addNew(String(p.title_id)));
        emit(`HK probe (fallback): ${found.length} found`);
      } catch (e) { emit(`HK probe: ${e.message.slice(0, 50)}`); }
    }
  }

  // JP: multiple strategies in parallel — XML catalog, store-jp search, JP Solr catalog
  async function findJP() {
    const queries = jpLocalTitle ? [jpLocalTitle, gameName] : [gameName];

    await Promise.all([
      // Strategy A: JP XML catalog (cached hourly from nintendo.co.jp)
      (async () => {
        try {
          const xmlMap = await getJpXmlCatalog(emit);
          for (const q of queries) {
            const nsuid = matchJpXmlTitle(xmlMap, q);
            if (nsuid) { addNew(nsuid); emit(`JP XML match (P2, query="${q.slice(0, 25)}"): nsuid=${nsuid}`); return; }
          }
          emit(`JP XML match (P2): no match for [${queries.map(q => q.slice(0, 20)).join(' / ')}]`);
        } catch (e) { emit(`JP XML (P2): ${e.message.slice(0, 50)}`); }
      })(),

      // Strategy B: store-jp.nintendo.com HTML search
      (async () => {
        for (const searchQuery of queries) {
          const q = encodeURIComponent(searchQuery);
          const label = searchQuery === jpLocalTitle ? `JA: "${searchQuery.slice(0, 20)}"` : `EN: "${searchQuery.slice(0, 20)}"`;
          try {
            const res = await axios.get(`https://store-jp.nintendo.com/search/?q=${q}&genre=Game`, {
              timeout: 10000,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'ja,en;q=0.9' },
            });
            const ids = [...new Set((String(res.data).match(/D(700[0-9]\d{10})/g) || []).map(m => m.slice(1)))];
            emit(`JP store search (${label}): ${ids.length} nsuid(s)${ids.length ? ` [${ids.join(',')}]` : ''}`);
            if (ids.length) { ids.forEach(addNew); return; }
          } catch (e) { emit(`JP store search (${label}): ${e.message.slice(0, 60)}`); }
        }
      })(),

      // Strategy C: Nintendo JP Solr catalog (may be blocked on Render but worth trying)
      (async () => {
        for (const searchQuery of queries) {
          const q = encodeURIComponent(searchQuery);
          const { ids } = await searchCatalog(
            `https://searching.nintendo.co.jp/j01/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
            `JP catalog ("${searchQuery.slice(0, 20)}")`
          );
          if (ids.length) { ids.forEach(addNew); return; }
        }
      })(),
    ]);
  }

  // SG: gap probe off HK nsuids, chunked to avoid 400 errors
  async function findSG(hkBase) {
    if (!hkBase.length) { emit('SG probe: no base'); return; }
    const SG_GAP = 50n;
    const probeIds = [...new Set(hkBase.flatMap(b => {
      const bn = BigInt(b);
      return Array.from({ length: Number(SG_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
    }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))];
    if (!probeIds.length) return;
    // Chunk into 50 IDs per request to stay within API limits
    const chunks = [];
    for (let i = 0; i < probeIds.length; i += 50) chunks.push(probeIds.slice(i, i + 50));
    let found = 0;
    for (const chunk of chunks) {
      try {
        const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=SG&lang=en&ids=${chunk.join(',')}`, { timeout: 20000 });
        const hits = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
        hits.forEach(p => { addNew(String(p.title_id)); found++; });
      } catch (e) { emit(`SG probe chunk: ${e.message.slice(0, 50)}`); break; }
    }
    emit(`SG probe: ${found} found`);
  }

  // US fallback probe off EU nsuids when Algolia/nintendo.com missed US nsuid
  async function findUS(euPrimary) {
    if (usNsuid || !euPrimary.length) return;
    const US_GAP = 20n;
    const probeIds = [];
    for (const b of euPrimary) {
      const bn = BigInt(b);
      for (let d = 1n; d <= US_GAP; d++)
        for (const p of [String(bn + d), String(bn - d)])
          if (/^700[0-9]\d{10}$/.test(p) && !seen.has(p)) probeIds.push(p);
    }
    if (!probeIds.length) return;
    try {
      const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=US&lang=en&ids=${[...new Set(probeIds)].slice(0, 80).join(',')}`, { timeout: 20000 });
      const found = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
      found.forEach(p => addNew(String(p.title_id)));
      emit(`US probe: ${found.length} found`);
    } catch (e) { emit(`US probe: ${e.message.slice(0, 50)}`); }
  }

  const SAME_RANGE = 10000n;
  const anchorEu = usNsuid && euNsuids.length
    ? euNsuids.reduce((best, id) => { const d = BigInt(usNsuid) > BigInt(id) ? BigInt(usNsuid) - BigInt(id) : BigInt(id) - BigInt(usNsuid); const bd = BigInt(usNsuid) > BigInt(best) ? BigInt(usNsuid) - BigInt(best) : BigInt(best) - BigInt(usNsuid); return d < bd ? id : best; })
    : (euNsuids.length ? euNsuids.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b) : null);
  const euPrimary = anchorEu ? euNsuids.filter(id => { const d = BigInt(id) > BigInt(anchorEu) ? BigInt(id) - BigInt(anchorEu) : BigInt(anchorEu) - BigInt(id); return d <= SAME_RANGE; }) : [];

  // HK and JP run sequentially: JP re-search uses Japanese title found from first pass
  // SG and US probes run in parallel since they don't depend on each other
  const hkBase = hkNsuids.length ? hkNsuids : euPrimary;
  await Promise.all([
    findHK(),
    findJP(),
    findSG(hkBase),
    findUS(euPrimary),
  ]);

  emit(`Phase 2 done: ${newNsuids.length} additional nsuid(s)`);
  return newNsuids;
}

// ─── Nintendo price API ───────────────────────────────────────────────────────

async function getNintendoPrices(nsuids, emit) {
  emit(`Querying Nintendo eShop API (${nsuids.length} nsuids)...`);
  const idsParam = nsuids.join(',');
  const entries = await Promise.all(
    Object.entries(COUNTRY_CODE).map(async ([country, code]) => {
      try {
        const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=${code}&lang=en&ids=${idsParam}`, { timeout: 20000 });
        const prices = res.data?.prices || [];
        const found = prices.filter(p => p.sales_status !== 'not_found' && (p.discount_price || p.regular_price));
        if (country === 'US') emit(`US price API: ${prices.length} total, ${found.length} priced, ${prices.length - found.length} not_found`);
        for (const p of prices) {
          if (p.sales_status === 'not_found') continue;
          const price = p.discount_price || p.regular_price;
          if (!price) continue;
          const amount = parseFloat(price.raw_value ?? price.amount);
          return [country, { amount, currency: price.currency, onSale: !!p.discount_price, nsuid: String(p.title_id) }];
        }
        return [country, null];
      } catch { return [country, null]; }
    })
  );
  return Object.fromEntries(entries);
}

// ─── Build result data ────────────────────────────────────────────────────────

function buildResultData(gameName, prices, rateResult) {
  const { rates: sgdRates, source: rateSource } = rateResult;
  const cnyToSgd = sgdRates['CNY'] ?? null;
  console.log(`[gc] cnyToSgd=${cnyToSgd} gcPrices=${JSON.stringify(gcPrices)}`);

  function formatRaw(amount, currency) {
    const sym = { USD: 'US$', SGD: 'S$', HKD: 'HK$', BRL: 'R$', JPY: '¥', CAD: 'CA$', MXN: 'MX$', AUD: 'A$' };
    const v = currency === 'JPY' ? Math.round(amount).toLocaleString('en') : amount.toFixed(2);
    return `${sym[currency] || currency + ' '}${v}`;
  }

  const results = TARGET_COUNTRIES.map(country => {
    const p = prices[country];
    const currency = COUNTRY_CURRENCY[country];
    const denoms = GIFT_CARD_DENOMS[currency];
    if (!p) return { country, currency, rawPrice: null, effectiveAmount: null, sgdPrice: null, denoms, eshopUrl: null };
    const rawPrice = formatRaw(p.amount, p.currency);
    const effectiveAmount = denoms ? minGiftCardAmount(p.amount, denoms) : p.amount;

    let sgdPrice = null;
    let gcCnyPrice = null; // CNY paid for the gift card used
    if (currency === 'SGD') {
      sgdPrice = effectiveAmount;
    } else if (GC_CURRENCIES.includes(currency) && effectiveAmount != null && cnyToSgd != null) {
      const cny = minGiftCardCNY(effectiveAmount, currency);
      if (cny != null) {
        gcCnyPrice = cny;
        sgdPrice = cny * cnyToSgd;
      } else if (sgdRates[currency] != null) {
        sgdPrice = effectiveAmount * sgdRates[currency];
      }
    } else if (sgdRates[currency] != null && effectiveAmount != null) {
      sgdPrice = effectiveAmount * sgdRates[currency];
    }

    const eshopUrl = ESHOP_URL[country] ? ESHOP_URL[country](p.nsuid) : null;
    return { country, currency, rawPrice, amount: p.amount, effectiveAmount, denoms, sgdPrice, gcCnyPrice, onSale: p.onSale, eshopUrl };
  });

  results.sort((a, b) => {
    if (a.sgdPrice === null && b.sgdPrice === null) return 0;
    if (a.sgdPrice === null) return 1;
    if (b.sgdPrice === null) return -1;
    return a.sgdPrice - b.sgdPrice;
  });

  return { gameName, rateSource, sgdRates, gcPrices: JSON.parse(JSON.stringify(gcPrices)), cnyToSgd, results };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function buildResults(gameUrl, emit, onPartial) {
  // Return cached result immediately
  const cached = cache.get(gameUrl);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    emit('Returning cached result.');
    return cached.data;
  }

  // Run exchange rates in parallel with Phase 1 nsuid discovery
  const [rateResult, phase1] = await Promise.all([
    getExchangeRates(emit),
    findNsuidsPhase1(gameUrl, emit),
  ]);

  // Query prices with Phase 1 nsuids (~5s total so far) and emit partial result
  const p1Prices = await getNintendoPrices(phase1.nsuids, emit);
  const partialData = buildResultData(phase1.gameName, p1Prices, rateResult);
  if (onPartial) onPartial(partialData);

  let finalNsuids, finalName;

  if (gameUrl.includes('dekudeals.com')) {
    // DekuDeals Phase 2: browser scrape the DekuDeals page.
    // DekuDeals slugs often differ from Nintendo titles, so Phase 1 catalog may find nothing.
    // The page contains ec.nintendo.com links for every region → exact nsuids + correct title.
    const { regionMap, title } = await fetchNsuidsFromDekuDealsBrowser(gameUrl, emit);
    const browserIds = Object.values(regionMap).filter(id => !phase1.seen.has(id));
    finalNsuids = [...phase1.nsuids, ...browserIds];
    finalName = title || phase1.gameName;
    emit(`DekuDeals: ${browserIds.length} new nsuid(s) from browser`);
  } else {
    // Phase 2: fast probes (JP/HK) — completes in ~2s
    const probeNsuids = await findNsuidsPhase2(gameUrl, phase1, emit);
    finalNsuids = [...phase1.nsuids, ...probeNsuids];
    finalName = phase1.gameName;
  }

  const p2Prices = await getNintendoPrices(finalNsuids, emit);
  const p2Data = buildResultData(finalName, p2Prices, rateResult);
  cache.set(gameUrl, { data: p2Data, time: Date.now() });
  return p2Data;
}

// ─── Web: SSE endpoint ────────────────────────────────────────────────────────

app.get('/api/giftcard-prices', (req, res) => {
  res.json({ gcPrices, currencies: GC_CURRENCIES });
});

app.get('/api/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url || !SUPPORTED_URL.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid eshop-prices.com, dekudeals.com, or nintendo.com/store URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  const emit = (msg) => send('status', msg);

  try {
    const result = await buildResults(url, emit, (partial) => send('partial', partial));
    send('result', result);
  } catch (err) {
    send('error', err.message);
  } finally {
    res.end();
  }
});

// ─── Telegram bot ─────────────────────────────────────────────────────────────

function formatTelegramMessage(data, label = '') {
  const MEDAL = ['🥇', '🥈', '🥉'];
  const lines = [];
  if (label) lines.push(label);
  lines.push(`🎮 *${escTg(data.gameName)}*\n`);
  let rank = 0;
  for (const r of data.results) {
    const hasPrice = r.sgdPrice !== null;
    if (hasPrice) rank++;
    const medal = hasPrice ? (MEDAL[rank - 1] || `\\#${rank}`) : '➖';
    const flag = COUNTRY_FLAG[r.country] || '';
    const gc = !r.rawPrice ? 'Not Available'
      : r.effectiveAmount === 0 ? 'Free'
      : r.denoms ? `${r.currency} ${r.effectiveAmount.toLocaleString()}`
      : `${r.currency} ${r.effectiveAmount.toFixed(2)}`;
    const sgd = r.sgdPrice === 0 ? 'Free' : r.sgdPrice !== null ? escTg(`S$${r.sgdPrice.toFixed(2)}`) : 'N/A';
    const countryText = r.eshopUrl
      ? `[${escTg(r.country)}](${r.eshopUrl})`
      : `*${escTg(r.country)}*`;
    lines.push(`${medal} ${flag} ${countryText}`);
    if (r.rawPrice) {
      const cnyNote = r.gcCnyPrice != null ? ` \\(¥${escTg(r.gcCnyPrice)} CNY\\)` : '';
      lines.push(`  ${escTg(r.rawPrice)}  →  *${escTg(gc)}*${cnyNote}  →  *${sgd}*`);
    } else lines.push(`  Not Available`);
    lines.push('');
  }
  lines.push(`📊 _Rates: ${escTg(data.rateSource)}_`);
  return lines.join('\n');
}

function escTg(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('  Telegram bot disabled (no TELEGRAM_BOT_TOKEN).'); return; }
  let TelegramBot;
  try { const pkg = require('node-telegram-bot-api'); TelegramBot = pkg.default ?? pkg; }
  catch { console.error('  node-telegram-bot-api not installed.'); return; }

  const bot = new TelegramBot(token, { polling: { interval: 2000, autoStart: true, params: { timeout: 10 } } });
  console.log('  Telegram bot active.');
  const ESHOP_URL_RE = /https?:\/\/(?:eshop-prices\.com\/games\/|(?:www\.)?dekudeals\.com\/items\/|(?:www\.)?nintendo\.com\/[a-z]{2}\/store\/products\/|store-jp\.nintendo\.com\/item\/software\/D\d+|ec\.nintendo\.com\/[A-Z]{2}\/[a-z_]+\/titles\/\d+)[^\s]*/i;

  async function handleUrl(chatId, gameUrl, messageId) {
    const statusMsg = await bot.sendMessage(chatId, '🔍 Searching prices\\.\\.\\. please wait\\.', { parse_mode: 'MarkdownV2', reply_to_message_id: messageId });
    const logs = [];
    const emit = (msg) => { logs.push(msg); console.log('[bot]', msg); };

    try {
      const data = await buildResults(gameUrl, emit);
      const finalText = formatTelegramMessage(data);
      await bot.sendMessage(chatId, finalText, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    } catch (err) {
      const logText = logs.length ? `\n\nDebug:\n${logs.slice(-8).join('\n')}` : '';
      await bot.sendMessage(chatId, `❌ Error: ${err.message}${logText}`);
    }
  }

  function escGc(s) { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

  const GC_FLAG = { USD: '🇺🇸', BRL: '🇧🇷', CAD: '🇨🇦', MXN: '🇲🇽', AUD: '🇦🇺' };

  function formatGcPrices() {
    const lines = ['🎴 *Gift Card Prices* \\(CNY\\)\n'];
    for (const cur of GC_CURRENCIES) {
      lines.push(`${GC_FLAG[cur] || ''} *${cur}*`);
      for (const [denom, cny] of Object.entries(gcPrices[cur])) {
        lines.push(cny != null
          ? `  ${cur} ${denom} → *${escGc(cny)} CNY*`
          : `  ${cur} ${denom} → _not set_`);
      }
    }
    lines.push('\n_Update with_ `/updategiftcard USD 10 60`');
    return lines.join('\n');
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const match = text.match(ESHOP_URL_RE);

    if (match) {
      await handleUrl(chatId, match[0], msg.message_id);

    } else if (/^\/giftcards?\b/.test(text)) {
      await bot.sendMessage(chatId, formatGcPrices(), { parse_mode: 'MarkdownV2' });

    } else if (/^\/updategiftcard\b/.test(text)) {
      // /updategiftcard USD 10 60  — update an existing denomination
      const m = text.match(/^\/updategiftcard\s+([A-Z]{3})\s+([\d.]+)\s+([\d.]+)/i);
      if (!m) {
        await bot.sendMessage(chatId,
          '⚠️ Usage: `/updategiftcard USD 10 60`\n_currency · denomination · CNY price_\nSupported: ' + escGc(GC_CURRENCIES.join(', ')),
          { parse_mode: 'MarkdownV2' });
        return;
      }
      const cur = m[1].toUpperCase();
      const denom = m[2];
      const cny = parseFloat(m[3]);
      if (!(cur in gcPrices) || !(denom in gcPrices[cur]) || isNaN(cny) || cny <= 0) {
        const validDenoms = cur in gcPrices ? Object.keys(gcPrices[cur]).join(', ') : 'n/a';
        await bot.sendMessage(chatId,
          `⚠️ Invalid\\. ${escGc(cur)} denominations: ${escGc(validDenoms)}\nSupported currencies: ${escGc(GC_CURRENCIES.join(', '))}`,
          { parse_mode: 'MarkdownV2' });
        return;
      }
      gcPrices[cur][denom] = cny;
      saveGcPrices();
      cache.clear();
      await bot.sendMessage(chatId,
        `✅ *${cur} ${denom}* gift card updated to *${escGc(cny)} CNY*\\.\nPrice caches cleared\\.`,
        { parse_mode: 'MarkdownV2' });

    } else if (/^\/addgiftcard\b/.test(text)) {
      // /addgiftcard USD 25 150  — add a new denomination
      const m = text.match(/^\/addgiftcard\s+([A-Z]{3})\s+([\d.]+)\s+([\d.]+)/i);
      if (!m) {
        await bot.sendMessage(chatId,
          '⚠️ Usage: `/addgiftcard USD 25 150`\n_currency · denomination · CNY price_\nSupported: ' + escGc(GC_CURRENCIES.join(', ')),
          { parse_mode: 'MarkdownV2' });
        return;
      }
      const cur = m[1].toUpperCase();
      const denom = m[2];
      const cny = parseFloat(m[3]);
      if (!(cur in gcPrices) || isNaN(cny) || cny <= 0) {
        await bot.sendMessage(chatId,
          `⚠️ Unsupported currency\\. Supported: ${escGc(GC_CURRENCIES.join(', '))}`,
          { parse_mode: 'MarkdownV2' });
        return;
      }
      if (denom in gcPrices[cur]) {
        await bot.sendMessage(chatId,
          `⚠️ *${cur} ${denom}* already exists\\. Use \`/updategiftcard ${cur} ${denom} ${cny}\` to change it\\.`,
          { parse_mode: 'MarkdownV2' });
        return;
      }
      gcPrices[cur][denom] = cny;
      saveGcPrices();
      cache.clear();
      await bot.sendMessage(chatId,
        `✅ *${cur} ${denom}* gift card added at *${escGc(cny)} CNY*\\.\nPrice caches cleared\\.`,
        { parse_mode: 'MarkdownV2' });

    } else if (/^\/start|\/help/.test(text)) {
      await bot.sendMessage(chatId,
        '👋 Send me a game link and I\'ll show you the best prices in SGD\\.\n\n' +
        '*Supported URLs:*\n• eshop\\-prices\\.com/games/\\.\\.\\.\n• dekudeals\\.com/items/\\.\\.\\.\n• nintendo\\.com/\\*/store/products/\\.\\.\\.\n\n' +
        '*Gift card commands:*\n• `/giftcards` — view all current CNY prices\n• `/updategiftcard USD 10 60` — update an existing denomination\n• `/addgiftcard USD 25 150` — add a new denomination\n\n' +
        '*Example:*\n`https://eshop\\-prices\\.com/games/17496\\-cyberpunk\\-2077\\-ultimate\\-edition`',
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
}

// ─── Start ────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (err) => console.error('Unhandled:', err?.message || err));
process.on('uncaughtException',  (err) => console.error('Uncaught:',  err?.message || err));

app.listen(PORT, () => {
  console.log(`\n  eShop Price Fetcher`);
  console.log(`  Web → http://localhost:${PORT}`);
  startTelegramBot();
  console.log();
});
