#!/usr/bin/env node
const express = require('express');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');
const cheerio = require('cheerio');

// 2-letter ISO codes for Nintendo eShop API
const COUNTRY_CODE = {
  'United States': 'US', 'Singapore': 'SG', 'Hong Kong': 'HK',
  'Brazil': 'BR', 'Japan': 'JP', 'Canada': 'CA',
  'Mexico': 'MX', 'Australia': 'AU',
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const TARGET_COUNTRIES = [
  'United States', 'Singapore', 'Hong Kong', 'Brazil',
  'Japan', 'Canada', 'Mexico', 'Australia',
];

const COUNTRY_CURRENCY = {
  'United States': 'USD', 'Singapore': 'SGD', 'Hong Kong': 'HKD',
  'Brazil': 'BRL', 'Japan': 'JPY', 'Canada': 'CAD',
  'Mexico': 'MXN', 'Australia': 'AUD',
};

const COUNTRY_FLAG = {
  'United States': '🇺🇸', 'Singapore': '🇸🇬', 'Hong Kong': '🇭🇰',
  'Brazil': '🇧🇷', 'Japan': '🇯🇵', 'Canada': '🇨🇦',
  'Mexico': '🇲🇽', 'Australia': '🇦🇺',
};

const GIFT_CARD_DENOMS = {
  USD: [5, 10], SGD: null, HKD: null, BRL: [30, 50],
  JPY: [500, 1000], CAD: [10, 20, 25], MXN: [100, 200, 350], AUD: [15],
};

// Cache: keyed by URL, expires after 4 hours
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// Exchange rates cached for 1 hour
let rateCache = null;
let rateCacheTime = 0;
const RATE_TTL = 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findChromiumExecutable() {
  const fs = require('fs');
  try {
    const pw = require('playwright-core');
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  try {
    // playwright-extra wraps playwright-core; try directly
    const { chromium: pwChromium } = require('playwright-core');
    const p = pwChromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const known = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of known) { try { if (fs.existsSync(p)) return p; } catch {} }
  return undefined;
}

function minGiftCardAmount(price, denoms) {
  if (!denoms || !denoms.length) return price;
  const target = Math.ceil(price);
  const maxSearch = target + Math.max(...denoms) * 2;
  const reachable = new Uint8Array(maxSearch + 1);
  reachable[0] = 1;
  for (let i = 1; i <= maxSearch; i++) {
    for (const d of denoms) {
      if (d <= i && reachable[i - d]) { reachable[i] = 1; break; }
    }
  }
  for (let i = target; i <= maxSearch; i++) {
    if (reachable[i]) return i;
  }
  return null;
}

function parsePrice(text) {
  let s = text.replace(/[^\d,. ]/g, ' ').trim().split(/\s+/)[0];
  if (/\d{1,3}\.\d{3},\d{2}/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\d+,\d{2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Reverse map: "US" → "United States" etc.
const CODE_TO_COUNTRY = Object.fromEntries(Object.entries(COUNTRY_CODE).map(([k, v]) => [v, k]));

function matchCountry(cellText) {
  const lower = cellText.toLowerCase().trim();
  for (const t of TARGET_COUNTRIES) {
    if (lower.includes(t.toLowerCase()) || t.toLowerCase().includes(lower)) return t;
  }
  // Match 2-letter country codes in parentheses: "(US)", "(JP)", "eShop (AU)" etc.
  const codeMatch = cellText.match(/\(([A-Z]{2})\)/);
  if (codeMatch && CODE_TO_COUNTRY[codeMatch[1]]) return CODE_TO_COUNTRY[codeMatch[1]];
  // Standalone 2-letter code at start: "US ", "JP "
  const startCode = cellText.match(/^([A-Z]{2})\b/);
  if (startCode && CODE_TO_COUNTRY[startCode[1]]) return CODE_TO_COUNTRY[startCode[1]];
  const word = lower.split(/[\s,]/)[0];
  for (const t of TARGET_COUNTRIES) {
    if (t.toLowerCase().startsWith(word) && word.length >= 4) return t;
  }
  return null;
}

function rowsToMap(rows) {
  const priceMap = {};
  for (const row of rows) {
    if (row.length < 2) continue;
    const matched = matchCountry(row[0]);
    if (!matched || priceMap[matched]) continue;
    for (let i = 1; i < row.length; i++) {
      const cell = row[i];
      const hasNum = /\d/.test(cell);
      const hasCur = /[$¥€£R]|USD|SGD|HKD|BRL|JPY|CAD|MXN|AUD|Free/i.test(cell);
      if (hasNum && hasCur) { priceMap[matched] = cell.trim(); break; }
      if (hasNum && i === 1) { priceMap[matched] = cell.trim(); break; }
    }
  }
  return priceMap;
}

// ─── Exchange rates (frankfurter.app — fast REST, no browser) ─────────────────

async function getExchangeRates(emit) {
  const now = Date.now();
  if (rateCache && now - rateCacheTime < RATE_TTL) {
    emit('Using cached exchange rates.');
    return rateCache;
  }

  emit('Fetching live exchange rates...');
  const currencies = Object.values(COUNTRY_CURRENCY).filter((c) => c !== 'SGD').join(',');
  const res = await axios.get(
    `https://api.frankfurter.app/latest?from=SGD&to=${currencies}`,
    { timeout: 10000 }
  );
  const sgdRates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(res.data.rates)) {
    sgdRates[cur] = 1 / rate;
  }
  rateCache = { rates: sgdRates, source: 'frankfurter.app / ECB (live daily)' };
  rateCacheTime = now;
  emit('Exchange rates ready.');
  return rateCache;
}

function formatNintendoPrice(amount, currency) {
  const sym = { USD:'US$', SGD:'S$', HKD:'HK$', BRL:'R$', JPY:'¥', CAD:'CA$', MXN:'MX$', AUD:'A$' };
  const prefix = sym[currency] || (currency + ' ');
  const value = currency === 'JPY'
    ? Math.round(amount).toLocaleString('en')
    : parseFloat(amount).toFixed(2);
  return `${prefix}${value}`;
}

// Use Playwright to load an eshop-prices.com game page and extract regional nsuids.
// eshop-prices uses its own backend (not Nintendo APIs directly), so nsuids come from
// their JS page state or API responses — we capture both.
async function fetchNsuidsFromEshopPricesBrowser(gameUrl, emit) {
  if (!gameUrl.includes('eshop-prices.com')) return [];
  emit('Launching browser to capture nsuids from eshop-prices.com...');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: findChromiumExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const interceptedNsuids = new Set();

    // Capture nsuids from ALL network responses (eshop-prices uses its own backend)
    page.on('response', async resp => {
      try {
        const text = await resp.text().catch(() => '');
        (text.match(/7001\d{10}/g) || []).forEach(id => interceptedNsuids.add(id));
      } catch {}
    });
    // Also capture from outbound request URLs (in case Nintendo API is called directly)
    page.on('request', req => {
      (req.url().match(/7001\d{10}/g) || []).forEach(id => interceptedNsuids.add(id));
    });

    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for Cloudflare challenge to clear
    const t = await page.title();
    if (t.includes('Just a moment') || t.includes('Attention Required')) {
      emit('eshop-prices: Cloudflare detected, waiting...');
      await page.waitForFunction(
        () => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'),
        { timeout: 25000 }
      ).catch(() => {});
    }

    // Wait for dynamic price sections to render and their API calls to complete
    await page.waitForTimeout(8000);

    // Extract nsuids from the page's JavaScript global state (Nuxt/Next/Vue pre-loaded data)
    const stateNsuids = await page.evaluate(() => {
      const text = document.documentElement.innerHTML;
      return (text.match(/7001\d{10}/g) || []);
    }).catch(() => []);
    stateNsuids.forEach(id => interceptedNsuids.add(id));

    // Also try extracting from window.__NUXT__ or similar global state objects
    const globalNsuids = await page.evaluate(() => {
      try {
        const state = JSON.stringify(window.__NUXT__ || window.__NEXT_DATA__ || window.__INITIAL_STATE__ || {});
        return (state.match(/7001\d{10}/g) || []);
      } catch { return []; }
    }).catch(() => []);
    globalNsuids.forEach(id => interceptedNsuids.add(id));

    const found = [...interceptedNsuids];
    emit(`eshop-prices browser: ${found.length} nsuid(s) captured`);
    return found;
  } catch (e) {
    emit(`eshop-prices browser: ${e.message.slice(0, 70)}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Strategy 1: Nintendo eShop API (no Cloudflare, fast) ────────────────────

// The Algolia API key is embedded as a literal in Nintendo.com's JS bundles.
// We scan the bundles via HTTP (no browser needed). Key is cached 12h.
let algoliaKeyCache = { key: null, time: 0 };
const ALGOLIA_KEY_TTL = 12 * 60 * 60 * 1000;
const ALGOLIA_APP_ID = 'U3B6GR4UA3';

async function getAlgoliaKeyFromBundles(emit) {
  const now = Date.now();
  if (algoliaKeyCache.key && now - algoliaKeyCache.time < ALGOLIA_KEY_TTL) {
    return algoliaKeyCache.key;
  }
  emit('Scanning Nintendo.com JS bundles for Algolia key...');
  try {
    const rootRes = await axios.get('https://www.nintendo.com/', {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = String(rootRes.data);
    const bundlePaths = [...new Set((html.match(/\/_next\/static\/[^"' ]+\.js/g) || []))].slice(0, 20);
    if (!bundlePaths.length) { emit('No Next.js bundles found on nintendo.com root'); return null; }

    const bundleResults = await Promise.allSettled(
      bundlePaths.map(p => axios.get(`https://www.nintendo.com${p}`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }))
    );
    for (const r of bundleResults) {
      if (r.status !== 'fulfilled') continue;
      const text = String(r.value.data);
      if (!text.includes(ALGOLIA_APP_ID)) continue;
      // Algolia search key is a 32-char hex string near the App ID
      const m = text.match(new RegExp(
        `${ALGOLIA_APP_ID}.{0,150}?([a-f0-9]{32})|([a-f0-9]{32}).{0,150}?${ALGOLIA_APP_ID}`, 's'
      ));
      const key = m?.[1] || m?.[2];
      if (key) {
        algoliaKeyCache = { key, time: now };
        emit(`Algolia key found in bundle: ${key.slice(0, 8)}...`);
        return key;
      }
    }
    emit('Algolia key not found in bundles');
  } catch (e) { emit(`Bundle scan error: ${e.message.slice(0, 60)}`); }
  return algoliaKeyCache.key;
}

// Convert a display game name to a URL slug
function toNintendoSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Fetch a URL and return all 7001-prefixed nsuids found anywhere in the response
async function fetchNsuidsFromUrl(url, label, emit) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const found = [...new Set((String(res.data).match(/7001\d{10}/g) || []))];
    if (found.length) emit(`${label}: ${found.length} nsuid(s) found`);
    return found;
  } catch (e) {
    emit(`${label}: ${e.message.slice(0, 70)}`);
    return [];
  }
}

async function findNsuids(gameUrl, emit) {
  const rawSlug = gameUrl.split('/').pop().replace(/^\d+-/, '');
  const slug = rawSlug.replace(/-/g, ' ');
  const gameId = gameUrl.match(/\/games\/(\d+)/)?.[1];
  emit(`Searching Nintendo catalogs for "${slug}"...`);
  const q = encodeURIComponent(slug);
  const words = slug.toLowerCase().split(' ').filter(w => w.length > 2);

  const seen = new Set();
  const nsuids = [];
  let gameName = '';
  const euNsuids = []; // nsuids confirmed from EU catalog (always for THIS game)
  let usNsuid = null;  // US/Americas nsuid from Algolia (used as JP probe base)
  const add = (id) => {
    const s = String(id || '');
    if (/^7001\d{10}$/.test(s) && !seen.has(s)) { seen.add(s); nsuids.push(s); }
  };
  const addMany = (ids) => { for (const id of (ids || [])) add(id); };
  const extractFromText = (text) => { addMany(String(text || '').match(/7001\d{10}/g) || []); };

  // ── Phase 1: EU catalog + Algolia key fetch in parallel ────────────────────

  const [, algoliaKey] = await Promise.all([
    // EU/AUS catalog — our only confirmed-working source
    (async () => {
      try {
        const euRes = await axios.get(
          `https://searching.nintendo-europe.com/en/select?q=${q}&fq=type%3AGAME&rows=10&wt=json&fl=title,nsuid_txt`,
          { timeout: 12000 }
        );
        const docs = euRes.data?.response?.docs || [];
        const scored = docs
          .map(d => ({ d, score: words.filter(w => (d.title || '').toLowerCase().includes(w)).length }))
          .sort((a, b) => b.score - a.score);
        if (scored.length && scored[0].d.title) gameName = scored[0].d.title;
        const before = nsuids.length;
        for (const { d } of scored.slice(0, 5))
          for (const id of (d.nsuid_txt || [])) { add(id); euNsuids.push(id); }
        emit(`EU catalog: +${nsuids.length - before} nsuid(s)`);
      } catch (e) { emit(`EU catalog error: ${e.message.slice(0, 60)}`); }
    })(),
    // Algolia key from bundle scan (runs in parallel with EU catalog)
    getAlgoliaKeyFromBundles(emit),
  ]);

  // ── Phase 2: US product page + ec.nintendo.com + Algolia ─────────────────
  // gameName is now set by EU catalog; nameSlug is used for product page lookups.

  const nameSlug = toNintendoSlug(gameName || slug);
  // Try multiple slug variants — some games use -switch suffix, others don't
  const slugVariants = [...new Set([
    nameSlug + '-switch', rawSlug + '-switch',
    nameSlug, rawSlug,
  ])];

  await Promise.allSettled([

    // Nintendo.com product pages (no locale prefix — locale-prefixed paths return 404 server-side)
    // These pages embed the US nsuid (and many other game nsuids for recommendations).
    ...slugVariants.map(s =>
      fetchNsuidsFromUrl(
        `https://www.nintendo.com/store/products/${s}/`,
        `Nintendo.com product (${s})`, emit
      ).then(addMany)
    ),

    // Americas nsuid via Algolia (US, CA, BR, MX share one nsuid)
    algoliaKey ? (async () => {
      const indexes = ['store_game_en_us_release_date', 'store_game_en_us', 'noa_aem_game_en_us'];
      for (const indexName of indexes) {
        try {
          const algRes = await axios.post(
            'https://u3b6gr4ua3-dsn.algolia.net/1/indexes/*/queries',
            { requests: [{ indexName, params: `query=${q}&hitsPerPage=5` }] },
            {
              headers: {
                'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                'X-Algolia-API-Key': algoliaKey,
                'Content-Type': 'application/json',
              },
              timeout: 10000,
            }
          );
          const hits = algRes.data?.results?.[0]?.hits || [];
          const before = nsuids.length;
          // Pick usNsuid from the hit whose title best matches our game name.
          // Don't just take [0] — Algolia may rank a bundle/edition above the base game.
          const titleWords = (gameName || slug).toLowerCase().split(/\W+/).filter(w => w.length > 2);
          let bestHit = null, bestScore = -1;
          for (const hit of hits) {
            if (!hit.nsuid || !/^7001\d{10}$/.test(String(hit.nsuid))) continue;
            const ht = (hit.title || '').toLowerCase();
            const score = titleWords.filter(w => ht.includes(w)).length;
            if (score > bestScore) { bestScore = score; bestHit = hit; }
          }
          if (bestHit && !usNsuid) usNsuid = String(bestHit.nsuid);
          for (const hit of hits) {
            add(hit.nsuid); addMany(hit.nsuid_txt || []); extractFromText(JSON.stringify(hit));
            if (!gameName && hit.title) gameName = hit.title;
          }
          emit(`Algolia ${indexName}: ${hits.length} hits, +${nsuids.length - before} new nsuids, usNsuid=${usNsuid}`);
          if (nsuids.length > before) break;
        } catch (e) {
          emit(`Algolia ${indexName}: ${e.message.slice(0, 50)}`);
          if (e.response?.status === 403) algoliaKeyCache.time = 0;
        }
      }
    })() : Promise.resolve(),

    // Nintendo HK store (Magento) — product URLs contain nsuid directly (/7001XXXXXXXXXX)
    fetchNsuidsFromUrl(`https://store.nintendo.com.hk/catalogsearch/result/?q=${q}`, 'HK store search', emit).then(addMany),
    fetchNsuidsFromUrl(`https://store.nintendo.com.hk/search?q=${q}`, 'HK store search2', emit).then(addMany),

    // SG eShop uses no language code in the URL path (ec.nintendo.com/SG//titles/NSUID)
    // Try SG catalog search with the correct double-slash path format
    fetchNsuidsFromUrl(`https://ec.nintendo.com/SG//titles/search?q=${q}`, 'SG// titles/search', emit).then(addMany),
    fetchNsuidsFromUrl(`https://ec.nintendo.com/SG//titles?q=${q}`, 'SG// titles?q', emit).then(addMany),
    fetchNsuidsFromUrl(`https://ec.nintendo.com/SG//titles?search=${q}`, 'SG// titles?search', emit).then(addMany),

    // eshop-prices.com — try JSON API first (fast, but 403 on Render/Cloudflare IPs),
    // then fall back to browser scrape which bypasses Cloudflare via stealth Playwright.
    (async () => {
      let gotNsuids = false;
      if (gameId) {
        try {
          const epRes = await axios.get(`https://eshop-prices.com/games/${gameId}.json`, { timeout: 8000 });
          const before = nsuids.length;
          extractFromText(JSON.stringify(epRes.data));
          if (nsuids.length > before) { emit(`eshop-prices API: +${nsuids.length - before} nsuid(s)`); gotNsuids = true; }
          else emit('eshop-prices API: reachable but no nsuids');
        } catch (e) { emit(`eshop-prices API: ${e.message.slice(0, 60)}`); }
      }
      if (!gotNsuids && gameUrl.includes('eshop-prices.com')) {
        const ids = await fetchNsuidsFromEshopPricesBrowser(gameUrl, emit);
        addMany(ids);
      }
    })(),

  ]);

  // ── Phase 3: Regional nsuid probe ────────────────────────────────────────────
  // JP: probe ±5 around the US nsuid (JP is almost always US±1–3, e.g. Dave JP=US−1,
  //     Zelda JP=US+1). Tight window → very few candidates → low false-positive risk.
  // HK: probe ±50 around the primary EU nsuid (HK gap from EU is ±3–50 for most games).
  // SG: nsuids are 50,000+ away from EU/US — no probe can reach them; skip.
  //
  // Only probe around EU nsuids in the SAME numeric range as the smallest (primary range).
  // The EU catalog can return nsuids from multiple editions (e.g. Dave: 060373 AND 111453).

  const SAME_RANGE = 10000n;
  const JP_GAP = 10n;  // JP is usually within ±10 of US nsuid (or EU if US not available)
  const HK_GAP = 50n;  // HK is usually within ±50 of EU nsuid

  const probeKeywords = (gameName || slug).toLowerCase()
    .split(/[\s\-:™®©,.'!?]+/)
    .filter(w => w.length >= 3 || /^\d{3,}$/.test(w));

  // Anchor EU primary to the EU nsuid CLOSEST to usNsuid (not the numerically smallest).
  // Example: Overcooked AYCA has euNsuids=[29236, 882, 3401, ...]. The smallest is 882
  // (a different Overcooked game), but usNsuid=29237 so closest EU is 29236 (the real one).
  const anchorEu = usNsuid && euNsuids.length
    ? euNsuids.reduce((best, id) => {
        const d = BigInt(usNsuid) > BigInt(id) ? BigInt(usNsuid) - BigInt(id) : BigInt(id) - BigInt(usNsuid);
        const bd = BigInt(usNsuid) > BigInt(best) ? BigInt(usNsuid) - BigInt(best) : BigInt(best) - BigInt(usNsuid);
        return d < bd ? id : best;
      })
    : (euNsuids.length ? euNsuids.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b)) : null);

  const euPrimaryIds = anchorEu
    ? euNsuids.filter(id => { const d = BigInt(id) > BigInt(anchorEu) ? BigInt(id) - BigInt(anchorEu) : BigInt(anchorEu) - BigInt(id); return d <= SAME_RANGE; })
    : [];
  const euBigInts = euPrimaryIds.map(id => BigInt(id));
  emit(`Probe: usNsuid=${usNsuid} anchorEu=${anchorEu} euPrimary=[${euPrimaryIds.join(',')}]`);

  // Build probe ID set for a given set of base IDs and gap radius
  function buildProbeSet(bases, gap) {
    const s = new Set();
    for (const b of bases) {
      const bn = BigInt(b);
      for (let d = 1n; d <= gap; d++) {
        for (const p of [String(bn + d), String(bn - d)]) {
          if (/^7001\d{10}$/.test(p) && !seen.has(p)) s.add(p);
        }
      }
    }
    return [...s];
  }

  // Query price API in chunks of 50 (max per request), throttling 3 concurrent calls.
  // Returns candidates with their formal_name from the API response — used for title
  // verification without a separate HTTP fetch (ec.nintendo.com is a React SPA; axios
  // gets a JS skeleton with empty <title>, so HTML verification never worked).
  async function probeRegion(cc, lang, probeIds, baseBigInts, maxGap) {
    if (!probeIds.length) { emit(`${cc} probe: skipped (no probe base)`); return; }
    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < probeIds.length; i += CHUNK) chunks.push(probeIds.slice(i, i + CHUNK));

    const chunkResults = [];
    for (let i = 0; i < chunks.length; i += 3) {
      const batch = chunks.slice(i, i + 3);
      const batchRes = await Promise.allSettled(batch.map(chunk =>
        axios.get(
          `https://api.ec.nintendo.com/v1/price?country=${cc}&lang=${lang}&ids=${chunk.join(',')}`,
          { timeout: 10000 }
        )
      ));
      chunkResults.push(...batchRes);
    }

    // Collect candidates WITH their formal_name from the price API response.
    // formal_name is the official game title returned per nsuid — use it for keyword
    // matching instead of scraping the SPA page (which returns an empty skeleton).
    const allCandidates = [];
    let loggedFields = false;
    for (const r of chunkResults) {
      if (r.status !== 'fulfilled') continue;
      for (const p of (r.value.data?.prices || [])) {
        if (!loggedFields) { emit(`${cc} price API fields: ${Object.keys(p).join(',')}`); loggedFields = true; }
        if (p.sales_status !== 'not_found' && (p.regular_price || p.discount_price) && !seen.has(String(p.title_id))) {
          // Try every field that might contain a title
          const name = (p.formal_name || p.title || p.name || '').toLowerCase();
          allCandidates.push({ id: String(p.title_id), name });
        }
      }
    }
    emit(`${cc} probe: ${allCandidates.length} price candidates`);
    if (!allCandidates.length) return;

    const ranked = allCandidates
      .map(({ id, name }) => ({ id, name, gap: baseBigInts.reduce((min, b) => { const d = b > BigInt(id) ? b - BigInt(id) : BigInt(id) - b; return d < min ? d : min; }, maxGap + 1n) }))
      .filter(x => x.gap <= maxGap)
      .sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0))
      .slice(0, 10);
    emit(`${cc} probe: ranked=[${ranked.map(r => `${r.id}(gap${r.gap},"${r.name.slice(0,20)}")`).join(', ')}]`);

    // Verify using formal_name from the price API (no extra HTTP calls)
    const withVerification = ranked.map(({ id, name, gap }) => {
      const kwMatch = name.length > 0 && probeKeywords.some(kw => name.includes(kw));
      return { id, gap, kwMatch, name };
    });
    emit(`${cc} kws=[${probeKeywords.join(',')}]`);

    const verifiedHits = withVerification.filter(r => r.kwMatch);
    // Proximity fallback: only when there is exactly ONE candidate at gap ≤ 3 and it has
    // no formal_name (API didn't return one). Multiple competing near-gap candidates need
    // verification to avoid picking the wrong game.
    const closeUnnamed = withVerification.filter(r => !r.kwMatch && !r.name && r.gap <= 3n);
    const proximityOnly = closeUnnamed.length === 1 ? closeUnnamed : [];
    const best = [...verifiedHits, ...proximityOnly].sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0))[0];
    if (best) {
      add(best.id);
      emit(`${cc} probe: accepted ${best.id} (gap ${best.gap}, name="${best.name}", verified=${best.kwMatch})`);
    } else {
      emit(`${cc} probe: no nsuid accepted (verified=${verifiedHits.length}, closeUnnamed=${closeUnnamed.length})`);
    }
  }

  // JP: probe ±10 around US nsuid (or EU anchor when no usNsuid available)
  const jpBase = usNsuid ? [usNsuid] : euPrimaryIds;
  emit(`JP probe base: ${jpBase.join(',')}`);
  const jpBigInts = jpBase.map(id => BigInt(id));
  const jpProbeIds = buildProbeSet(jpBase, JP_GAP);

  // HK: probe ±50 around EU anchor nsuids
  const hkProbeIds = buildProbeSet(euPrimaryIds, HK_GAP);

  await Promise.allSettled([
    probeRegion('JP', 'ja', jpProbeIds, jpBigInts, JP_GAP),
    probeRegion('HK', 'zh', hkProbeIds, euBigInts, HK_GAP),
  ]);

  if (!nsuids.length) throw new Error('No nsuids found in any Nintendo catalog');
  if (!gameName) gameName = slug;
  emit(`Found "${gameName}" — ${nsuids.length} nsuids: [${nsuids.join(', ')}]`);
  return { nsuids, gameName };
}

