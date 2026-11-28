# Teleharness — desktop web control room (with optional mobile PWA) for AI coding CLIs.
# Runs in instant demo mode by default (TELEHARNESS_DEMO=1).
# For self-hosted usage: set TELEHARNESS_DEMO=0, mount a persistent volume at /data,
# and optionally mount your project repositories at /workspace.
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
  && mkdir -p /data /workspace \
  && chown -R node:node /app /data /workspace

USER node

ENV NODE_ENV=production \
    PORT=4180 \
    TELEHARNESS_LISTEN_HOST=0.0.0.0 \
    TELEHARNESS_DATA_DIR=/data \
    TELEHARNESS_HOME=/workspace \
    TELEHARNESS_TENANT_HOME=/data/tenants \
    TELEHARNESS_TENANT_VAULT=/data/tenants-vault \
    TELEHARNESS_FILE_ROOTS=/workspace \
    TELEHARNESS_VOICE_PYTHON=/data/voice/venv/bin/python3 \
    TELEHARNESS_VOICE_MODELS=/data/voice/models \
    TELEHARNESS_DEMO=1

EXPOSE 4180
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4180) + '/teleharness/api/healthz').then((r) => (r.status === 200 || r.status === 503 ? r.json() : Promise.reject(r.status))).then((j) => process.exit(j && typeof j.version === 'string' ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "bin/teleharness.mjs"]
