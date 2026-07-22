# The whole product in one image: API, web app and migrations.
#
# Multi-stage so the thing that ships carries no compilers, no test runners and
# no source. The build stage is where pnpm and the toolchain live; the runtime
# stage gets the built app, production dependencies, and nothing else.

# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# better-sqlite3 compiles against the Node headers, so the build stage needs a
# toolchain. None of this reaches the image that runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app

# Manifests first, so a change to source code does not re-resolve every
# dependency. This is the difference between a ten second rebuild and a two
# minute one.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @open-artifact/shared --filter @open-artifact/server --filter @open-artifact/web

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web

# The web app is built into packages/server/public, which the server serves. One
# origin for the app and the API is what keeps the session cookie simple and
# means there is no separate static host to run.
RUN pnpm --filter @open-artifact/shared build \
 && pnpm --filter @open-artifact/web build \
 && pnpm --filter @open-artifact/server build

# Production dependencies only, resolved into a plain node_modules the runtime
# stage can copy without pnpm being installed there.
RUN pnpm --filter @open-artifact/server deploy --prod --legacy /runtime \
 && rm -rf /runtime/src /runtime/test

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Nothing here runs as root. A process that only needs to read its own code and
# write one database file has no business being able to do more.
RUN useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin app

COPY --from=build --chown=app:app /runtime/node_modules ./node_modules
COPY --from=build --chown=app:app /app/packages/server/dist ./dist
COPY --from=build --chown=app:app /app/packages/server/migrations ./migrations
COPY --from=build --chown=app:app /app/packages/server/public ./public

# Where the database lives. Mounted as a volume in production; backing this one
# file up is backing up everything.
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]
ENV DATABASE_PATH=/data/open-artifact.db

USER app
EXPOSE 3000

# The healthcheck is the same endpoint the container orchestrator and any uptime
# monitor use: it answers only when the database is reachable and migrated, so a
# container that cannot read its own data is restarted rather than left serving
# errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
