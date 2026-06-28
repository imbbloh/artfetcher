FROM node:20-slim

# System dependencies required by Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    libpangocairo-1.0-0 libcairo2 libatspi2.0-0 libx11-6 libxcb1 \
    libxext6 fonts-liberation wget ca-certificates \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Download Chromium browser managed by playwright-core
RUN npx playwright install chromium

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