async function getNintendoPrices(nsuids, emit) {
  emit('Querying Nintendo eShop API per country...');

  // Pass ALL nsuids at once per country — API returns whichever is valid for that region
  const idsParam = nsuids.join(',');

  const entries = await Promise.all(
    Object.entries(COUNTRY_CODE).map(async ([country, code]) => {
      try {
        const res = await axios.get(
          `https://api.ec.nintendo.com/v1/price?country=${code}&lang=en&ids=${idsParam}`,
          { timeout: 10000 }
        );
        // Find first price that isn't "not_found"
        for (const p of (res.data?.prices || [])) {
          if (p.sales_status === 'not_found') continue;
          const price = p.discount_price || p.regular_price;
          if (!price) continue;
          const amount = parseFloat(price.raw_value ?? price.amount);
          return [country, { amount, currency: price.currency, onSale: !!p.discount_price }];
        }
        return [country, null];
      } catch {
        return [country, null];
      }
    })
  );

  return Object.fromEntries(entries);
}

async function scrapeViaNintendoApi(gameUrl, emit) {
  const { nsuids, gameName } = await findNsuids(gameUrl, emit);
  const nintendoPrices = await getNintendoPrices(nsuids, emit);

  const rows = Object.entries(nintendoPrices)
    .filter(([, data]) => data !== null)
    .map(([country, data]) => [country, formatNintendoPrice(data.amount, data.currency)]);

  if (!rows.length) throw new Error('Nintendo API returned no prices for this game');
  emit(`Got prices for ${rows.length} of ${Object.keys(COUNTRY_CODE).length} countries.`);
  return { title: gameName, rows };
}

