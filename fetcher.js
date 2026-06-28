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
  'Australia',
];

const COUNTRY_CURRENCY = {
  'United States': 'USD',
  'Singapore': 'SGD',
  'Hong Kong': 'HKD',
  'Brazil': 'BRL',
  'Japan': 'JPY',
  'Canada': 'CAD',
  'Mexico': 'MXN',
  'Australia': 'AUD',
};

// Gift card denominations per currency.
// null = use exact price (no gift card rounding).
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

/**
 * Find the minimum total gift card spend (using available denominations,
 * unlimited quantity of each) that is >= price.
 * Returns null if no combination can reach the price (shouldn't happen in practice).
 */
function minGiftCardAmount(price, denoms) {
  if (!denoms || denoms.length === 0) return price;

  const target = Math.ceil(price); // gift card amounts are whole numbers
  const maxSearch = target + Math.max(...denoms) * 2;
  // dp[i] = true if value i is reachable as a sum of the given denominations
  const reachable = new Uint8Array(maxSearch + 1);
  reachable[0] = 1;

  for (let i = 1; i <= maxSearch; i++) {
    for (const d of denoms) {
      if (d <= i && reachable[i - d]) {
        reachable[i] = 1;
        break;
      }
    }
  }

  for (let i = target; i <= maxSearch; i++) {
    if (reachable[i]) return i;
  }
  return null;
}

async function getGoogleExchangeRates() {
  const currencies = Object.values(COUNTRY_CURRENCY).filter((c) => c !== 'SGD');
  const rates = { SGD: 1 };

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

        if (rate) rates[currency] = rate;
      } catch {
        // skip
      }
    }
  } finally {
    await browser.close();
  }

  return rates;
}

async function getFrankfurterRates() {
  const currencies = Object.values(COUNTRY_CURRENCY)
    .filter((c) => c !== 'SGD')
    .join(',');
  const res = await axios.get(`https://api.frankfurter.app/latest?from=SGD&to=${currencies}`, {
    timeout: 10000,
  });
  const ratesPerSGD = res.data.rates;

  const sgdRates = { SGD: 1 };
  for (const [cur, rate] of Object.entries(ratesPerSGD)) {
    sgdRates[cur] = 1 / rate;
  }
  return sgdRates;
}

