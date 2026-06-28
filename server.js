#!/usr/bin/env node
const express = require('express');
const path = require('path');
const { chromium } = require('playwright-core');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const TARGET_COUNTRIES = [
  'United States',
  'Singapore',
  'Hong Kong',
  'Brazil',
  'Japan',
  'Canada',
  'Mexico',
  'Australia',
];

const COUNTRY_CURRENCY = {
  'United States': 'USD',
  'Singapore':     'SGD',
  'Hong Kong':     'HKD',
  'Brazil':        'BRL',
  'Japan':         'JPY',
  'Canada':        'CAD',
  'Mexico':        'MXN',
  'Australia':     'AUD',
};

const COUNTRY_FLAG = {
  'United States': '🇺🇸',
  'Singapore':     '🇸🇬',
  'Hong Kong':     '🇭🇰',
  'Brazil':        '🇧🇷',
  'Japan':         '🇯🇵',
  'Canada':        '🇨🇦',
  'Mexico':        '🇲🇽',
  'Australia':     '🇦🇺',
};

// null = exact price (HKD, SGD)
const GIFT_CARD_DENOMS = {
  USD: [5, 10],
  SGD: null,
  HKD: null,
  BRL: [30, 50],
  JPY: [500, 1000],
  CAD: [10, 20, 25],
  MXN: [100, 200, 350],
  AUD: [15],
};

const CURRENCY_SYMBOLS = {
  USD: /US\$|USD/i,
  SGD: /S\$|SGD/i,
  HKD: /HK\$|HKD/i,
  BRL: /R\$|BRL/i,
  JPY: /¥|JP¥|JPY/i,
  CAD: /CA\$|CAD/i,
  MXN: /MX\$|MXN/i,
  GBP: /£|GBP/i,
  EUR: /€|EUR/i,
  AUD: /A\$|AUD/i,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findChromiumExecutable() {
  const fs = require('fs');
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    // Common local Chrome paths
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined; // let playwright-core find it
}

function minGiftCardAmount(price, denoms) {
  if (!denoms || denoms.length === 0) return price;
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

function matchCountry(cellText) {
  const lower = cellText.toLowerCase().trim();
  for (const t of TARGET_COUNTRIES) {
    if (lower.includes(t.toLowerCase()) || t.toLowerCase().includes(lower)) return t;
  }
  const word = lower.split(/[\s,]/)[0];
  for (const t of TARGET_COUNTRIES) {
    if (t.toLowerCase().startsWith(word) && word.length >= 4) return t;
  }
  return null;
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeGamePrices(gameUrl, emit) {
  emit('status', 'Launching browser...');
  const browser = await chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    emit('status', 'Loading game page...');
    await page.goto(gameUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('table, [class*="price"], [class*="country"]', { timeout: 10000 }).catch(() => {});

    const { title, rows } = await page.evaluate(() => {
      const tableRows = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((td) => td.innerText.trim());
        if (cells.length >= 2) tableRows.push(cells);
      });
      if (!tableRows.length) {
        document.querySelectorAll('[class*="country-row"],[class*="price-row"],.row').forEach((row) => {
          const texts = [...row.querySelectorAll('*')]
            .filter((el) => el.children.length === 0 && el.innerText.trim())
            .map((el) => el.innerText.trim());
          if (texts.length >= 2) tableRows.push(texts);
        });
      }
      return { title: document.title, rows: tableRows };
    });

    await browser.close();
    return { title, rows };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function getExchangeRates(emit) {
  const currencies = Object.values(COUNTRY_CURRENCY).filter((c) => c !== 'SGD');

  // Try Google Finance first
  emit('status', 'Fetching live exchange rates from Google Finance...');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: findChromiumExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const rates = { SGD: 1 };
    for (const currency of currencies) {
      try {
        await page.goto(`https://www.google.com/finance/quote/${currency}-SGD`, {
          waitUntil: 'domcontentloaded', timeout: 12000,
        });
        const rate = await page.evaluate(() => {
          const el =
            document.querySelector('[data-last-price]') ||
            document.querySelector('.IsqQVc') ||
            document.querySelector('[jsname="ip75Cb"]') ||
            document.querySelector('.YMlKec.fxKbKc');
          if (!el) return null;
          const text = el.getAttribute('data-last-price') || el.innerText;
          const n = parseFloat(text.replace(/,/g, ''));
          return isNaN(n) ? null : n;
        });
        if (rate) rates[currency] = rate;
        emit('status', `Got rate: 1 ${currency} = ${rate ? rate.toFixed(4) : '?'} SGD`);
      } catch { /* skip */ }
    }
    await browser.close();
    if (Object.keys(rates).length > 1) return { rates, source: 'Google Finance (live)' };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
  }

  // Fallback: frankfurter.app
  emit('status', 'Google Finance unavailable, trying frankfurter.app (ECB rates)...');
  const currencyList = currencies.join(',');
  const res = await axios.get(`https://api.frankfurter.app/latest?from=SGD&to=${currencyList}`, { timeout: 10000 });
  const sgdRates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(res.data.rates)) {
    sgdRates[cur] = 1 / rate;
  }
  return { rates: sgdRates, source: 'frankfurter.app / ECB' };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function fetchPrices(gameUrl, emit) {
  // Run both in parallel
  const [rateResult, scrapeResult] = await Promise.all([
    getExchangeRates(emit),
    scrapeGamePrices(gameUrl, emit),
  ]);

  const { rates: sgdRates, source: rateSource } = rateResult;
  const { title, rows } = scrapeResult;

  emit('status', 'Processing results...');

  // Build price map
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

  // Build results
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

  return {
    gameName: title.replace(/\s*[-|].*$/, '').trim(),
    rateSource,
    sgdRates,
    results,
  };
}

// ─── SSE Route ────────────────────────────────────────────────────────────────

app.get('/api/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('eshop-prices.com')) {
    return res.status(400).json({ error: 'Please provide a valid eshop-prices.com URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  try {
    const result = await fetchPrices(url, emit);
    emit('result', result);
  } catch (err) {
    emit('error', err.message);
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  eShop Price Fetcher running at http://localhost:${PORT}\n`);
});
