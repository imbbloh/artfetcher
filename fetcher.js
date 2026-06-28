#!/usr/bin/env node
/**
 * eshop-prices.com price fetcher
 * Usage: node fetcher.js <eshop-prices.com game URL>
 * Example: node fetcher.js https://eshop-prices.com/games/17496-cyberpunk-2077-ultimate-edition
 */

const { chromium } = require('playwright-core');
const axios = require('axios');

const TARGET_COUNTRIES = [
  'United States',
  'Singapore',
  'Hong Kong',
  'Brazil',
  'Japan',
  'Canada',
  'Mexico',
];

const COUNTRY_CURRENCY = {
  'United States': 'USD',
  'Singapore': 'SGD',
  'Hong Kong': 'HKD',
  'Brazil': 'BRL',
  'Japan': 'JPY',
  'Canada': 'CAD',
  'Mexico': 'MXN',
};

// Currency symbols/patterns to detect
const CURRENCY_SYMBOLS = {
  'USD': /US\$|USD/i,
  'SGD': /S\$|SGD/i,
  'HKD': /HK\$|HKD/i,
  'BRL': /R\$|BRL/i,
  'JPY': /¥|JP¥|JPY/i,
  'CAD': /CA\$|CAD/i,
  'MXN': /MX\$|MXN/i,
  'GBP': /£|GBP/i,
  'EUR': /€|EUR/i,
  'AUD': /A\$|AUD/i,
};

async function getGoogleExchangeRates() {
  // Fetch live rates from Google Finance via scraping pairs to SGD
  const currencies = Object.values(COUNTRY_CURRENCY).filter((c) => c !== 'SGD');
  const rates = { SGD: 1 }; // base

  // Use Google Finance currency conversion URLs
  const pairs = currencies.map((c) => `${c}SGD`);

  // Fetch all pairs via Google Finance (scraped via Playwright)
  const browser = await chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    for (const currency of currencies) {
      try {
        const url = `https://www.google.com/finance/quote/${currency}-SGD`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const rate = await page.evaluate(() => {
          // Google Finance rate element
          const el =
            document.querySelector('[data-last-price]') ||
            document.querySelector('.IsqQVc') ||
            document.querySelector('[jsname="ip75Cb"]') ||
            document.querySelector('.YMlKec.fxKbKc');
          if (el) {
            const text = el.getAttribute('data-last-price') || el.innerText;
            const num = parseFloat(text.replace(/,/g, ''));
            return isNaN(num) ? null : num;
          }
          return null;
        });

        if (rate) {
          rates[currency] = rate; // rate = how many SGD per 1 unit of currency
        }
      } catch {
        // skip this currency if it fails
      }
    }
  } finally {
    await browser.close();
  }

  return rates;
}

async function getFrankfurterRates() {
  // Fallback: frankfurter.app (ECB rates, free, no API key)
  // Returns rates per 1 SGD
  const res = await axios.get('https://api.frankfurter.app/latest?from=SGD&to=USD,HKD,BRL,JPY,CAD,MXN', {
    timeout: 10000,
  });
  const ratesPerSGD = res.data.rates; // e.g. { USD: 0.74, HKD: 5.79, ... }

  // Convert to "how many SGD per 1 unit of foreign currency"
  const sgdRates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(ratesPerSGD)) {
    sgdRates[cur] = 1 / rate; // SGD per 1 foreign unit
  }
  return sgdRates;
}

