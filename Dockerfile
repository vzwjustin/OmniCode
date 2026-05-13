FROM node:24.15.0-trixie-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY scripts/postinstallSupport.mjs ./scripts/postinstallSupport.mjs
COPY scripts/native-binary-compat.mjs ./scripts/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
RUN if [ -f package-lock.json ]; then \
    npm ci --no-audit --no-fund --legacy-peer-deps; \
    else \
    npm install --no-audit --no-fund --legacy-peer-deps; \
    fi

COPY . ./
RUN mkdir -p /app/data && npm run build -- --webpack

FROM node:24.15.0-trixie-slim AS runner-base
WORKDIR /app

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://omniroute.online" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
# Containerized deployments are expected to bind on all interfaces (Docker networking
# routes external traffic in via the published port); explicitly opt-in to the LAN
# bind so run-next.mjs/run-standalone.mjs do not silently revert to 127.0.0.1.
ENV OMNIROUTE_BIND_LAN=true
ENV NODE_OPTIONS="--max-old-space-size=256"

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
# HOME=/app so that any code resolving "~/.omniroute" lands inside the image
# (and inside the chown'd /app tree below) instead of a non-writable default.
ENV HOME=/app
RUN apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data /app/.omniroute

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
# Explicitly copy @swc/helpers — not always traced by standalone output but needed at runtime
COPY --from=builder /app/node_modules/@swc/helpers ./node_modules/@swc/helpers
# Explicitly copy pino transport dependencies — pino spawns a worker that requires
# pino-abstract-transport at runtime; Next.js standalone trace does not capture it (#449)
COPY --from=builder /app/node_modules/pino-abstract-transport ./node_modules/pino-abstract-transport
COPY --from=builder /app/node_modules/pino-pretty ./node_modules/pino-pretty
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
# Migration SQL files are read via fs.readFileSync at runtime and are NOT
# traced by Next.js standalone output — copy them explicitly.
COPY --from=builder /app/src/lib/db/migrations ./migrations
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations
# MITM server.cjs is spawned at runtime via child_process — not traced by nft
COPY --from=builder /app/src/mitm/server.cjs ./src/mitm/server.cjs
# OpenAPI spec is read from disk by /api/openapi/spec at runtime for the
# Endpoints dashboard. Next.js standalone tracing does not include it.
COPY --from=builder /app/docs/openapi.yaml ./docs/openapi.yaml

COPY --from=builder /app/scripts/run-standalone.mjs ./run-standalone.mjs
COPY --from=builder /app/scripts/runtime-env.mjs ./runtime-env.mjs
COPY --from=builder /app/scripts/bootstrap-env.mjs ./bootstrap-env.mjs
COPY --from=builder /app/scripts/healthcheck.mjs ./healthcheck.mjs

# Run the service as a dedicated non-root user. Done after all COPYs so the
# chown picks up every file placed in /app. /app/data is the runtime DATA_DIR
# and /app/.omniroute resolves "~/.omniroute" for anything still using HOME.
RUN groupadd -r omniroute && useradd -r -g omniroute omniroute \
  && chown -R omniroute:omniroute /app
USER omniroute

EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "run-standalone.mjs"]

FROM runner-base AS runner-cli

# runner-base switches to USER omniroute, but the CLI stage needs root to install
# system packages (apt-get) and global npm packages. We also intentionally KEEP
# the runner-cli container running as root at runtime so docker-in-docker
# (docker.io / docker-compose installed below) works inside the container —
# the docker CLI normally requires either root or membership in the host's
# docker group, and we cannot reliably enumerate that GID at image build time.
USER root

# Install system dependencies required by openclaw (git+ssh references).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install CLI tools globally. Separate layer from apt for better cache reuse.
RUN npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest
