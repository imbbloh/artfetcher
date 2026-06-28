# eShop Price Fetcher

Compare Nintendo eShop game prices worldwide, converted to **SGD (Singapore Dollars)** using live Google Finance exchange rates. Accounts for gift card denominations so you see the real spend.

## Quick Start

```bash
git clone https://github.com/imbbloh/artfetcher
cd artfetcher
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

Paste any [eshop-prices.com](https://eshop-prices.com) game link and hit **Fetch Prices**.

## What it does

1. Scrapes the game's eShop price listing using a headless browser
2. Fetches live exchange rates from **Google Finance** (falls back to frankfurter.app / ECB)
3. Rounds each price **up** to the minimum gift card combination needed to cover it
4. Displays all countries ranked cheapest → most expensive in SGD

## Countries & Gift Card Denominations

| Country       | Currency | Gift Card Denominations    |
|---------------|----------|----------------------------|
| United States | USD      | 5 / 10                     |
| Singapore     | SGD      | Exact price                |
| Hong Kong     | HKD      | Exact price                |
| Brazil        | BRL      | 30 / 50                    |
| Japan         | JPY      | 500 / 1,000                |
| Canada        | CAD      | 10 / 20 / 25               |
| Mexico        | MXN      | 100 / 200 / 350            |
| Australia     | AUD      | 15                         |

## CLI Usage

You can also run it as a command-line tool:

```bash
node fetcher.js https://eshop-prices.com/games/17496-cyberpunk-2077-ultimate-edition
```

## Requirements

- Node.js 18+
- Google Chrome installed locally (the scraper uses your installed browser)