// ─── Strategy 2: lightweight HTTP, Strategy 3: browser fallback ───────────────

async function scrapeViaHttp(gameUrl, emit) {
  emit('Trying fast HTTP scrape...');
  const res = await axios.get(gameUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    },
  });

  const $ = cheerio.load(res.data);
  const title = $('title').text().replace(/\s*[-|].*$/, '').trim();
  const rows = [];

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th').map((_, td) => $(td).text().trim()).get();
    if (cells.length >= 2) rows.push(cells);
  });

  if (title.includes('Just a moment') || title.includes('Attention Required')) {
    throw new Error('Cloudflare challenge — need browser');
  }
  if (!rows.length) throw new Error('No table rows found via HTTP — need browser');
  emit(`Fast scrape got ${rows.length} rows.`);
  return { title, rows };
}

async function scrapeViaBrowser(gameUrl, emit) {
  emit('Launching browser...');
  const browser = await chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    // Note: no --disable-blink-features=AutomationControlled — that flag is itself detectable
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    // Use newPage() directly so stealth plugin patches apply (not newContext)
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    emit('Loading page...');
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Cloudflare JS challenge to auto-resolve
    const challengeTitle = await page.title();
    if (challengeTitle.includes('Just a moment') || challengeTitle.includes('Attention Required')) {
      emit('Cloudflare check detected — waiting up to 15s for it to pass...');
      await page.waitForFunction(
        () => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'),
        { timeout: 15000 }
      ).catch(() => {});
    }

    // Wait for price table rows
    await page.waitForSelector('table tr', { timeout: 15000 }).catch(() => {});
    // Small buffer for any remaining JS rendering
    await page.waitForTimeout(500);

    const { title, rows } = await page.evaluate(() => {
      const tableRows = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((td) => td.innerText.trim());
        if (cells.length >= 2) tableRows.push(cells);
      });
      return {
        title: document.title.replace(/\s*[-|].*$/, '').trim(),
        rows: tableRows,
      };
    });

    await browser.close();

    if (title.includes('Just a moment') || title.includes('Attention Required')) {
      throw new Error('Cloudflare challenge did not resolve — try again in a moment');
    }
    if (!rows.length) {
      throw new Error('Page loaded but no price table found');
    }

    emit(`Loaded "${title}" — ${rows.length} table rows found.`);
    return { title, rows };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function scrapeGamePrices(gameUrl, emit) {
  // Nintendo API works for both sites — just needs the game slug, no Cloudflare
  try {
    return await scrapeViaNintendoApi(gameUrl, emit);
  } catch (err) {
    emit(`Nintendo API: ${err.message.slice(0, 80)} — trying HTTP scrape...`);
  }

  // Plain HTTP scrape (fallback — blocked by Cloudflare on both sites in practice)
  try {
    return await scrapeViaHttp(gameUrl, emit);
  } catch (err) {
    emit(`HTTP scrape failed — launching browser...`);
  }

  // Browser with stealth (last resort)
  return await scrapeViaBrowser(gameUrl, emit);
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function buildResults(gameUrl, emit) {
  // Check cache
  const cached = cache.get(gameUrl);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    emit('Returning cached result.');
    // Still refresh rates if needed
    const rateResult = await getExchangeRates(emit);
    if (rateResult.source !== cached.data.rateSource) {
      cached.data.rateSource = rateResult.source;
      cached.data.sgdRates = rateResult.rates;
    }
    return cached.data;
  }

  const [rateResult, scrapeResult] = await Promise.all([
    getExchangeRates(emit),
    scrapeGamePrices(gameUrl, emit),
  ]);

  const { rates: sgdRates, source: rateSource } = rateResult;
  const { title, rows } = scrapeResult;

  emit('Processing results...');
  const priceMap = rowsToMap(rows);

  const results = [];
  for (const country of TARGET_COUNTRIES) {
    const rawPrice = priceMap[country];
    const currency = COUNTRY_CURRENCY[country];
    const denoms = GIFT_CARD_DENOMS[currency];

    if (!rawPrice || /not/i.test(rawPrice) || rawPrice === '-') {
      results.push({ country, currency, rawPrice: null, effectiveAmount: null, sgdPrice: null, denoms });
      continue;
    }
    if (/^free$/i.test(rawPrice)) {
      results.push({ country, currency, rawPrice: 'Free', effectiveAmount: 0, sgdPrice: 0, denoms });
      continue;
    }

    const amount = parsePrice(rawPrice);
    if (amount === null) {
      results.push({ country, currency, rawPrice, effectiveAmount: null, sgdPrice: null, denoms });
      continue;
    }

    const effectiveAmount = denoms ? minGiftCardAmount(amount, denoms) : amount;
    const rate = sgdRates[currency] ?? null;
    const sgdPrice = currency === 'SGD'
      ? effectiveAmount
      : rate && effectiveAmount !== null ? effectiveAmount * rate : null;

    results.push({ country, currency, rawPrice, amount, effectiveAmount, denoms, sgdPrice });
  }

  results.sort((a, b) => {
    if (a.sgdPrice === null && b.sgdPrice === null) return 0;
    if (a.sgdPrice === null) return 1;
    if (b.sgdPrice === null) return -1;
    return a.sgdPrice - b.sgdPrice;
  });

  const data = { gameName: title, rateSource, sgdRates, results };
  cache.set(gameUrl, { data, time: Date.now() });
  return data;
}

