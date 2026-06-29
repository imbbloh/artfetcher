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
  USD: { '5': null, '10': null },
  BRL: { '30': null, '50': null },
  CAD: { '10': null, '20': null, '25': null },
  MXN: { '100': null, '200': null, '350': null },
  AUD: { '15': null },
};

function loadGcPrices() {
  try {
    const fs = require('fs');
    if (fs.existsSync(GC_PRICES_FILE)) {
      const saved = JSON.parse(fs.readFileSync(GC_PRICES_FILE, 'utf8'));
      for (const [cur, denoms] of Object.entries(saved))
        if (cur in gcPrices && denoms && typeof denoms === 'object')
          for (const [d, v] of Object.entries(denoms))
            if (d in gcPrices[cur] && (typeof v === 'number' || v === null)) gcPrices[cur][d] = v;
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
const CACHE_TTL = 4 * 60 * 60 * 1000;

let rateCache = null;
let rateCacheTime = 0;
const RATE_TTL = 60 * 60 * 1000;

let algoliaKeyCache = { key: null, time: 0 };
const ALGOLIA_KEY_TTL = 12 * 60 * 60 * 1000;
const ALGOLIA_APP_ID = 'U3B6GR4UA3';

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
    browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
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

// ─── URL helpers ─────────────────────────────────────────────────────────────

const SUPPORTED_URL = /eshop-prices\.com\/games\/|dekudeals\.com\/items\/|(?:www\.)?nintendo\.com\/[a-z]{2}\/store\/products\//i;

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
  let usNsuid = null;
  let gameName = '';

  const add = (id) => { const s = String(id || ''); if (/^700[0-9]\d{10}$/.test(s) && !seen.has(s)) { seen.add(s); nsuids.push(s); } };
  const addMany = (ids) => { for (const id of (ids || [])) add(id); };

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
          for (const { d } of scored.slice(0, 5)) for (const id of (d.nsuid_txt || [])) { add(id); ids.push(id); }
          emit(`Asia catalog (${locale}): +${nsuids.length - before} nsuid(s) [${ids.join(',')}]`);
        } catch (e) { emit(`Asia catalog (${locale}): ${e.message.slice(0, 50)}`); }
      }
    })(),
    getAlgoliaKey(emit),
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

  emit(`Phase 1 done: "${gameName}", ${nsuids.length} nsuids found`);
  return { nsuids, seen, gameName, euNsuids, usNsuid };
}

// ─── Phase 2: slow nsuid discovery (probe + eshop-prices browser) ─────────────

