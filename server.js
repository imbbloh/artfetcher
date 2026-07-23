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
  'Singapore':     (id) => `https://www.nintendo.com/sg/games/detail.html?id=${id}`,
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

// /solver command — pulls pre-scraped game data from the eshop-price-solver
// site's own daily-refreshed dataset rather than re-scraping here.
const SOLVER_DATA_BASE = 'https://imbbloh.github.io/eshop-price-solver/data';
const SOLVER_REGIONS = {
  USD: { region: 'us', currency: 'US$ ' },
  CAD: { region: 'ca', currency: 'CA$ ' },
  MXN: { region: 'mx', currency: 'MX$ ' },
  BRL: { region: 'br', currency: 'R$ ' },
};
const solverDataCache = new Map(); // region -> { games, fetchedAt }
const SOLVER_CACHE_TTL = 4 * 60 * 60 * 1000;

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

// Returns { cny, breakdown: [{count, denom}] } for the cheapest combination of gift cards
// that covers `amount` exactly, using DP with choice reconstruction.
function minGiftCardCNY(amount, currency) {
  const denomPriceMap = gcPrices[currency];
  if (!denomPriceMap) return null;
  const denoms = Object.entries(denomPriceMap)
    .map(([d, cny]) => ({ denom: Number(d), cny }))
    .filter(d => d.cny != null && d.denom > 0);
  if (!denoms.length) return null;

  const target = Math.round(amount);
  const dp = new Array(target + 1).fill(Infinity);
  const choice = new Array(target + 1).fill(-1);
  dp[0] = 0;
  for (let i = 1; i <= target; i++)
    for (const { denom, cny } of denoms)
      if (denom <= i && dp[i - denom] + cny < dp[i]) {
        dp[i] = dp[i - denom] + cny;
        choice[i] = denom;
      }

  if (dp[target] === Infinity) return null;

  // Reconstruct which denominations were used
  const counts = {};
  let rem = target;
  while (rem > 0) { const d = choice[rem]; counts[d] = (counts[d] || 0) + 1; rem -= d; }
  const breakdown = Object.entries(counts)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([d, count]) => ({ count, denom: Number(d) }));

  return { cny: Math.round(dp[target] * 100) / 100, breakdown };
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

