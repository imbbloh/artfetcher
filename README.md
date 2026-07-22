# eShop Price Fetcher

Compare Nintendo eShop game prices worldwide — converted to SGD with gift card rounding. Available as a **web app** and **Telegram bot**.

---

## Deploy to Render (free, runs 24/7)

### Step 1 — Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts to name your bot
3. BotFather will give you a token like `123456:ABC-DEF1234...` — **copy it**

### Step 2 — Push to GitHub

Make sure your code is pushed to GitHub (it already is at `imbbloh/artfetcher`).

### Step 3 — Deploy on Render

1. Go to **https://render.com** and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub account and select the `artfetcher` repo
4. Render will auto-detect the Dockerfile — leave all settings as default
5. Under **Environment Variables**, add:
   ```
   TELEGRAM_BOT_TOKEN = your_token_from_BotFather
   ```
6. Click **Deploy**

Render will build the Docker image and start the server. After ~5 minutes you'll get a public URL like `https://artfetcher.onrender.com`.

### Step 4 — Use it

- **Web:** Open the Render URL in any browser on any device
- **Telegram:** Search for your bot by name and send it any eshop-prices.com link

---

## Run Locally

```bash
git clone https://github.com/imbbloh/artfetcher
cd artfetcher
npm install
TELEGRAM_BOT_TOKEN=your_token node server.js   # Mac/Linux
set TELEGRAM_BOT_TOKEN=your_token && node server.js   # Windows
```

Open **http://localhost:3000**. The Telegram bot will also be active.

If you don't have a bot token, just run `node server.js` — the web UI still works.

---

## Countries & Gift Card Denominations

| Country       | Currency | Gift Card Denominations |
|---------------|----------|-------------------------|
| United States | USD      | 5 / 10                  |
| Singapore     | SGD      | Exact price             |
| Hong Kong     | HKD      | Exact price             |
| Brazil        | BRL      | 30 / 50                 |
| Japan         | JPY      | 500 / 1,000             |
| Canada        | CAD      | 10 / 20 / 25            |
| Mexico        | MXN      | 100 / 200 / 350         |
| Australia     | AUD      | 15                      |
