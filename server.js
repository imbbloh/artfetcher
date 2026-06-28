#!/usr/bin/env node
const express = require('express');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');
const cheerio = require('cheerio');

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

// ─── Scraping: lightweight HTTP first, Playwright fallback ────────────────────

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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

    // Hide webdriver flag that Cloudflare detects
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    emit('Loading page...');
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // If Cloudflare challenge appears, wait for it to auto-resolve (up to 20s)
    const isChallenge = await page.title().then(t => t.includes('Just a moment'));
    if (isChallenge) {
      emit('Cloudflare check detected, waiting for it to pass...');
      await page.waitForFunction(
        () => !document.title.includes('Just a moment'),
        { timeout: 20000 }
      ).catch(() => {});
    }

    // Wait for price table
    await page.waitForSelector('table tr', { timeout: 15000 }).catch(() => {});

    const { title, rows } = await page.evaluate(() => {
      const tableRows = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((td) => td.innerText.trim());
        if (cells.length >= 2) tableRows.push(cells);
      });
      return { title: document.title.replace(/\s*[-|].*$/, '').trim(), rows: tableRows };
    });

    await browser.close();
    emit('Page loaded successfully.');
    return { title, rows };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function scrapeGamePrices(gameUrl, emit) {
  try {
    return await scrapeViaHttp(gameUrl, emit);
  } catch (httpErr) {
    emit(`HTTP scrape failed (${httpErr.message.slice(0, 60)}), switching to browser...`);
    return await scrapeViaBrowser(gameUrl, emit);
  }
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
  if (!url || !url.includes('eshop-prices.com')) {
    return res.status(400).json({ error: 'Please provide a valid eshop-prices.com URL' });
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
      : r.sgdPrice !== null ? `S\\$${r.sgdPrice.toFixed(2)}`
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

  const ESHOP_URL_RE = /https?:\/\/eshop-prices\.com\/games\/[^\s]+/i;

  async function handleUrl(chatId, gameUrl, messageId) {
    await bot.sendMessage(chatId,
      '🔍 Fetching prices\\.\\.\\. please wait\\.',
      { parse_mode: 'MarkdownV2', reply_to_message_id: messageId }
    );
    try {
      const data = await buildResults(gameUrl, () => {});
      await bot.sendMessage(chatId, formatTelegramMessage(data), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
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
        '👋 Send me any *eshop\\-prices\\.com* game link and I\'ll show you the best prices in SGD\\.\n\n' +
        'Example:\n`https://eshop\\-prices\\.com/games/17496\\-cyberpunk\\-2077\\-ultimate\\-edition`',
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
