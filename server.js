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

// null = exact price (no gift card rounding)
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findChromiumExecutable() {
  const fs = require('fs');

  // 1. Try playwright-core's managed download location
  try {
    const pw = require('playwright-core');
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  // 2. Explicit env override
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath) { try { if (fs.existsSync(envPath)) return envPath; } catch {} }

  // 3. Known static paths (cloud envs + local installs)
  const known = [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
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

// ─── Core pipeline ────────────────────────────────────────────────────────────

async function getExchangeRates(emit) {
  const currencies = Object.values(COUNTRY_CURRENCY).filter((c) => c !== 'SGD').join(',');

  // Primary: Google Finance (via browser)
  emit('Fetching live exchange rates from Google Finance...');
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
    for (const currency of currencies.split(',')) {
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
        if (rate) {
          rates[currency] = rate;
          emit(`Rate: 1 ${currency} = ${rate.toFixed(4)} SGD`);
        }
      } catch {}
    }
    await browser.close();
    if (Object.keys(rates).length > 1) return { rates, source: 'Google Finance (live)' };
  } catch {
    if (browser) await browser.close().catch(() => {});
  }

  // Fallback: frankfurter.app (ECB daily rates, no browser needed)
  emit('Falling back to frankfurter.app (ECB rates)...');
  const res = await axios.get(`https://api.frankfurter.app/latest?from=SGD&to=${currencies}`, { timeout: 10000 });
  const sgdRates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(res.data.rates)) {
    sgdRates[cur] = 1 / rate;
  }
  return { rates: sgdRates, source: 'frankfurter.app / ECB (daily)' };
}

async function scrapeGamePrices(gameUrl, emit) {
  emit('Launching browser to scrape prices...');
  const browser = await chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    emit('Loading game page...');
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

async function buildResults(gameUrl, emit) {
  const [rateResult, scrapeResult] = await Promise.all([
    getExchangeRates(emit),
    scrapeGamePrices(gameUrl, emit),
  ]);

  const { rates: sgdRates, source: rateSource } = rateResult;
  const { title, rows } = scrapeResult;

  emit('Processing results...');

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

  lines.push(`🎮 *${escTg(data.gameName)}*`);
  lines.push('');
  lines.push('`' + 'Rank  Country          Gift Card    SGD Cost' + '`');
  lines.push('`' + '─'.repeat(44) + '`');

  let rank = 0;
  for (const r of data.results) {
    const flag = COUNTRY_FLAG[r.country] || '';
    const hasPrice = r.sgdPrice !== null;
    if (hasPrice) rank++;

    const rankStr = hasPrice
      ? (MEDAL[rank - 1] || `#${rank} `)
      : '➖  ';

    const country = r.country.padEnd(16);

    let gc;
    if (!r.rawPrice) gc = 'N/A';
    else if (r.effectiveAmount === 0) gc = 'Free';
    else if (r.denoms) gc = `${r.currency} ${r.effectiveAmount.toLocaleString()}`;
    else gc = `${r.currency} exact`;

    const sgd = r.sgdPrice === 0
      ? 'Free'
      : r.sgdPrice !== null
      ? `S$${r.sgdPrice.toFixed(2)}`
      : 'N/A';

    lines.push(`${rankStr} ${flag} ${escTg(r.country)}`);
    lines.push(`     Listed: ${escTg(r.rawPrice || 'Not Available')}  →  Gift card: *${escTg(gc)}*  →  *${escTg(sgd)}*`);
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
    console.log('  No TELEGRAM_BOT_TOKEN set — Telegram bot disabled.');
    return;
  }

  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(token, { polling: true });

  console.log('  Telegram bot started.');

  const ESHOP_URL_RE = /https?:\/\/eshop-prices\.com\/games\/[^\s]+/i;

  async function handleUrl(chatId, gameUrl, messageId) {
    await bot.sendMessage(chatId, '🔍 Fetching prices\\.\\.\\. this takes about 30–60 seconds\\.', {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: messageId,
    });

    try {
      const data = await buildResults(gameUrl, (msg) => {
        // silently discard status updates in Telegram (no streaming)
      });
      const text = formatTelegramMessage(data);
      await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
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
    } else if (text === '/start' || text === '/help') {
      await bot.sendMessage(chatId,
        '👋 Send me any *eshop\\-prices\\.com* game link and I\'ll show you the best prices in SGD\\.\n\n' +
        'Example:\n`https://eshop-prices\\.com/games/17496-cyberpunk-2077-ultimate-edition`',
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  eShop Price Fetcher`);
  console.log(`  Web UI → http://localhost:${PORT}`);
  startTelegramBot();
  console.log('');
});
