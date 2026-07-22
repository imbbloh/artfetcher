FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Install Chromium + all its system dependencies via playwright's own installer
# --with-deps handles the apt packages automatically for the current distro
RUN npx playwright install --with-deps chromium

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
