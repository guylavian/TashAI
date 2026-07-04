# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── Runtime: Node (relay) + Python (parsers for /parse and /remote) ──────────
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY client ./client
# Venv at client/.venv so the relay's default PARSER_PYTHON path works unchanged.
RUN python3 -m venv client/.venv \
    && client/.venv/bin/pip install --no-cache-dir -r client/requirements.txt
# OpenShift restricted-v2 friendly: arbitrary UID, group 0 owns the tree.
RUN chgrp -R 0 /app && chmod -R g=u /app
USER 1001
EXPOSE 3100
CMD ["node", "dist/index.js"]
