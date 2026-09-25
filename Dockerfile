# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# DUMBscope — one container, one /config volume, zero external services.
# The adapter-node build output is fully self-contained, so the runtime image
# ships only the build directory (no node_modules).
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build provenance (git happens OUTSIDE the image: CI passes the checkout
# commit). BUILD_DATE is canonical; BUILD_TIME is the pre-0.9.1 name, still
# accepted so older CI callers keep working. Empty defaults keep local/dev
# builds metadata-free (surfaces as null, never the string "unknown").
ARG BUILD_SHA=
ARG BUILD_DATE=
ARG BUILD_TIME=
ENV BUILD_SHA=$BUILD_SHA \
    BUILD_DATE=${BUILD_DATE:-$BUILD_TIME} \
    VITE_BUILD_SHA=$BUILD_SHA
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini su-exec
WORKDIR /app

# Non-root runtime user; the entrypoint steps down to PUID/PGID at start.
RUN addgroup -g 1001 dumbscope && adduser -u 1001 -G dumbscope -D -H dumbscope

# Carry build provenance into the runtime stage: app-info reads these via
# process.env at RUNTIME (server-side /api/health/live, diagnostics, stream).
# No git required inside the image — these are plain build-arg strings.
ARG BUILD_SHA=
ARG BUILD_DATE=
ARG BUILD_TIME=
ENV BUILD_SHA=$BUILD_SHA \
    BUILD_DATE=${BUILD_DATE:-$BUILD_TIME}

COPY --from=build --chown=root:root /app/build ./build
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8091 \
    DUMBSCOPE_CONFIG_DIR=/config \
    PUID=99 \
    PGID=100 \
    UMASK=0022

EXPOSE 8091
VOLUME ["/config"]

# Liveness only: "is the process/event loop answering?" Docker restarts on
# failure, so this must never depend on the database or DUMB connectivity.
# Readiness (db + scheduler + hub) is exposed separately at
# /api/health/ready for reverse proxies and orchestrators.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8091) + '/api/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
