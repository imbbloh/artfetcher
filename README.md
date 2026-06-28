# ArtFetcher — eShop Price Fetcher

Scrapes game prices from [eshop-prices.com](https://eshop-prices.com) and converts them to **SGD (Singapore Dollars)** using live Google Finance exchange rates, ranked cheapest to most expensive.

## Requirements

- Node.js 18+
- Google Chrome / Chromium installed (or use the pre-installed cloud env path)

## Setup

```bash
npm install
```

## Usage

```bash
node fetcher.js <eshop-prices.com game URL>
```

**Example:**

```bash
node fetcher.js https://eshop-prices.com/games/17496-cyberpunk-2077-ultimate-edition
```

## Sample Output

```
Game: Cyberpunk 2077: Ultimate Edition
Exchange rate source: Google Finance (live)

──────────────────────────────────────────────────────────────────────
 Rank   Country             Original Price        Price (SGD)
──────────────────────────────────────────────────────────────────────
 #1     Mexico              MX$1,109.00           SGD $82.14
 #2     Brazil              R$349.90              SGD $87.23
 #3     Hong Kong           HK$629.00             SGD $109.72
 #4     Japan               ¥9,878                SGD $114.56
 #5     United States       US$59.99              SGD $80.99
 #6     Canada              CA$79.99              SGD $88.23
 #7     Singapore           S$98.00               SGD $98.00
──────────────────────────────────────────────────────────────────────
```

## Countries Tracked

| Country       | Currency |
|---------------|----------|
| United States | USD      |
| Singapore     | SGD      |
| Hong Kong     | HKD      |
| Brazil        | BRL      |
| Japan         | JPY      |
| Canada        | CAD      |
| Mexico        | MXN      |

## Exchange Rates

Live rates are fetched from **Google Finance** on each run. If Google Finance is unavailable, it falls back to [frankfurter.app](https://www.frankfurter.app) (ECB rates).
