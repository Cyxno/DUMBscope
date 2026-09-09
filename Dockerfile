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
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini su-exec
WORKDIR /app

# Non-root runtime user; the entrypoint steps down to PUID/PGID at start.
RUN addgroup -g 1001 dumbscope && adduser -u 1001 -G dumbscope -D -H dumbscope

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8091) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
