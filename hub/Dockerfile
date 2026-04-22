# Multi-stage build: keep the final image small and native-module-friendly.

# ── Stage 1: build (full toolchain, dev deps, compile native bindings) ──
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Tools needed to compile better-sqlite3's native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Prune dev dependencies so we only ship what the runtime needs.
RUN pnpm install --frozen-lockfile --prod

# ── Stage 2: runtime (lean, no build tools) ──
FROM node:22-bookworm-slim AS runtime

# Run as non-root from the start.
RUN useradd --create-home --shell /bin/bash nexus
WORKDIR /app

# Copy only what runs.
COPY --from=builder --chown=nexus:nexus /app/node_modules ./node_modules
COPY --from=builder --chown=nexus:nexus /app/dist ./dist
COPY --from=builder --chown=nexus:nexus /app/package.json ./package.json

# Persistent data directory (mounted as a Fly.io volume in production).
RUN mkdir -p /data && chown nexus:nexus /data
ENV DB_PATH=/data/hub.db

USER nexus
EXPOSE 8787

# Minimal startup. Fastify handles graceful shutdown on SIGTERM itself.
CMD ["node", "dist/index.js"]