async function findNsuidsPhase2(gameUrl, { seen, gameName, euNsuids, usNsuid }, emit) {
  const newNsuids = [];
  const addNew = (id) => { const s = String(id || ''); if (/^700[0-9]\d{10}$/.test(s) && !seen.has(s)) { seen.add(s); newNsuids.push(s); } };

  const SAME_RANGE = 10000n;
  const JP_GAP = 10n;
  const HK_GAP = 50n;

  // Anchor EU primary to the EU nsuid closest to usNsuid
  const anchorEu = usNsuid && euNsuids.length
    ? euNsuids.reduce((best, id) => {
        const d = (BigInt(usNsuid) > BigInt(id) ? BigInt(usNsuid) - BigInt(id) : BigInt(id) - BigInt(usNsuid));
        const bd = (BigInt(usNsuid) > BigInt(best) ? BigInt(usNsuid) - BigInt(best) : BigInt(best) - BigInt(usNsuid));
        return d < bd ? id : best;
      })
    : (euNsuids.length ? euNsuids.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b) : null);

  const euPrimary = anchorEu ? euNsuids.filter(id => { const d = BigInt(id) > BigInt(anchorEu) ? BigInt(id) - BigInt(anchorEu) : BigInt(anchorEu) - BigInt(id); return d <= SAME_RANGE; }) : [];
  const euBigInts = euPrimary.map(id => BigInt(id));
  emit(`Probe: usNsuid=${usNsuid} anchorEu=${anchorEu} euPrimary=[${euPrimary.join(',')}]`);

  const probeKeywords = (gameName || '').toLowerCase().split(/[\s\-:™®©,.'!?]+/).filter(w => w.length >= 3 || /^\d{3,}$/.test(w));

  function buildProbeIds(bases, gap) {
    const s = new Set();
    for (const b of bases) {
      const bn = BigInt(b);
      for (let d = 1n; d <= gap; d++)
        for (const p of [String(bn + d), String(bn - d)])
          if (/^700[0-9]\d{10}$/.test(p) && !seen.has(p)) s.add(p);
    }
    return [...s];
  }

  async function probeRegion(cc, lang, probeIds, baseBigInts, maxGap) {
    if (!probeIds.length) { emit(`${cc} probe: no base`); return; }
    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < probeIds.length; i += CHUNK) chunks.push(probeIds.slice(i, i + CHUNK));

    const results = [];
    for (let i = 0; i < chunks.length; i += 3) {
      const batch = await Promise.allSettled(chunks.slice(i, i + 3).map(chunk =>
        axios.get(`https://api.ec.nintendo.com/v1/price?country=${cc}&lang=${lang}&ids=${chunk.join(',')}`, { timeout: 20000 })
      ));
      results.push(...batch);
    }

    let loggedFields = false;
    const candidates = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const p of (r.value.data?.prices || [])) {
        if (!loggedFields) { emit(`${cc} API fields: ${Object.keys(p).join(',')}`); loggedFields = true; }
        if (p.sales_status !== 'not_found' && (p.regular_price || p.discount_price) && !seen.has(String(p.title_id)))
          candidates.push({ id: String(p.title_id), name: (p.formal_name || p.title || p.name || '').toLowerCase() });
      }
    }
    emit(`${cc} probe: ${candidates.length} candidates`);
    if (!candidates.length) return;

    const ranked = candidates
      .map(({ id, name }) => ({ id, name, gap: baseBigInts.reduce((min, b) => { const d = b > BigInt(id) ? b - BigInt(id) : BigInt(id) - b; return d < min ? d : min; }, maxGap + 1n) }))
      .filter(x => x.gap <= maxGap)
      .sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0))
      .slice(0, 10);
    emit(`${cc} probe: ranked=[${ranked.map(r => `${r.id}(gap${r.gap},"${r.name.slice(0, 20)}")`).join(', ')}] kws=[${probeKeywords.join(',')}]`);

    const verified = ranked.map(({ id, name, gap }) => ({ id, gap, name, kwMatch: name.length > 0 && probeKeywords.some(kw => name.includes(kw)) }));
    const verifiedHits = verified.filter(r => r.kwMatch);
    // Within gap ≤3, accept any candidate even with a non-English name (JP/HK return Japanese/Chinese
    // titles that can't be keyword-verified against English search terms).
    const closeAny = verified.filter(r => !r.kwMatch && r.gap <= 3n);
    const best = [...verifiedHits, ...closeAny].sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0))[0];
    if (best) { addNew(best.id); emit(`${cc} probe: accepted ${best.id} (gap ${best.gap}, verified=${best.kwMatch})`); }
    else emit(`${cc} probe: none accepted (verified=${verifiedHits.length}, closeAny=${closeAny.length})`);
  }

  const jpBase = usNsuid ? [usNsuid] : euPrimary;
  const hkBase = euPrimary;
  const US_GAP = 20n;

  // Probes are fast (~1-2s). Run them first so results aren't delayed by the browser.
  // US probe runs only when usNsuid wasn't found in Phase 1 (Algolia/nintendo.com missed).
  await Promise.allSettled([
    probeRegion('JP', 'ja', buildProbeIds(jpBase, JP_GAP), jpBase.map(BigInt), JP_GAP),
    probeRegion('HK', 'zh', buildProbeIds(hkBase, HK_GAP), euBigInts, HK_GAP),
    ...(!usNsuid && euPrimary.length ? [probeRegion('US', 'en', buildProbeIds(euPrimary, US_GAP), euBigInts, US_GAP)] : []),
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

  // Phase 2: fast probes (JP/HK) — completes in ~2s
  const probeNsuids = await findNsuidsPhase2(gameUrl, phase1, emit);
  const p2Nsuids = [...phase1.nsuids, ...probeNsuids];
  const p2Prices = await getNintendoPrices(p2Nsuids, emit);
  const p2Data = buildResultData(phase1.gameName, p2Prices, rateResult);
  cache.set(gameUrl, { data: p2Data, time: Date.now() });

  // Phase 3: browser (slow, may hit Cloudflare) — runs in background, only updates cache
  // No callback here — browser result is available on next lookup via cache
  fetchNsuidsFromEshopPricesBrowser(gameUrl, emit).then(async (browserIds) => {
    const newFromBrowser = browserIds.filter(id => !phase1.seen.has(id) && !probeNsuids.includes(id));
    if (!newFromBrowser.length) { emit('Browser: no new nsuids'); return; }
    emit(`Browser: +${newFromBrowser.length} new nsuid(s), updating cache`);
    const p3Nsuids = [...p2Nsuids, ...newFromBrowser];
    const p3Prices = await getNintendoPrices(p3Nsuids, emit);
    const p3Data = buildResultData(phase1.gameName, p3Prices, rateResult);
    cache.set(gameUrl, { data: p3Data, time: Date.now() });
  }).catch(() => {});

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
  const ESHOP_URL_RE = /https?:\/\/(?:eshop-prices\.com\/games\/|(?:www\.)?dekudeals\.com\/items\/|(?:www\.)?nintendo\.com\/[a-z]{2}\/store\/products\/)[^\s]+/i;

  async function handleUrl(chatId, gameUrl, messageId) {
    const statusMsg = await bot.sendMessage(chatId, '🔍 Searching prices\\.\\.\\. please wait\\.', { parse_mode: 'MarkdownV2', reply_to_message_id: messageId });
    const logs = [];
    const emit = (msg) => { logs.push(msg); console.log('[bot]', msg); };

    let partialMsgId = null;
    const onPartial = async (data) => {
      try {
        const text = formatTelegramMessage(data, '_⏳ Initial results \\(still searching JP/HK/SG\\)…_');
        const sent = await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
        partialMsgId = sent.message_id;
      } catch {}
    };

    try {
      const data = await buildResults(gameUrl, emit, onPartial);
      const finalText = formatTelegramMessage(data);
      if (partialMsgId) {
        await bot.editMessageText(finalText, { chat_id: chatId, message_id: partialMsgId, parse_mode: 'MarkdownV2', disable_web_page_preview: true }).catch(err => {
          // "message is not modified" means content unchanged (Phase 2 found nothing new) — no action needed
          if (!String(err.message).includes('message is not modified')) {
            return bot.sendMessage(chatId, finalText, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
          }
        });
      } else {
        await bot.sendMessage(chatId, finalText, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
      }
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
      // /updategiftcard USD 10 60  or  /updategiftcard BRL 30 40.9
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
        `✅ *${cur} ${denom}* gift card set to *${escGc(cny)} CNY*\\.\nPrice caches cleared\\.`,
        { parse_mode: 'MarkdownV2' });

    } else if (/^\/start|\/help/.test(text)) {
      await bot.sendMessage(chatId,
        '👋 Send me a game link and I\'ll show you the best prices in SGD\\.\n\n' +
        '*Supported URLs:*\n• eshop\\-prices\\.com/games/\\.\\.\\.\n• dekudeals\\.com/items/\\.\\.\\.\n• nintendo\\.com/\\*/store/products/\\.\\.\\.\n\n' +
        '*Gift card commands:*\n• `/giftcards` — view all current CNY prices\n• `/updategiftcard USD 10 60` — set CNY price for a denomination\n\n' +
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