// Strip diacritics: é→e, ō→o, etc. Decomposes to NFD then drops combining accent marks.
function normStr(s) {
  return String(s || '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
}

function toNintendoSlug(name) {
  return normStr(name).replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Normalize game title to consistent title case.
// Keeps short connector words lowercase unless they start the title.
const LC_WORDS = new Set(['a','an','the','and','but','or','nor','for','so','yet','at','by','in','of','on','to','up','as','if','vs','via']);
function toTitleCase(name) {
  if (!name) return name;
  return name
    .replace(/[™®©]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && LC_WORDS.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
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

// ─── Price solver ──────────────────────────────────────────────────────────────

async function fetchSolverGames(region) {
  const cached = solverDataCache.get(region);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < SOLVER_CACHE_TTL) return cached.games;
  const res = await axios.get(`${SOLVER_DATA_BASE}/${region}.json`, { timeout: 10000 });
  const games = (res.data.games || []).map(g => ({ title: g.title, price: Math.round(g.price * 100), url: g.url }));
  solverDataCache.set(region, { games, fetchedAt: now });
  return games;
}

// Exact subset-sum search (iterative deepening, prefix-sum pruning) — same
// algorithm as the web solver at imbbloh.github.io/eshop-price-solver.
function solveCombos(games, targetCents, want) {
  const pool = games.filter(g => g.price > 0 && g.price <= targetCents).sort((a, b) => a.price - b.price);
  const pre = [0];
  for (let i = 0; i < pool.length; i++) pre.push(pre[i] + pool[i].price);
  const results = [];
  let nodes = 0;
  const BUDGET = 30_000_000;
  const MAX_LEN = 15;

  function searchLen(L) {
    const path = [];
    (function dfs(i, sum, r) {
      if (results.length >= want || nodes > BUDGET) return;
      if (r === 0) { if (sum === targetCents) results.push(path.slice()); return; }
      for (let k = i; k + r <= pool.length; k++) {
        nodes++;
        const minSum = sum + (pre[k + r] - pre[k]);
        if (minSum > targetCents) break;
        path.push(pool[k]); dfs(k + 1, sum + pool[k].price, r - 1); path.pop();
        if (results.length >= want) return;
      }
    })(0, 0, L);
  }

  for (let L = 1; L <= MAX_LEN && results.length < want && nodes <= BUDGET; L++) searchLen(L);
  return results;
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
  // Strip leading numeric ID from eshop-prices slugs (e.g. "5425 monster hunter rise" → "monster hunter rise")
  const searchSlug = slug.replace(/^\d+ /, '');
  const q = encodeURIComponent(searchSlug);
  const words = normStr(searchSlug).split(' ').filter(w => w.length > 2);

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
  const [,,, algoliaKey] = await Promise.all([
    (async () => {
      try {
        const res = await axios.get(`https://searching.nintendo-europe.com/en/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`, { timeout: 12000 });
        const docs = res.data?.response?.docs || [];
        // Require all distinctive keywords (length ≥5) to match — prevents "Resident Evil"
        // matching a search for "Resident Evil Requiem" and anchoring probes to the wrong game.
        const distinctWords = words.filter(w => w.length >= 5);
        const scored = docs
          .filter(d => distinctWords.every(w => normStr(d.title).includes(w)))
          .map(d => ({ d, score: words.filter(w => normStr(d.title).includes(w)).length }))
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
  ]);

  const nameSlug = toNintendoSlug(gameName || searchSlug);
  // originalSlug: for nintendo.com inputs, the full slug before stripping (e.g. subnautica-nintendo-switch-2-edition-switch-2)
  const nintendoMatch = gameUrl.match(/nintendo\.com\/[a-z]{2}\/store\/products\/([^/?#]+)/i);
  const originalSlug = nintendoMatch ? nintendoMatch[1] : null;
  const searchSlugHyphen = toNintendoSlug(searchSlug);
  const slugVariants = [...new Set([
    nameSlug + '-switch', searchSlugHyphen + '-switch', nameSlug, searchSlugHyphen,
    ...(originalSlug ? [originalSlug] : []),
  ])];
  const titleWords = normStr(gameName || searchSlug).split(/\W+/).filter(w => w.length > 2);

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
            const score = titleWords.filter(w => normStr(h.title).includes(w)).length;
            if (score > bestScore) { bestScore = score; best = h; }
          }
          if (best && !usNsuid) usNsuid = String(best.nsuid);
          const before = nsuids.length;
          const algIds = [];
          for (const h of hits) { if (h.nsuid) algIds.push(`${h.nsuid}(txt:${(h.nsuid_txt||[]).join('+')})`); add(h.nsuid); addMany(h.nsuid_txt || []); if (!gameName && h.title) gameName = h.title; }
          if (hits[0]) emit(`Algolia objectID=${hits[0].objectID} titleId=${JSON.stringify(hits[0]).match(/0100[0-9a-f]{12}/i)?.[0]}`);
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
      const html = String(r.data);
      const ids = [...new Set((html.match(/700[0-9]\d{10}/g) || []))];
      const before = nsuids.length;
      addMany(ids);
      // Parse ec.nintendo.com region links to tag NSUIDs by region directly in Phase 1
      const regionLinkRe = /ec\.nintendo\.com\/([A-Z]{2})\/[^/]+\/titles\/(\d{14})/g;
      let m;
      while ((m = regionLinkRe.exec(html)) !== null) {
        const [, cc, nsuid] = m;
        if (cc === 'JP' && !jpNsuids.includes(nsuid)) { jpNsuids.push(nsuid); add(nsuid); }
        else if (cc === 'HK' && !hkNsuids.includes(nsuid)) { hkNsuids.push(nsuid); add(nsuid); }
      }
      if (nsuids.length > before) emit(`eshop-prices HTML: +${nsuids.length - before} nsuid(s) jp=${jpNsuids.length} hk=${hkNsuids.length}`);
      else emit(`eshop-prices HTML: fetched but no new nsuids`);
    }).catch(e => emit(`eshop-prices HTML: ${e.message.slice(0, 60)}`)) : Promise.resolve(),
  ]);

  if (!gameName) gameName = searchSlug;
  gameName = toTitleCase(gameName);

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

// ─── titledb fallback: static community-maintained NSUID database ─────────────
// Live catalog search (searching.nintendo.co.jp, store-jp search, etc.) sometimes
// comes up empty — e.g. Render's IP getting rate-limited, or a title that doesn't
// match well in Nintendo's own search. blawar/titledb (used by the Switch
// homebrew community for game installation, so it's kept genuinely current — not
// a stale/abandoned mirror) publishes one JSON file per region keyed by nsuId.
// The raw files are large (JP ~83MB, HK ~48MB), so scripts/update-titledb.mjs
// pre-processes them down to just {nsuid, name} pairs (~1-2MB each) and commits
// the result to data/titledb-<region>.json via a daily GitHub Actions workflow
// (see .github/workflows/update-titledb.yml) — the exact pattern eshop-price-solver
// uses for its own scraped datasets. The bot only ever reads the small committed
// file from local disk: no network fetch, no multi-second latency, and no risk
// of holding an 80MB+ parsed object in memory during a live Telegram request.
const TITLEDB_REGIONS = {
  US: 'titledb-us.json', JP: 'titledb-jp.json', HK: 'titledb-hk.json',
  AU: 'titledb-au.json', CA: 'titledb-ca.json', BR: 'titledb-br.json', MX: 'titledb-mx.json',
  SG: 'sg-catalog.json', // scraped from nintendo.com/sg — no blawar/titledb file exists for SG
};
const titledbCache = new Map(); // region -> [{nsuid, name, nameEn?}]
let titledbXref = null;       // titleId -> { jp?, hk?, us? }
// usNsuid -> titleId reverse map, built lazily from xref
let usNsuidToTitleId = null;

function loadTitledb(region, emit) {
  const cached = titledbCache.get(region);
  if (cached) return cached;
  const file = TITLEDB_REGIONS[region];
  if (!file) return [];
  try {
    const fs = require('fs');
    const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
    titledbCache.set(region, entries);
    emit(`titledb (${region}): ${entries.length} titles loaded`);
    return entries;
  } catch (e) {
    emit(`titledb (${region}): ${e.message.slice(0, 60)}`);
    return [];
  }
}

function loadXref(emit) {
  if (titledbXref) return titledbXref;
  try {
    const fs = require('fs');
    titledbXref = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'titledb-xref.json'), 'utf8'));
    // Build reverse map: US nsuid -> titleId
    usNsuidToTitleId = {};
    for (const [titleId, v] of Object.entries(titledbXref))
      if (v.us) usNsuidToTitleId[v.us] = titleId;
    emit(`titledb xref: ${Object.keys(titledbXref).length} title IDs loaded`);
  } catch (e) {
    titledbXref = {};
    usNsuidToTitleId = {};
    emit(`titledb xref: ${e.message.slice(0, 60)}`);
  }
  return titledbXref;
}

// Given a known US NSUID, look up the JP or HK NSUID via shared title ID.
function findNsuidViaXref(usNsuid, region, emit) {
  if (!usNsuid) return null;
  loadXref(emit);
  const titleId = usNsuidToTitleId[usNsuid];
  if (!titleId) { emit(`xref: US nsuid ${usNsuid} not in xref`); return null; }
  const entry = titledbXref[titleId];
  const key = region.toLowerCase();
  const nsuid = entry?.[key];
  if (nsuid) emit(`xref: ${region} nsuid ${nsuid} (titleId ${titleId})`);
  else emit(`xref: no ${region} entry for titleId ${titleId}`);
  return nsuid || null;
}

// Best-effort match: works well for Western titles kept untranslated in JP/HK
// listings (e.g. "EA SPORTS FC™ 26"), weak for fully localized titles — that's
// fine since this only runs when the live catalog search already found nothing.
// Filters stopwords (not just short words — "26", "fc" etc. are exactly the
// short tokens that distinguish annualized titles and must be kept). Returns
// only the single best (shortest-name) match: a title's DLC/edition/commentary
// variants all match the same words too, but the base game consistently has
// the shortest name, and returning every variant risks getNintendoPrices()
// picking a non-base SKU's price instead of the base game's.
function findNsuidsViaTitledb(region, searchName, emit) {
  const entries = loadTitledb(region, emit);
  if (!entries.length || !searchName) return [];
  const words = normStr(searchName).split(/\W+/).filter(w => w && !LC_WORDS.has(w));
  if (!words.length) return [];
  const candidates = entries.filter(e => {
    // Match against localized name OR English name (cross-referenced from US catalog)
    const n = normStr(e.name);
    const nEn = e.nameEn ? normStr(e.nameEn) : null;
    return words.every(w => n.includes(w) || (nEn && nEn.includes(w)));
  });
  if (!candidates.length) { emit(`titledb (${region}): no match for "${searchName}"`); return []; }
  // Prefer entries where English name matches (more precise), then shortest name
  candidates.sort((a, b) => {
    const aEnMatch = a.nameEn ? words.every(w => normStr(a.nameEn).includes(w)) : false;
    const bEnMatch = b.nameEn ? words.every(w => normStr(b.nameEn).includes(w)) : false;
    if (aEnMatch !== bEnMatch) return aEnMatch ? -1 : 1;
    return (a.nameEn || a.name).length - (b.nameEn || b.name).length;
  });
  const best = candidates[0];
  const matchedName = best.nameEn || best.name;
  emit(`titledb (${region}): matched "${matchedName}" → ${best.nsuid} (${candidates.length} candidate(s))`);
  return [best.nsuid];
}

// ─── Phase 2: catalog search for HK and JP using English + localized titles ────

async function findNsuidsPhase2(gameUrl, { seen, gameName, euNsuids, jpNsuids, hkNsuids, usNsuid, hkLocalTitle, jpLocalTitle }, emit) {
  const newNsuids = [];
  let jpFoundCount = 0;
  let hkFoundInP2 = [];
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

  async function findHK() {
    const beforeCount = newNsuids.length;

    // 0. eshop-prices HTML already tagged HK nsuid(s) in Phase 1 — most reliable
    if (hkNsuids.length) {
      emit(`HK: using ${hkNsuids.length} nsuid(s) from eshop-prices HTML [${hkNsuids.join(',')}]`);
      hkNsuids.forEach(addNew);
      hkFoundInP2.push(...hkNsuids);
      return;
    }

    // 1. xref: US NSUID -> title ID -> HK NSUID (most reliable)
    const xrefId = findNsuidViaXref(usNsuid, 'HK', emit);
    if (xrefId) { addNew(xrefId); }

    // 2. titledb word match
    if (newNsuids.length === beforeCount) {
      const tdIds = findNsuidsViaTitledb('HK', hkLocalTitle || gameName, emit);
      tdIds.forEach(addNew);
    }

    // 3. Live catalog search or gap probe off EU/US anchor
    if (newNsuids.length === beforeCount) {
      if (hkLocalTitle) {
        const zhQ = encodeURIComponent(hkLocalTitle);
        const { ids } = await searchCatalog(
          `https://searching.nintendo-asia.com/zh_HK/select?q=${zhQ}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
          `HK search (ZH: "${hkLocalTitle.slice(0, 20)}")`
        );
        ids.forEach(addNew);
      } else {
        const hkBase = hkNsuids.length ? hkNsuids : euOrUs;
        if (hkBase.length) {
          const HK_GAP = 50n;
          const probeIds = [...new Set(hkBase.flatMap(b => {
            const bn = BigInt(b);
            return Array.from({ length: Number(HK_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
          }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))].slice(0, 50);
          if (probeIds.length) {
            try {
              const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=HK&lang=zh&ids=${probeIds.join(',')}`, { timeout: 20000 });
              const hits = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
              hits.forEach(p => addNew(String(p.title_id)));
              emit(`HK probe: ${hits.length} found`);
            } catch (e) { emit(`HK probe: ${e.message.slice(0, 50)}`); }
          } else emit('HK probe: no base');
        } else emit('HK probe: no base');
      }
    }

    // Track what HK found for JP post-pass
    hkFoundInP2 = newNsuids.slice(beforeCount);
  }

  async function findJP(hkBase = []) {
    const beforeCount = newNsuids.length;
    const searchQuery = jpLocalTitle || gameName;
    const label = jpLocalTitle ? `JA: "${jpLocalTitle.slice(0, 20)}"` : `EN: "${gameName.slice(0, 20)}"`;
    const q = encodeURIComponent(searchQuery);

    // 0. eshop-prices HTML already tagged JP nsuid(s) in Phase 1 — most reliable
    if (jpNsuids.length) {
      emit(`JP: using ${jpNsuids.length} nsuid(s) from eshop-prices HTML [${jpNsuids.join(',')}]`);
      jpNsuids.forEach(addNew);
      return;
    }

    // 1. xref: US NSUID -> title ID -> JP NSUID (most reliable)
    const xrefId = findNsuidViaXref(usNsuid, 'JP', emit);
    if (xrefId) { addNew(xrefId); return; }

    // 2. titledb word match (works for games in titledb but not in US catalog)
    const tdIds = findNsuidsViaTitledb('JP', searchQuery, emit);
    tdIds.forEach(addNew);
    if (tdIds.length) return;

    // 3. store-jp search (accessible from Render)
    try {
      const res = await axios.get(`https://store-jp.nintendo.com/search/?q=${q}&genre=Game`, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'ja,en;q=0.9' },
      });
      const ids = [...new Set((String(res.data).match(/D(700[0-9]\d{10})/g) || []).map(m => m.slice(1)))];
      emit(`JP store search (${label}): ${ids.length} nsuid(s)${ids.length ? ` [${ids.join(',')}]` : ''}`);
      ids.forEach(addNew);
      if (ids.length) return;
    } catch (e) { emit(`JP store search: ${e.message.slice(0, 60)}`); }

    // 4. JP catalog (may be blocked on Render)
    if (jpLocalTitle) {
      const { ids } = await searchCatalog(
        `https://searching.nintendo.co.jp/j01/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
        `JP catalog (${label})`
      );
      ids.forEach(addNew);
      if (ids.length) return;
    }

    // 5. Gap probe off US NSUID (catches new titles not yet in titledb)
    if (usNsuid) {
      const JP_GAP = 50n;
      const bn = BigInt(usNsuid);
      const probeIds = [...new Set(
        Array.from({ length: Number(JP_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat()
          .filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p))
      )];
      if (probeIds.length) {
        try {
          const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=JP&lang=ja&ids=${probeIds.join(',')}`, { timeout: 20000 });
          const hits = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
          hits.forEach(p => addNew(String(p.title_id)));
          emit(`JP probe (off US nsuid): ${hits.length} found`);
          if (hits.length) return;
        } catch (e) { emit(`JP probe (US): ${e.message.slice(0, 50)}`); }
      }
    }

    // 6. Gap probe off HK NSUIDs — JP and HK NSUIDs are often 1-2 apart
    if (hkBase.length) {
      const JP_GAP = 10n;
      const probeIds = [...new Set(hkBase.flatMap(b => {
        const bn = BigInt(b);
        return Array.from({ length: Number(JP_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
      }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))].slice(0, 50);
      if (probeIds.length) {
        try {
          const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=JP&lang=ja&ids=${probeIds.join(',')}`, { timeout: 20000 });
          const hits = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
          hits.forEach(p => addNew(String(p.title_id)));
          emit(`JP probe (off HK nsuid): ${hits.length} found`);
        } catch (e) { emit(`JP probe (HK): ${e.message.slice(0, 50)}`); }
      } else emit('JP probe (HK): no base');
    }
    jpFoundCount = newNsuids.length - beforeCount;
  }

  // AU: xref → word-match → gap probe off EU nsuids
  async function findAU() {
    // 1. xref: US NSUID -> title ID -> AU NSUID
    const xrefId = findNsuidViaXref(usNsuid, 'AU', emit);
    if (xrefId) { addNew(xrefId); return; }

    // 2. titledb word match
    const tdIds = findNsuidsViaTitledb('AU', gameName, emit);
    if (tdIds.length) { tdIds.forEach(addNew); return; }

    // 3. Gap probe off EU nsuids (AU is PAL region, NSUIDs are typically close)
    if (!euOrUs.length) { emit('AU probe: no base'); return; }
    const AU_GAP = 20n;
    const probeIds = [...new Set(euOrUs.flatMap(b => {
      const bn = BigInt(b);
      return Array.from({ length: Number(AU_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
    }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))].slice(0, 50);
    if (!probeIds.length) { emit('AU probe: no candidates'); return; }
    try {
      const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=AU&lang=en&ids=${probeIds.join(',')}`, { timeout: 20000 });
      const hits = (res.data?.prices || []).filter(p => p.sales_status !== 'not_found' && (p.regular_price || p.discount_price));
      hits.forEach(p => addNew(String(p.title_id)));
      emit(`AU probe: ${hits.length} found`);
    } catch (e) { emit(`AU probe: ${e.message.slice(0, 50)}`); }
  }

  // SG: gap probe off HK nsuids (blawar/titledb has no SG region file)
  async function findSG(hkBase) {
    // 1. sg-catalog word match (scraped daily from nintendo.com/sg)
    const tdIds = findNsuidsViaTitledb('SG', gameName, emit);
    if (tdIds.length) { tdIds.forEach(addNew); return; }

    // 2. Gap probe off HK nsuids
    if (!hkBase.length) { emit('SG probe: no base'); return; }
    const SG_GAP = 50n;
    const probeIds = [...new Set(hkBase.flatMap(b => {
      const bn = BigInt(b);
      return Array.from({ length: Number(SG_GAP) }, (_, i) => [String(bn + BigInt(i + 1)), String(bn - BigInt(i + 1))]).flat();
    }).filter(p => /^700[0-9]\d{10}$/.test(p) && !seen.has(p)))];
    if (!probeIds.length) { emit('SG probe: no candidates'); return; }
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

  // US/Americas fallback when Algolia/nintendo.com missed the US nsuid
  async function findUS(euPrimary) {
    if (usNsuid) return;

    // 1. titledb word match (US, CA, BR, MX share the same Americas NSUIDs)
    for (const region of ['US', 'CA', 'BR', 'MX']) {
      const tdIds = findNsuidsViaTitledb(region, gameName, emit);
      if (tdIds.length) { tdIds.forEach(addNew); return; }
    }

    // 2. Gap probe off EU nsuids
    if (!euPrimary.length) return;
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

  // Fall back to usNsuid as probe anchor when EU catalog found nothing
  const usAnchor = usNsuid ? [usNsuid] : [];
  const euOrUs = euPrimary.length ? euPrimary : usAnchor;

  const hkBase = hkNsuids.length ? hkNsuids : euOrUs;
  await Promise.all([
    findHK(),
    findJP(hkNsuids),
    findAU(),
    findSG(hkBase),
    findUS(euPrimary),
  ]);

  // Post-pass: if JP not found but HK was found in Phase 2, probe JP off those HK NSUIDs
  if (jpFoundCount === 0 && hkFoundInP2.length) {
    emit(`JP post-pass: probing ±10 off ${hkFoundInP2.length} HK nsuid(s) found in Phase 2`);
    await findJP(hkFoundInP2);
  }

  emit(`Phase 2 done: ${newNsuids.length} additional nsuid(s)`);
  return newNsuids;
}

// ─── Nintendo price API ───────────────────────────────────────────────────────

async function getNintendoPrices(nsuids, emit) {
  if (!nsuids.length) return Object.fromEntries(Object.keys(COUNTRY_CODE).map(c => [c, null]));
  // Nintendo price API max 50 IDs per request — chunk if needed
  const CHUNK = 50;
  const chunks = [];
  for (let i = 0; i < nsuids.length; i += CHUNK) chunks.push(nsuids.slice(i, i + CHUNK));
  emit(`Querying Nintendo eShop API (${nsuids.length} nsuids, ${chunks.length} chunk(s))...`);

  const entries = await Promise.all(
    Object.entries(COUNTRY_CODE).map(async ([country, code]) => {
      for (const chunk of chunks) {
        try {
          const res = await axios.get(`https://api.ec.nintendo.com/v1/price?country=${code}&lang=en&ids=${chunk.join(',')}`, { timeout: 20000 });
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
        } catch { /* try next chunk */ }
      }
      return [country, null];
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
      const gcResult = minGiftCardCNY(effectiveAmount, currency);
      if (gcResult != null) {
        gcCnyPrice = gcResult.cny;
        sgdPrice = gcResult.cny * cnyToSgd;
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

  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL; // e.g. https://artfetcher-4vt8.onrender.com
  const bot = new TelegramBot(token, { polling: false });

  if (webhookUrl) {
    // Webhook mode: Render routes HTTP to one instance at a time — no 409 conflicts
    app.use(express.json());
    app.post('/telegram-webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
    bot.setWebhook(`${webhookUrl}/telegram-webhook`)
      .then(() => console.log(`  Telegram bot active (webhook: ${webhookUrl}/telegram-webhook).`))
      .catch(e => console.error('  Telegram setWebhook failed:', e.message));
  } else {
    // Polling mode: local development only
    bot.deleteWebhook()
      .catch(() => {})
      .then(() => bot.startPolling({ interval: 2000, params: { timeout: 10 } }));
    console.log('  Telegram bot active (polling).');
  }
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
      // If all regions are "Not Available", send debug log so we can diagnose
      const allUnavailable = data.results && data.results.every(r => !r.rawPrice);
      if (allUnavailable) {
        const logText = logs.join('\n');
        await bot.sendMessage(chatId, `🔧 Debug (all unavailable):\n${logText}`);
      }
    } catch (err) {
      const logText = logs.length ? `\n\nDebug:\n${logs.slice(-8).join('\n')}` : '';
      await bot.sendMessage(chatId, `❌ Error: ${err.message}${logText}`);
    }
  }

  function escGc(s) { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

  const GC_FLAG   = { USD: '🇺🇸', BRL: '🇧🇷', CAD: '🇨🇦', MXN: '🇲🇽', AUD: '🇦🇺' };
  const GC_SYMBOL = { USD: '$', BRL: 'R$', CAD: 'CA$', MXN: 'MX$', AUD: 'A$' };

  function formatGcPrices() {
    const cnyToSgd = rateCache?.rates?.['CNY'] ?? null;
    const lines = ['🎴 *Gift Card Prices*'];
    if (cnyToSgd) lines.push(`_💱 1 CNY ≈ SGD ${escGc(cnyToSgd.toFixed(4))}_`);
    lines.push('');

    for (const cur of GC_CURRENCIES) {
      const sym = GC_SYMBOL[cur] || cur;
      lines.push(`${GC_FLAG[cur]} *${cur}*`);
      for (const [denom, cny] of Object.entries(gcPrices[cur])) {
        const card = escGc(`${sym}${denom}`);
        if (cny == null) { lines.push(`  • ${card} — _not set_`); continue; }
        const sgd = cnyToSgd ? ` ≈ *S\\$${escGc((cny * cnyToSgd).toFixed(2))}*` : '';
        lines.push(`  • ${card} → ${escGc(String(cny))} CNY${sgd}`);
      }
      lines.push('');
    }

    lines.push(`_✏️ /updategiftcard USD 10 60_`);
    return lines.join('\n');
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const match = text.match(ESHOP_URL_RE);

    if (match) {
      await handleUrl(chatId, match[0], msg.message_id);

    } else if (/^\d[\d.,]*\s*(?:[A-Z]{3}|yen|hkd|yuan)\b|^(?:[A-Z]{3}|yen|hkd|yuan)\s*\d[\d.,]*/i.test(text) && !/^\//.test(text)) {
      // Currency conversion: "60 BRL", "7920 yen", "HKD 50", "100 yuan", etc.
      const ALIASES = { yen: 'JPY', hkd: 'HKD', yuan: 'CNY' };
      const cm = text.replace(/,/g, '').match(/([\d.]+)\s*([A-Za-z]+)|([A-Za-z]+)\s*([\d.]+)/);
      if (cm) {
        const amount = parseFloat(cm[1] || cm[4]);
        const rawCur = (cm[2] || cm[3]).toLowerCase();
        const cur = (ALIASES[rawCur] || rawCur.toUpperCase());
        if (!rateCache) await getExchangeRates(m => console.log('[conv-rates]', m)).catch(() => {});
        const rates = rateCache?.rates;
        if (!rates || !rates[cur]) {
          await bot.sendMessage(chatId, `⚠️ Unknown currency: *${escGc(cur)}*`, { parse_mode: 'MarkdownV2' });
        } else {
          const cnyToSgd = rates['CNY'];
          const hasDenoms = cur in gcPrices && Object.keys(gcPrices[cur]).length > 0;

          const liveRateDenoms = GIFT_CARD_DENOMS[cur]; // e.g. JPY [500,1000] — no fixed CNY price
          if (hasDenoms && cnyToSgd) {
            // Fixed-price gift card path (USD/BRL/CAD/MXN/AUD): DP finds cheapest combo
            const denoms = Object.keys(gcPrices[cur]).map(Number).sort((a, b) => a - b);
            const gcAmount = minGiftCardAmount(amount, denoms);
            const gcResult = minGiftCardCNY(gcAmount, cur);
            const cny = gcResult?.cny ?? null;
            const sgd = cny !== null ? (cny * cnyToSgd).toFixed(2) : null;
            const breakdownStr = gcResult
              ? gcResult.breakdown.map(b => `${b.count}×${cur} ${b.denom}`).join(' \\+ ')
              : escGc(String(gcAmount));

            const lines = [
              `🎴 *${escGc(String(amount))} ${escGc(cur)}* via gift cards`,
              `🃏 ${breakdownStr}`,
              `💴 *${escGc(String(cny))} CNY*`,
              sgd ? `💵 *S\\$${escGc(sgd)}*` : `_SGD rate unavailable_`,
            ];
            await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
          } else if (liveRateDenoms?.length && cnyToSgd) {
            // Live-rate gift card path (JPY etc.): denominations known, price via live rate
            const gcAmount = minGiftCardAmount(amount, liveRateDenoms);
            // Greedy breakdown — all denoms cost proportionally so greedy is optimal here
            const breakdown = [];
            let rem = gcAmount;
            for (const d of [...liveRateDenoms].sort((a, b) => b - a)) {
              const count = Math.floor(rem / d);
              if (count > 0) { breakdown.push(`${count}×${cur} ${d}`); rem -= count * d; }
            }
            const sgd = (gcAmount * rates[cur]).toFixed(2);
            const cny = (gcAmount * rates[cur] / cnyToSgd).toFixed(1);
            const lines = [
              `🎴 *${escGc(String(amount))} ${escGc(cur)}* via gift cards`,
              `🃏 ${escGc(breakdown.join(' + '))}`,
              `💴 *${escGc(cny)} CNY*`,
              `💵 *S\\$${escGc(sgd)}*`,
            ];
            await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
          } else {
            // Direct live rate (no gift card denominations available)
            const sgd = (amount * rates[cur]).toFixed(2);
            await bot.sendMessage(chatId,
              `💱 *${escGc(String(amount))} ${escGc(cur)}* \\= *S\\$${escGc(sgd)}*\n_Live rate \\(${escGc(rateCache.source || 'ECB')}\\)_`,
              { parse_mode: 'MarkdownV2' });
          }
        }
      }

    } else if (/^\/solver\b/.test(text)) {
      const sm = text.match(/^\/solver\s+([A-Za-z]{3})\s+([\d.,]+)/i);
      if (!sm) {
        await bot.sendMessage(chatId,
          '🧩 *eShop Price Solver*\nFinds up to 5 combinations of eShop games whose prices add up exactly to your target\\.\n\n' +
          '*Usage:* `/solver USD 5.05`\nSupported: ' + escGc(Object.keys(SOLVER_REGIONS).join(', ')) + '\n\n' +
          'Full tool: https://imbbloh\\.github\\.io/eshop\\-price\\-solver/',
          { parse_mode: 'MarkdownV2' });
        return;
      }
      const solverCur = sm[1].toUpperCase();
      const solverAmount = parseFloat(sm[2].replace(',', '.'));
      const solverConf = SOLVER_REGIONS[solverCur];
      if (!solverConf || !isFinite(solverAmount) || solverAmount <= 0) {
        await bot.sendMessage(chatId,
          `⚠️ Unsupported currency or amount\\. Supported: ${escGc(Object.keys(SOLVER_REGIONS).join(', '))}`,
          { parse_mode: 'MarkdownV2' });
        return;
      }
      const statusMsg = await bot.sendMessage(chatId, '🧩 Solving\\.\\.\\.', { parse_mode: 'MarkdownV2' });
      try {
        const games = await fetchSolverGames(solverConf.region);
        const targetCents = Math.round(solverAmount * 100);
        const results = solveCombos(games, targetCents, 5);
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        if (!results.length) {
          await bot.sendMessage(chatId,
            `❌ No exact combination adds up to *${escGc(solverCur)} ${escGc(solverAmount.toFixed(2))}*\\.`,
            { parse_mode: 'MarkdownV2' });
          return;
        }
        const MEDAL = ['🥇', '🥈', '🥉'];
        const fmt = c => solverConf.currency + (c / 100).toFixed(2);
        const lines = [`🧩 *${escGc(solverCur)} ${escGc(solverAmount.toFixed(2))}* — ${results.length} combination${results.length > 1 ? 's' : ''}:`, ''];
        results.forEach((combo, idx) => {
          const sum = combo.reduce((a, g) => a + g.price, 0);
          const medal = MEDAL[idx] || `\\#${idx + 1}`;
          lines.push(`${medal} ${combo.length} game${combo.length > 1 ? 's' : ''} \\(${escGc(fmt(sum))}\\)`);
          for (const g of combo) lines.push(`   • [${escGc(g.title)}](${g.url}) — ${escGc(fmt(g.price))}`);
          lines.push('');
        });
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
      } catch (err) {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        await bot.sendMessage(chatId, `❌ Solver error: ${err.message}`);
      }

    } else if (/^\/giftcards?\b/.test(text)) {
      if (!rateCache) await getExchangeRates(m => console.log('[gc-rates]', m)).catch(() => {});
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
        '🎮 *Search:* Just type the game name\ne\\.g\\. Monster Hunter Rise\n\n' +
        '🌐 *Supported URLs:*\n• eshop\\-prices\\.com/games/\\.\\.\\.\n• dekudeals\\.com/items/\\.\\.\\.\n• nintendo\\.com/\\*/store/products/\\.\\.\\.\n\n' +
        '🎁 *Gift cards:*\n• /giftcards — view CNY prices\n• /updategiftcard USD 10 60\n• /addgiftcard USD 25 150\n\n' +
        '🧮 *Solver:*\n• /solver USD 5\\.05\n\n' +
        '🇺🇸🇨🇦🇧🇷🇲🇽🇯🇵🇭🇰🇸🇬🇦🇺',
        { parse_mode: 'MarkdownV2' }
      );

    } else if (text && !text.startsWith('/')) {
      // Plain text: treat as game title search
      const slug = toNintendoSlug(text);
      if (slug) {
        await handleUrl(chatId, `https://www.nintendo.com/us/store/products/${slug}/`, msg.message_id);
      }
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
