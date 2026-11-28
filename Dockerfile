# Teleharness — desktop web control room (with optional mobile PWA) for AI coding CLIs.
# Runs in instant demo mode by default (TELEHARNESS_DEMO=1); set TELEHARNESS_DEMO=0
# and mount /home/node/.teleharness for self-hosted usage.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY config ./config
COPY fixtures-demo ./fixtures-demo
COPY lib ./lib
COPY ops ./ops
COPY public ./public
COPY routes ./routes
COPY scripts/demo.mjs ./scripts/demo.mjs
COPY shared ./shared
COPY src ./src
COPY build.mjs server.js .env.example LICENSE README.md SECURITY.md ./

RUN npm run build \
  && mkdir -p /home/node/.teleharness \
  && chown -R node:node /app /home/node/.teleharness

USER node

ENV NODE_ENV=production \
    PORT=4180 \
    TELEHARNESS_LISTEN_HOST=0.0.0.0 \
    TELEHARNESS_HOME=/home/node/.teleharness \
    TELEHARNESS_DEMO=1

EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4180) + '/teleharness/api/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "bin/teleharness.mjs"]