function findChromiumExecutable() {
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
    await page.waitForSelector('table, [class*="price"], [class*="country"]', { timeout: 10000 }).catch(() => {});

    const { title, rows } = await page.evaluate(() => {
      const title = document.title;
      const tableRows = [];

      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((td) => td.innerText.trim());
        if (cells.length >= 2) tableRows.push(cells);
      });

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
  let cleaned = priceText
    .replace(/[^\d,. ]/g, ' ')
    .trim()
    .split(/\s+/)[0];

  if (/\d{1,3}\.\d{3},\d{2}/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/\d+,\d{2}$/.test(cleaned)) {
    cleaned = cleaned.replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function matchTargetCountry(cellText) {
  const lower = cellText.toLowerCase().trim();
  for (const target of TARGET_COUNTRIES) {
    if (lower.includes(target.toLowerCase()) || target.toLowerCase().includes(lower)) {
      return target;
    }
  }
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
      console.log('\nWarning: Could not fetch exchange rates.');
      sgdRates = { SGD: 1 };
      rateSource = 'None (offline)';
    }
  }

  console.log('Scraping game prices...');
  const { title, rows } = await scrapeGamePrices(gameUrl);

  const gameName = title.replace(/\s*[-|].*$/, '').trim();
  console.log(`\nGame: ${gameName}`);
  console.log(`Exchange rate source: ${rateSource}\n`);

  // Build price map
  const priceMap = {};
  for (const row of rows) {
    if (row.length < 2) continue;
    const matched = matchTargetCountry(row[0]);
    if (!matched || priceMap[matched]) continue;

    for (let i = 1; i < row.length; i++) {
      const cell = row[i];
      const hasNumber = /\d/.test(cell);
      const hasCurrencyHint = /[$¥€£R]|USD|SGD|HKD|BRL|JPY|CAD|MXN|AUD|Free/i.test(cell);
      if (hasNumber && hasCurrencyHint) {
        priceMap[matched] = cell.trim();
        break;
      } else if (hasNumber && i === 1) {
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
    const denoms = GIFT_CARD_DENOMS[currency];

    if (!rawPrice || rawPrice.toLowerCase().includes('not') || rawPrice === '-') {
      results.push({ country, rawPrice: null, effectiveAmount: null, sgdPrice: null, currency, denoms });
      continue;
    }

    if (rawPrice.toLowerCase() === 'free') {
      results.push({ country, rawPrice: 'Free', effectiveAmount: 0, sgdPrice: 0, currency, denoms });
      continue;
    }

    const amount = parsePrice(rawPrice);
    if (amount === null) {
      results.push({ country, rawPrice, effectiveAmount: null, sgdPrice: null, currency, denoms });
      continue;
    }

    // Apply gift card rounding
    const effectiveAmount = denoms ? minGiftCardAmount(amount, denoms) : amount;

    const rate = sgdRates[currency] ?? null;
    const sgdPrice = currency === 'SGD'
      ? effectiveAmount
      : rate && effectiveAmount !== null
      ? effectiveAmount * rate
      : null;

    results.push({ country, rawPrice, amount, effectiveAmount, currency, denoms, sgdPrice });
  }

  // Sort cheapest → most expensive (not available last)
  results.sort((a, b) => {
    if (a.sgdPrice === null && b.sgdPrice === null) return 0;
    if (a.sgdPrice === null) return 1;
    if (b.sgdPrice === null) return -1;
    return a.sgdPrice - b.sgdPrice;
  });

  // Display
  const W = 85;
  const SEP = '─'.repeat(W);
  console.log(SEP);
  console.log(
    ' ' +
    'Rank'.padEnd(6) +
    'Country'.padEnd(16) +
    'Listed Price'.padEnd(18) +
    'Gift Card Spend'.padEnd(22) +
    'Cost in SGD'
  );
  console.log(SEP);

  let rank = 1;
  for (const r of results) {
    const rankStr = r.sgdPrice !== null ? `#${rank++}` : '-';
    const listed = r.rawPrice ?? 'Not Available';

    let giftCard;
    if (r.effectiveAmount === null || r.rawPrice === null) {
      giftCard = r.rawPrice === null ? 'Not Available' : listed;
    } else if (r.effectiveAmount === 0) {
      giftCard = 'Free';
    } else if (r.denoms) {
      giftCard = `${r.currency} ${r.effectiveAmount.toLocaleString()}`;
    } else {
      giftCard = `${r.currency} ${r.effectiveAmount.toFixed(2)} (exact)`;
    }

    const sgd =
      r.sgdPrice === 0
        ? 'Free'
        : r.sgdPrice !== null
        ? `SGD $${r.sgdPrice.toFixed(2)}`
        : 'Not Available';

    console.log(
      ' ' +
      rankStr.padEnd(6) +
      r.country.padEnd(16) +
      listed.padEnd(18) +
      giftCard.padEnd(22) +
      sgd
    );
  }

  console.log(SEP);

  // Gift card denomination legend
  console.log('\n  Gift card denominations used:');
  for (const country of TARGET_COUNTRIES) {
    const c = COUNTRY_CURRENCY[country];
    const d = GIFT_CARD_DENOMS[c];
    if (d) {
      console.log(`    ${country} (${c}): ${d.join(' / ')}`);
    } else {
      console.log(`    ${country} (${c}): exact price`);
    }
  }

  console.log('\n  Exchange rates (→ SGD):');
  for (const country of TARGET_COUNTRIES) {
    const c = COUNTRY_CURRENCY[country];
    if (c === 'SGD') continue;
    const rate = sgdRates[c];
    if (rate) console.log(`    1 ${c} = ${rate.toFixed(4)} SGD`);
  }
  console.log(`\n  Rate source: ${rateSource}\n`);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