function findChromiumExecutable() {
  // Support both local playwright install and pre-installed cloud env
  const fs = require('fs');
  const paths = [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // Let playwright find its own
  return undefined;
}

async function scrapeGamePrices(gameUrl) {
  const browser = await chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    await page.goto(gameUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for price table
    await page.waitForSelector('table, [class*="price"], [class*="country"]', { timeout: 10000 }).catch(() => {});

    const { title, rows } = await page.evaluate(() => {
      const title = document.title;
      const tableRows = [];

      // Primary: table rows
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((td) => td.innerText.trim());
        if (cells.length >= 2) tableRows.push(cells);
      });

      // Secondary: definition list or div-based layout
      if (!tableRows.length) {
        document.querySelectorAll('[class*="country-row"], [class*="price-row"], .row').forEach((row) => {
          const texts = [...row.querySelectorAll('*')]
            .filter((el) => el.children.length === 0 && el.innerText.trim())
            .map((el) => el.innerText.trim());
          if (texts.length >= 2) tableRows.push(texts);
        });
      }

      return { title, rows: tableRows };
    });

    await browser.close();
    return { title, rows };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

function parsePrice(priceText) {
  // Remove currency symbols and thousand separators, handle comma decimals
  let cleaned = priceText
    .replace(/[^\d,. ]/g, ' ')
    .trim()
    .split(/\s+/)[0]; // take the first number-like chunk

  // Handle European format (e.g. 1.299,00 → 1299.00)
  if (/\d{1,3}\.\d{3},\d{2}/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/\d+,\d{2}$/.test(cleaned)) {
    // BRL format: 299,00
    cleaned = cleaned.replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function detectCurrency(text) {
  for (const [code, pattern] of Object.entries(CURRENCY_SYMBOLS)) {
    if (pattern.test(text)) return code;
  }
  return null;
}

function matchTargetCountry(cellText) {
  const lower = cellText.toLowerCase().trim();
  for (const target of TARGET_COUNTRIES) {
    if (lower.includes(target.toLowerCase()) || target.toLowerCase().includes(lower)) {
      return target;
    }
  }
  // Partial: first word match
  const firstWord = lower.split(/[\s,]/)[0];
  for (const target of TARGET_COUNTRIES) {
    if (target.toLowerCase().startsWith(firstWord) && firstWord.length >= 4) {
      return target;
    }
  }
  return null;
}

async function main() {
  const gameUrl = process.argv[2];
  if (!gameUrl) {
    console.error('\nUsage: node fetcher.js <eshop-prices.com game URL>');
    console.error('Example: node fetcher.js https://eshop-prices.com/games/17496-cyberpunk-2077-ultimate-edition\n');
    process.exit(1);
  }

  console.log(`\nFetching prices from: ${gameUrl}`);
  process.stdout.write('Getting live exchange rates from Google Finance... ');

  // Get exchange rates and scrape prices in parallel (rates via Google, prices via Playwright)
  let sgdRates;
  let rateSource;
  try {
    sgdRates = await getGoogleExchangeRates();
    rateSource = 'Google Finance (live)';
    console.log('Done');
  } catch (e) {
    process.stdout.write('\nGoogle Finance failed, trying frankfurter.app... ');
    try {
      sgdRates = await getFrankfurterRates();
      rateSource = 'frankfurter.app / ECB';
      console.log('Done');
    } catch (e2) {
      console.log('\nWarning: Could not fetch exchange rates. Prices will show in original currency only.');
      sgdRates = { SGD: 1 };
      rateSource = 'None (offline)';
    }
  }

  console.log(`Scraping game prices...`);
  const { title, rows } = await scrapeGamePrices(gameUrl);

  const gameName = title.replace(/\s*[-|].*$/, '').trim();
  console.log(`\nGame: ${gameName}`);
  console.log(`Exchange rate source: ${rateSource}\n`);

  // Build price map from scraped rows
  const priceMap = {};

  for (const row of rows) {
    if (row.length < 2) continue;

    const countryCell = row[0];
    const matched = matchTargetCountry(countryCell);
    if (!matched) continue;
    if (priceMap[matched]) continue; // already found

    // Find price cell: first cell after country that has a number and looks like a price
    for (let i = 1; i < row.length; i++) {
      const cell = row[i];
      const hasNumber = /\d/.test(cell);
      const hasCurrencyHint = /[$¥€£R]|USD|SGD|HKD|BRL|JPY|CAD|MXN|Free/i.test(cell);
      if (hasNumber && hasCurrencyHint) {
        priceMap[matched] = cell.trim();
        break;
      } else if (hasNumber && i === 1) {
        // Sometimes price is just a number in second column
        priceMap[matched] = cell.trim();
        break;
      }
    }
  }

  // Build results
  const results = [];
  for (const country of TARGET_COUNTRIES) {
    const rawPrice = priceMap[country];
    const currency = COUNTRY_CURRENCY[country];

    if (!rawPrice || rawPrice.toLowerCase().includes('not') || rawPrice === '-') {
      results.push({ country, rawPrice: null, sgdPrice: null, currency });
      continue;
    }

    if (rawPrice.toLowerCase() === 'free') {
      results.push({ country, rawPrice: 'Free', sgdPrice: 0, currency });
      continue;
    }

    const amount = parsePrice(rawPrice);
    if (amount === null) {
      results.push({ country, rawPrice, sgdPrice: null, currency });
      continue;
    }

    const rate = sgdRates[currency] ?? null;
    const sgdPrice = currency === 'SGD' ? amount : rate ? amount * rate : null;

    results.push({ country, rawPrice, amount, currency, sgdPrice });
  }

  // Sort cheapest first (not available at end)
  results.sort((a, b) => {
    if (a.sgdPrice === null && b.sgdPrice === null) return 0;
    if (a.sgdPrice === null) return 1;
    if (b.sgdPrice === null) return -1;
    return a.sgdPrice - b.sgdPrice;
  });

  // Display table
  const SEP = '─'.repeat(70);
  console.log(SEP);
  console.log(
    ' ' +
    'Rank'.padEnd(7) +
    'Country'.padEnd(20) +
    'Original Price'.padEnd(22) +
    'Price (SGD)'
  );
  console.log(SEP);

  let rank = 1;
  for (const r of results) {
    const rankStr = r.sgdPrice !== null ? `#${rank++}` : '-';
    const original = r.rawPrice ?? 'Not Available';
    const sgd =
      r.sgdPrice === 0
        ? 'Free'
        : r.sgdPrice !== null
        ? `SGD $${r.sgdPrice.toFixed(2)}`
        : 'Not Available';

    console.log(
      ' ' +
      rankStr.padEnd(7) +
      r.country.padEnd(20) +
      original.padEnd(22) +
      sgd
    );
  }

  console.log(SEP);
  console.log(`\n  Exchange rates: 1 unit of each currency → SGD`);
  for (const country of TARGET_COUNTRIES) {
    const c = COUNTRY_CURRENCY[country];
    if (c === 'SGD') continue;
    const rate = sgdRates[c];
    if (rate) console.log(`    ${c}: ${rate.toFixed(4)} SGD`);
  }
  console.log(`\n  Source: ${rateSource}\n`);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
