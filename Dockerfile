FROM node:18-bullseye-slim

ENV NODE_ENV=production \
    TZ=America/Bogota \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Instalar Chromium y librerías requeridas por whatsapp-web.js / Puppeteer + herramientas de backup
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    git \
    mariadb-client \
    openssl \
    tzdata \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias y aplicar parches de whatsapp-web.js
COPY package*.json patch_wwebjs.js ./
COPY patches ./patches
RUN npm ci --omit=dev || npm install --omit=dev

# Copiar código fuente
COPY . .

RUN mkdir -p /app/wwebjs_auth /app/uploads /app/tokens /app/logs /app/backups

EXPOSE 3000

CMD ["node", "index.js"]