// ─── Web: SSE endpoint ────────────────────────────────────────────────────────

app.get('/api/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url || !/eshop-prices\.com\/games\/|dekudeals\.com\/items\//.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid eshop-prices.com or dekudeals.com URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (msg) => res.write(`data: ${JSON.stringify({ type: 'status', data: msg })}\n\n`);

  try {
    const result = await buildResults(url, emit);
    res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', data: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ─── Telegram bot ─────────────────────────────────────────────────────────────

function formatTelegramMessage(data) {
  const MEDAL = ['🥇', '🥈', '🥉'];
  const lines = [];
  lines.push(`🎮 *${escTg(data.gameName)}*\n`);

  let rank = 0;
  for (const r of data.results) {
    const hasPrice = r.sgdPrice !== null;
    if (hasPrice) rank++;

    const medal = hasPrice ? (MEDAL[rank - 1] || `\\#${rank}`) : '➖';
    const flag = COUNTRY_FLAG[r.country] || '';

    let gc;
    if (!r.rawPrice) gc = 'Not Available';
    else if (r.effectiveAmount === 0) gc = 'Free';
    else if (r.denoms) gc = `${r.currency} ${r.effectiveAmount.toLocaleString()}`;
    else gc = `${r.currency} ${r.effectiveAmount.toFixed(2)}`;

    const sgd = r.sgdPrice === 0 ? 'Free'
      : r.sgdPrice !== null ? escTg(`S$${r.sgdPrice.toFixed(2)}`)
      : 'Not Available';

    lines.push(`${medal} ${flag} *${escTg(r.country)}*`);
    if (r.rawPrice) {
      lines.push(`  Listed: ${escTg(r.rawPrice)}  →  Gift card: *${escTg(gc)}*  →  *${sgd}*`);
    } else {
      lines.push(`  Not Available`);
    }
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
  if (!token) {
    console.log('  Telegram bot disabled (no TELEGRAM_BOT_TOKEN).');
    return;
  }

  let TelegramBot;
  try {
    const pkg = require('node-telegram-bot-api');
    TelegramBot = pkg.default ?? pkg;
  } catch (e) {
    console.error('  node-telegram-bot-api not installed — bot disabled.');
    return;
  }

  const bot = new TelegramBot(token, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 10 } },
  });
  console.log('  Telegram bot active.');

  const ESHOP_URL_RE = /https?:\/\/(?:eshop-prices\.com\/games\/|(?:www\.)?dekudeals\.com\/items\/)[^\s]+/i;

  async function handleUrl(chatId, gameUrl, messageId) {
    const statusMsg = await bot.sendMessage(chatId,
      '🔍 Fetching prices\\.\\.\\. please wait\\.',
      { parse_mode: 'MarkdownV2', reply_to_message_id: messageId }
    );
    const logs = [];
    const emit = (msg) => { logs.push(msg); console.log('[bot]', msg); };
    try {
      const data = await buildResults(gameUrl, emit);
      await bot.sendMessage(chatId, formatTelegramMessage(data), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      const logText = logs.length ? `\n\nDebug:\n${logs.slice(-8).join('\n')}` : '';
      await bot.sendMessage(chatId, `❌ Error: ${err.message}${logText}`);
    }
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const match = text.match(ESHOP_URL_RE);
    if (match) {
      await handleUrl(chatId, match[0], msg.message_id);
    } else if (/^\/start|\/help/.test(text)) {
      await bot.sendMessage(chatId,
        '👋 Send me a game link and I\'ll show you the best prices in SGD\\.\n\n' +
        '*Supported sites:*\n' +
        '• eshop\\-prices\\.com/games/\\.\\.\\.\n' +
        '• dekudeals\\.com/items/\\.\\.\\.\n\n' +
        '*Example:*\n`https://eshop\\-prices\\.com/games/17496\\-cyberpunk\\-2077\\-ultimate\\-edition`\n' +
        '`https://www\\.dekudeals\\.com/items/the\\-witcher\\-3\\-wild\\-hunt`',
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
}

// ─── Start ────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:',  err?.message || err));

app.listen(PORT, () => {
  console.log(`\n  eShop Price Fetcher`);
  console.log(`  Web → http://localhost:${PORT}`);
  startTelegramBot();
  console.log('');
});
