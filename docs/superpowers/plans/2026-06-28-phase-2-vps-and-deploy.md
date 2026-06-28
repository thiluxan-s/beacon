# Phase 2 — VPS Setup & Production Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce all the committed infrastructure-as-code (Dockerfiles, prod compose, Caddyfile, CI/CD, deploy/bootstrap/backup scripts) and the two Phase-1 app-code carry-forwards, so the human can deploy Phase 1's app live at `https://beacon.thiluxan.com` via push-to-main.

**Architecture:** Two Docker images (Next.js 16 standalone web, tsx Hono server) built in GitHub Actions, pushed to `ghcr.io`, pulled onto a single hardened DigitalOcean droplet running a 4-service Docker Compose stack (caddy, web, server, postgres) behind Cloudflare. Caddy terminates SSL and routes the two subdomains; web→server calls go over the internal Docker network; `/internal/*` is blocked at the proxy.

**Tech Stack:** Docker + Docker Compose, Caddy 2, GitHub Actions, ghcr.io, Next.js 16 (standalone output), Hono via tsx, Postgres 16, Ubuntu 24.04, Cloudflare DNS.

**Design spec:** `docs/superpowers/specs/2026-06-28-phase-2-vps-deploy-design.md`

## Global Constraints

- Domain: web `beacon.thiluxan.com`, API/WS `api.beacon.thiluxan.com`.
- Images: `ghcr.io/thiluxan-s/beacon-web` and `ghcr.io/thiluxan-s/beacon-server`, tagged with the commit SHA, built for `linux/amd64`.
- Server prod image runs via **tsx** (`tsx src/index.ts`); no compile step.
- Droplet assumption: DigitalOcean Basic, Ubuntu 24.04, $12/mo (1 vCPU / 2GB), region TOR1.
- Compose services this phase: `caddy`, `web`, `server`, `postgres` ONLY (no workers).
- Postgres is never published to the host in production; reachable only on the Docker network at `postgres:5432`.
- `/internal/*` must return 404 on the public API host (blocked at Caddy).
- Secrets NEVER in the repo. `.env.production.example` holds placeholders only; real values live in `/opt/beacon/.env` (600) and GitHub Actions secrets.
- `backup.sh` is committed this phase but its R2 upload is guarded/deferred to Phase 5; no live R2 wiring or UptimeRobot.
- All shell scripts must pass `shellcheck` and `bash -n`.
- TypeScript strict, no `any`; Zod at boundaries; repository pattern unchanged.
- This phase provisions NO live infrastructure from Claude — every task produces a committed artifact. Live provisioning is the human runbook (Task 10 documents it).

---

### Task 1: App-code carry-forwards (internal API URL, standalone output, footer)

**Files:**
- Create: `apps/web/lib/api-base.ts`
- Test: `apps/web/lib/api-base.test.ts`
- Modify: `apps/web/lib/api-client.ts`, `apps/web/lib/ensure-user-exists.ts`, `apps/web/next.config.ts`, `apps/web/app/page.tsx`

**Interfaces:**
- Produces: `serverApiBaseUrl(): string` — returns the base URL for server-side calls to the Hono API: `process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? ''`. Used by `fetchServerHealth` and `upsertUserOnServer`.

- [ ] **Step 1: Write the failing test** — `apps/web/lib/api-base.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverApiBaseUrl } from './api-base';

describe('serverApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers INTERNAL_API_URL when set', () => {
    vi.stubEnv('INTERNAL_API_URL', 'http://server:3001');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.beacon.thiluxan.com');
    expect(serverApiBaseUrl()).toBe('http://server:3001');
  });

  it('falls back to NEXT_PUBLIC_API_URL when INTERNAL_API_URL is unset', () => {
    vi.stubEnv('INTERNAL_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3001');
    expect(serverApiBaseUrl()).toBe('http://localhost:3001');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/web`
Expected: FAIL — cannot resolve `./api-base`.

- [ ] **Step 3: Implement** — `apps/web/lib/api-base.ts`

```ts
// Base URL for server-side calls to the Hono API.
// In production, INTERNAL_API_URL=http://server:3001 keeps web->server traffic on
// the Docker network (never out through Caddy). Locally it is unset, so we fall back
// to NEXT_PUBLIC_API_URL (http://localhost:3001). Empty string is intentional last
// resort so a misconfig surfaces as a fetch error, not a thrown ReferenceError.
export function serverApiBaseUrl(): string {
  const internal = process.env.INTERNAL_API_URL;
  if (internal && internal.length > 0) return internal;
  return process.env.NEXT_PUBLIC_API_URL ?? '';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @beacon/web`
Expected: PASS (api-base 2/2 + existing webhook tests).

- [ ] **Step 5: Use the helper in `apps/web/lib/api-client.ts`**

Replace the `fetch` URL construction. New file content:

```ts
import { HealthResponseSchema, type HealthResponse } from '@beacon/shared';

import { serverApiBaseUrl } from './api-base';

export async function fetchServerHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${serverApiBaseUrl()}/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return HealthResponseSchema.parse(await res.json());
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Use the helper in `apps/web/lib/ensure-user-exists.ts`**

Change only the fetch URL line in `upsertUserOnServer`:

```ts
import 'server-only';
import { currentUser } from '@clerk/nextjs/server';

import { serverApiBaseUrl } from './api-base';

export async function upsertUserOnServer(input: {
  clerkUserId: string;
  email: string;
}): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/users/upsert`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upsertUserOnServer failed: ${res.status}`);
}

export async function ensureUserExists(): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  const email = user.emailAddresses[0]?.emailAddress ?? '';
  try {
    await upsertUserOnServer({ clerkUserId: user.id, email });
  } catch (err) {
    // Non-fatal: the webhook is the primary path; log-and-continue keeps the page rendering.
    console.error('[beacon-web] ensureUserExists upsert failed', err);
  }
}
```

- [ ] **Step 7: Enable standalone output** — `apps/web/next.config.ts`

```ts
import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: trace from the repo root so @beacon/shared (raw TS) is included in
  // the standalone bundle. apps/web is two levels below the root.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // @beacon/shared exports raw TypeScript source (no build step). Instruct
  // Next.js to compile it through its own pipeline so imports resolve at render.
  transpilePackages: ['@beacon/shared'],
};

export default nextConfig;
```

- [ ] **Step 8: Reconcile the landing footer domain** — `apps/web/app/page.tsx`

Find `Self-hosted · thiluxan.dev` and change to `Self-hosted · thiluxan.com`.

- [ ] **Step 9: Verify**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web && npm test -w @beacon/web`
Expected: all exit 0; tests green (api-base 2/2 + webhook 3/3).

- [ ] **Step 10: Commit (request approval first)**

```bash
git add apps/web/lib/api-base.ts apps/web/lib/api-base.test.ts apps/web/lib/api-client.ts apps/web/lib/ensure-user-exists.ts apps/web/next.config.ts apps/web/app/page.tsx
git commit -m "feat(web): internal API URL for server-side calls, standalone output, footer domain"
```

---

### Task 2: Web Dockerfile (Next.js 16 standalone, monorepo)

**Files:**
- Create: `apps/web/Dockerfile`, `apps/web/.dockerignore`

**Interfaces:**
- Produces: an image whose entrypoint is `node apps/web/server.js`, listening on `:3000`, requiring runtime env (`NEXT_PUBLIC_*`, `INTERNAL_API_URL`, etc.). Consumes Task 1's `output: 'standalone'`.

**Precondition:** Docker available. Task 1 merged (standalone output enabled).

- [ ] **Step 1: Create `apps/web/.dockerignore`**

```
node_modules
.next
.env*
!.env.production.example
Dockerfile
.dockerignore
```

- [ ] **Step 2: Create `apps/web/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- deps: install the full monorepo's dependencies ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---- builder: build the standalone web app ----
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* are inlined at build time. Provide build-time values via build args.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN npm run build -w @beacon/web

# ---- runner: minimal standalone runtime ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
# Standalone server + its traced node_modules (monorepo layout preserved).
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
# Next does NOT copy static/public into standalone — do it manually.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 3: Build the image locally**

Run from repo root:
```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:3001 \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_placeholder \
  -t beacon-web:local .
```
Expected: build succeeds; final stage produces `beacon-web:local`.

- [ ] **Step 4: Smoke-run the image**

```bash
docker run --rm -d --name beacon-web-smoke -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=http://localhost:3001 \
  -e NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_placeholder \
  -e INTERNAL_API_URL=http://localhost:3001 \
  beacon-web:local
sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
docker rm -f beacon-web-smoke
```
Expected: `200` (landing page renders; it has no server dependency).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/web/Dockerfile apps/web/.dockerignore
git commit -m "feat(infra): web Dockerfile (Next.js standalone, monorepo)"
```

---

### Task 3: Server Dockerfile (Hono via tsx)

**Files:**
- Create: `apps/server/Dockerfile`, `apps/server/.dockerignore`

**Interfaces:**
- Produces: an image running `tsx src/index.ts` on `:3001`, with `apps/server/drizzle/` migrations present so `npm run db:migrate` works in the container. Consumes runtime env (`DATABASE_URL`, `WEB_ORIGIN`, `INTERNAL_API_SECRET`).

- [ ] **Step 1: Create `apps/server/.dockerignore`**

```
node_modules
.env*
!.env.production.example
Dockerfile
.dockerignore
```

- [ ] **Step 2: Create `apps/server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---- runner: tsx runtime ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=deps /app/node_modules ./node_modules
# Server source + shared package (raw TS, run via tsx) + migrations.
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 hono \
 && chown -R hono:nodejs /app
USER hono
EXPOSE 3001
# Run from the server workspace so drizzle paths (./drizzle) resolve and tsx finds src.
WORKDIR /app/apps/server
CMD ["npm", "run", "start"]
```

- [ ] **Step 3: Build the image locally**

```bash
docker build -f apps/server/Dockerfile -t beacon-server:local .
```
Expected: build succeeds.

- [ ] **Step 4: Smoke-run against the local dev Postgres**

Ensure dev Postgres is up (`docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`). Then:
```bash
docker run --rm -d --name beacon-server-smoke -p 3001:3001 \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL=postgresql://beacon:beacon@host.docker.internal:5432/beacon \
  -e WEB_ORIGIN=http://localhost:3000 \
  -e INTERNAL_API_SECRET=test-internal-secret-at-least-32-chars \
  beacon-server:local
sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health   # expect 200
docker rm -f beacon-server-smoke
```
Expected: `200`.

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/Dockerfile apps/server/.dockerignore
git commit -m "feat(infra): server Dockerfile (Hono via tsx, migrations included)"
```

---

### Task 4: Production compose + Caddyfile

**Files:**
- Create: `infrastructure/docker-compose.yml`, `infrastructure/Caddyfile`

**Interfaces:**
- Produces: a 4-service prod stack referencing `ghcr.io/thiluxan-s/beacon-{web,server}:${BEACON_VERSION}`, reading runtime config from `env_file`. Caddy routes the two hosts and blocks `/internal/*`. Consumes the images from Tasks 2–3.

- [ ] **Step 1: Create `infrastructure/Caddyfile`**

```caddy
beacon.thiluxan.com {
	encode gzip zstd
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
	reverse_proxy web:3000
}

api.beacon.thiluxan.com {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
	# /internal/* is for in-network web->server calls only; never expose it publicly.
	handle /internal/* {
		respond 404
	}
	handle {
		reverse_proxy server:3001
	}
}
```

- [ ] **Step 2: Create `infrastructure/docker-compose.yml`**

```yaml
name: beacon

services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web
      - server

  web:
    image: ghcr.io/thiluxan-s/beacon-web:${BEACON_VERSION}
    restart: unless-stopped
    env_file:
      - path: .env
        required: false # absent locally; present at /opt/beacon/.env on the VPS
    expose:
      - '3000'
    depends_on:
      - server

  server:
    image: ghcr.io/thiluxan-s/beacon-server:${BEACON_VERSION}
    restart: unless-stopped
    env_file:
      - path: .env
        required: false # absent locally; present at /opt/beacon/.env on the VPS
    expose:
      - '3001'
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: beacon
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: beacon
    volumes:
      - beacon_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U beacon -d beacon']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  caddy_data:
  caddy_config:
  beacon_postgres_data:
```

- [ ] **Step 3: Validate the compose file**

Run: `BEACON_VERSION=test POSTGRES_PASSWORD=test docker compose -f infrastructure/docker-compose.yml config >/dev/null && echo OK`
Expected: `OK` (interpolation + schema valid). The relative `.env` is `required: false`, so its absence locally does not error.

- [ ] **Step 4: Validate the Caddyfile syntax**

Run: `docker run --rm -v "$PWD/infrastructure/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2 caddy validate --config /etc/caddy/Caddyfile`
Expected: "Valid configuration".

- [ ] **Step 5: Commit (request approval first)**

```bash
git add infrastructure/docker-compose.yml infrastructure/Caddyfile
git commit -m "feat(infra): production compose stack and Caddyfile"
```

---

### Task 5: Local production-stack smoke test (override compose)

**Files:**
- Create: `infrastructure/docker-compose.local-prod.yml`

**Interfaces:**
- Produces: an override that builds the images locally and publishes ports, so the prod images + compose wiring + migration + internal-URL path can be smoke-tested without the live VPS or real SSL. Consumes Tasks 1–4.

- [ ] **Step 1: Create `infrastructure/docker-compose.local-prod.yml`**

```yaml
# Local smoke test of the production images + wiring. Builds locally instead of
# pulling from ghcr, publishes web/server to the host, and skips Caddy (auto-HTTPS
# needs real domains). Caddyfile is validated separately in Task 4.
name: beacon

services:
  caddy:
    profiles: ['never'] # excluded from local smoke

  web:
    image: beacon-web:local
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
      args:
        NEXT_PUBLIC_API_URL: http://localhost:3001
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_placeholder
    ports:
      - '3000:3000'

  server:
    image: beacon-server:local
    build:
      context: ..
      dockerfile: apps/server/Dockerfile
    ports:
      - '3001:3001'
```

- [ ] **Step 2: Create a throwaway local-prod env file (NOT committed)**

```bash
cat > /tmp/beacon-local-prod.env <<'EOF'
POSTGRES_PASSWORD=localprod
DATABASE_URL=postgresql://beacon:localprod@postgres:5432/beacon
WEB_ORIGIN=http://localhost:3000
INTERNAL_API_SECRET=localprod-internal-secret-min-32-characters
NEXT_PUBLIC_API_URL=http://localhost:3001
INTERNAL_API_URL=http://server:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_placeholder
CLERK_SECRET_KEY=sk_test_placeholder
CLERK_WEBHOOK_SECRET=whsec_placeholder
EOF
```

- [ ] **Step 3: Bring up the stack (build + run), pointing env_file at the throwaway**

The prod compose hardcodes `env_file: /opt/beacon/.env`; for the smoke test, copy it there is not desired. Instead run with an override of env_file via an inline compose patch:

```bash
mkdir -p /tmp/beacon-localprod && cp /tmp/beacon-local-prod.env /tmp/beacon-localprod/.env
cat > /tmp/beacon-localprod/override.yml <<'EOF'
services:
  web: { env_file: /tmp/beacon-localprod/.env }
  server: { env_file: /tmp/beacon-localprod/.env }
  postgres:
    environment:
      POSTGRES_PASSWORD: localprod
EOF
BEACON_VERSION=local POSTGRES_PASSWORD=localprod docker compose \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.local-prod.yml \
  -f /tmp/beacon-localprod/override.yml \
  up -d --build postgres server web
```
Expected: postgres healthy, server + web start.

- [ ] **Step 4: Run migrations in the running stack**

```bash
BEACON_VERSION=local POSTGRES_PASSWORD=localprod docker compose \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.local-prod.yml \
  -f /tmp/beacon-localprod/override.yml \
  run --rm server npm run db:migrate
```
Expected: "[beacon-server] migrations applied".

- [ ] **Step 5: Verify the round-trip + internal URL**

```bash
sleep 3
curl -s -o /dev/null -w "web /:        %{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "server /health: %{http_code}\n" http://localhost:3001/health
# web /health round-trips to server over INTERNAL_API_URL=http://server:3001:
curl -s http://localhost:3000/health | grep -q 'All systems operational' && echo "round-trip OK" || echo "round-trip FAILED"
```
Expected: web `/` 200, server `/health` 200, "round-trip OK" (proves the web container reaches the server over the Docker network via `INTERNAL_API_URL`).

- [ ] **Step 6: Tear down**

```bash
BEACON_VERSION=local POSTGRES_PASSWORD=localprod docker compose \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.local-prod.yml \
  -f /tmp/beacon-localprod/override.yml down -v
rm -rf /tmp/beacon-localprod /tmp/beacon-local-prod.env
```

- [ ] **Step 7: Commit (request approval first)**

```bash
git add infrastructure/docker-compose.local-prod.yml
git commit -m "feat(infra): local production-stack smoke-test override"
```

---

### Task 6: Deploy script

**Files:**
- Create: `infrastructure/deploy/deploy.sh`

**Interfaces:**
- Produces: `deploy.sh <SHA>` — run on the VPS from `/opt/beacon`. Pulls the tagged images, runs migrations, brings the stack up, health-verifies both endpoints, and rolls back to the previous SHA on failure. Consumes Task 4's compose.

- [ ] **Step 1: Create `infrastructure/deploy/deploy.sh`**

```bash
#!/usr/bin/env bash
# Beacon production deploy. Run on the VPS from /opt/beacon.
# Usage: deploy.sh <git-sha>
set -euo pipefail

NEW_VERSION="${1:?usage: deploy.sh <git-sha>}"
COMPOSE_DIR="/opt/beacon"
VERSION_FILE="${COMPOSE_DIR}/.deployed_version"
WEB_HEALTH="https://beacon.thiluxan.com/health"
API_HEALTH="https://api.beacon.thiluxan.com/health"

cd "$COMPOSE_DIR"

PREVIOUS_VERSION=""
[ -f "$VERSION_FILE" ] && PREVIOUS_VERSION="$(cat "$VERSION_FILE")"

export BEACON_VERSION="$NEW_VERSION"
# POSTGRES_PASSWORD is sourced from the env file used by compose interpolation.
set -a; . "${COMPOSE_DIR}/.env"; set +a

echo "[deploy] pulling images @ ${NEW_VERSION}"
docker compose pull web server

echo "[deploy] running migrations"
if ! docker compose run --rm server npm run db:migrate; then
  echo "[deploy] migration FAILED — aborting before traffic flip" >&2
  exit 1
fi

echo "[deploy] bringing stack up"
docker compose up -d

verify() {
  local url="$1" i
  for i in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then return 0; fi
    sleep 2
  done
  return 1
}

echo "[deploy] verifying health"
if verify "$API_HEALTH" && verify "$WEB_HEALTH"; then
  echo "$NEW_VERSION" > "$VERSION_FILE"
  echo "[deploy] OK @ ${NEW_VERSION}"
  exit 0
fi

echo "[deploy] health check FAILED" >&2
if [ -n "$PREVIOUS_VERSION" ]; then
  echo "[deploy] rolling back to ${PREVIOUS_VERSION}" >&2
  export BEACON_VERSION="$PREVIOUS_VERSION"
  docker compose pull web server
  docker compose up -d
fi
exit 1
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x infrastructure/deploy/deploy.sh`

- [ ] **Step 3: Lint it**

Run: `shellcheck infrastructure/deploy/deploy.sh && bash -n infrastructure/deploy/deploy.sh && echo OK`
Expected: no warnings; `OK`.

- [ ] **Step 4: Commit (request approval first)**

```bash
git add infrastructure/deploy/deploy.sh
git commit -m "feat(infra): production deploy script with health verify and rollback"
```

---

### Task 7: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: CI that runs checks on every push/PR and, on push to `main`, builds+pushes both images to ghcr and runs `deploy.sh` over SSH. Consumes Tasks 2, 3, 6 and the GitHub secrets `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_KNOWN_HOSTS`.

- [ ] **Step 1: Create `.github/workflows/deploy.yml`**

```yaml
name: deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_WEB: ghcr.io/thiluxan-s/beacon-web
  IMAGE_SERVER: ghcr.io/thiluxan-s/beacon-server

jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: beacon
          POSTGRES_PASSWORD: beacon
          POSTGRES_DB: beacon
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U beacon -d beacon"
          --health-interval 5s --health-timeout 5s --health-retries 5
    env:
      # The server's repository test is an integration test against Postgres, and
      # migrate.ts validates the full server env schema at import — provide all three.
      DATABASE_URL: postgresql://beacon:beacon@localhost:5432/beacon
      WEB_ORIGIN: http://localhost:3000
      INTERNAL_API_SECRET: test-internal-secret-at-least-32-characters
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run db:migrate -w @beacon/server # create the users table before tests
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test

  deploy:
    needs: checks
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push web image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/web/Dockerfile
          platforms: linux/amd64
          push: true
          tags: ${{ env.IMAGE_WEB }}:${{ github.sha }}
          build-args: |
            NEXT_PUBLIC_API_URL=https://api.beacon.thiluxan.com
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}

      - name: Build & push server image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/server/Dockerfile
          platforms: linux/amd64
          push: true
          tags: ${{ env.IMAGE_SERVER }}:${{ github.sha }}

      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: thiluxan
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            cd /opt/beacon
            bash /opt/beacon/deploy/deploy.sh ${{ github.sha }}
```

> Note: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a publishable (non-secret) Clerk key but is stored as a GitHub secret to keep it out of the repo; it is inlined into the web bundle at build time. The `deploy/` folder and the env file are placed on the VPS during the runbook (Task 10).

- [ ] **Step 2: Validate the workflow YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML OK')"`
Expected: `YAML OK`. (If `actionlint` is available, run it too.)

- [ ] **Step 3: Commit (request approval first)**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(ci): build+push images to ghcr and deploy over SSH on push to main"
```

---

### Task 8: VPS bootstrap (hardening) script

**Files:**
- Create: `infrastructure/scripts/bootstrap-vps.sh`

**Interfaces:**
- Produces: a script run once as root on a fresh droplet that creates the deploy user, locks down SSH, configures ufw + fail2ban + unattended-upgrades, sets UTC, and installs Docker. Idempotent where practical.

- [ ] **Step 1: Create `infrastructure/scripts/bootstrap-vps.sh`**

```bash
#!/usr/bin/env bash
# One-time hardening + Docker install for a fresh Ubuntu 24.04 droplet.
# Run as root: bash bootstrap-vps.sh <ssh_public_key>
set -euo pipefail

PUBKEY="${1:?usage: bootstrap-vps.sh \"<ssh_public_key>\"}"
DEPLOY_USER="thiluxan"

echo "[bootstrap] timezone -> UTC"
timedatectl set-timezone UTC

echo "[bootstrap] create deploy user ${DEPLOY_USER}"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
echo "$PUBKEY" > "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"

echo "[bootstrap] SSH hardening"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

echo "[bootstrap] firewall (ufw)"
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "[bootstrap] fail2ban + auto updates"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "[bootstrap] install Docker (official repo)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$DEPLOY_USER"

echo "[bootstrap] mkdir /opt/beacon"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/beacon

echo "[bootstrap] DONE. Verify: sudo -u ${DEPLOY_USER} docker run --rm hello-world"
```

- [ ] **Step 2: Lint it**

Run: `shellcheck infrastructure/scripts/bootstrap-vps.sh && bash -n infrastructure/scripts/bootstrap-vps.sh && echo OK`
Expected: no warnings; `OK`.

- [ ] **Step 3: Commit (request approval first)**

```bash
git add infrastructure/scripts/bootstrap-vps.sh
git commit -m "feat(infra): VPS bootstrap and hardening script"
```

---

### Task 9: Backup script (committed; R2 deferred to Phase 5)

**Files:**
- Create: `infrastructure/scripts/backup.sh`, `infrastructure/scripts/beacon-backup.cron`

**Interfaces:**
- Produces: a nightly `pg_dump | gzip` script. The R2 upload is present but guarded behind a `BEACON_BACKUP_REMOTE` env var that is unset until Phase 5, so running it now only writes a local dump.

- [ ] **Step 1: Create `infrastructure/scripts/backup.sh`**

```bash
#!/usr/bin/env bash
# Nightly Beacon Postgres backup. Run on the VPS.
# R2 upload is DEFERRED to Phase 5: it only runs if BEACON_BACKUP_REMOTE is set.
set -euo pipefail

COMPOSE_DIR="/opt/beacon"
OUT_DIR="${BEACON_BACKUP_DIR:-/var/backups/beacon}"
STAMP="$(date +%F)"
DUMP="${OUT_DIR}/beacon-${STAMP}.sql.gz"

install -d -m 700 "$OUT_DIR"
cd "$COMPOSE_DIR"

echo "[backup] dumping -> ${DUMP}"
docker compose exec -T postgres pg_dump -U beacon beacon | gzip > "$DUMP"

if [ -n "${BEACON_BACKUP_REMOTE:-}" ]; then
  echo "[backup] uploading to ${BEACON_BACKUP_REMOTE}"
  rclone copy "$DUMP" "$BEACON_BACKUP_REMOTE"
  rm -f "$DUMP"
else
  echo "[backup] BEACON_BACKUP_REMOTE unset — local dump kept (R2 wiring is Phase 5)"
fi

echo "[backup] pruning local dumps older than 7 days"
find "$OUT_DIR" -name 'beacon-*.sql.gz' -mtime +7 -delete
```

- [ ] **Step 2: Create the cron entry** — `infrastructure/scripts/beacon-backup.cron`

```cron
# Install to /etc/cron.d/beacon-backup (root-owned, 644). Phase 5 sets BEACON_BACKUP_REMOTE.
0 3 * * * thiluxan /opt/beacon/scripts/backup.sh >> /var/log/beacon-backup.log 2>&1
```

- [ ] **Step 3: Lint it**

Run: `shellcheck infrastructure/scripts/backup.sh && bash -n infrastructure/scripts/backup.sh && echo OK`
Expected: no warnings; `OK`.

- [ ] **Step 4: Commit (request approval first)**

```bash
git add infrastructure/scripts/backup.sh infrastructure/scripts/beacon-backup.cron
git commit -m "feat(infra): postgres backup script and cron (R2 upload deferred to Phase 5)"
```

---

### Task 10: Production env reference, INFRASTRUCTURE.md, and runbook

**Files:**
- Create: `infrastructure/.env.production.example`
- Modify: `docs/INFRASTRUCTURE.md`, `README.md`

**Interfaces:**
- Produces: a committed, placeholder-only reference for `/opt/beacon/.env`; an updated INFRASTRUCTURE.md reflecting actual Phase 2 decisions + the human runbook; a README note that the app is deploy-ready.

- [ ] **Step 1: Create `infrastructure/.env.production.example`**

```bash
# Copy to /opt/beacon/.env on the VPS (chmod 600). Real values only on the VPS.
POSTGRES_PASSWORD=changeme-generate-a-strong-password
DATABASE_URL=postgresql://beacon:changeme-generate-a-strong-password@postgres:5432/beacon
WEB_ORIGIN=https://beacon.thiluxan.com
INTERNAL_API_SECRET=changeme-openssl-rand-base64-32-min-32-chars
NEXT_PUBLIC_API_URL=https://api.beacon.thiluxan.com
INTERNAL_API_URL=http://server:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_or_test_xxx
CLERK_SECRET_KEY=sk_live_or_test_xxx
CLERK_WEBHOOK_SECRET=whsec_xxx
```

- [ ] **Step 2: Update `docs/INFRASTRUCTURE.md`**

Make these edits (reflecting actual Phase 2 decisions):
- VPS size: change the "Decided in Phase 2" line to "1 vCPU / 2GB ($12/mo), chosen for WS/worker headroom."
- Required env: replace the target-state env block with the Phase 2 actual block from `infrastructure/.env.production.example` (note that integrations/Resend/WS vars arrive in later phases).
- Cost ledger: change Droplet to `$12` and Total to `~$16/mo`.
- Add a `## Runbook — first-time provisioning (Phase 2)` section with the human steps (Step 3 below). Keep the existing operational runbook.
- `Last verified restore:` leave as TBD (Phase 5).

- [ ] **Step 3: Add the provisioning runbook to `docs/INFRASTRUCTURE.md`**

```markdown
## Runbook — first-time provisioning (Phase 2)

1. Create the droplet (DigitalOcean → Ubuntu 24.04, $12/2GB, TOR1) with your SSH key.
2. As root: `bash bootstrap-vps.sh "<your-ssh-public-key>"` (creates user `thiluxan`, hardens SSH, ufw, fail2ban, Docker, `/opt/beacon`).
3. Copy `infrastructure/docker-compose.yml`, `infrastructure/Caddyfile`, and `infrastructure/deploy/deploy.sh` to `/opt/beacon/` (deploy/ keeps deploy.sh). Copy `infrastructure/scripts/` too.
4. Create `/opt/beacon/.env` (chmod 600) from `infrastructure/.env.production.example` with real secrets: generate `POSTGRES_PASSWORD` and `INTERNAL_API_SECRET` (`openssl rand -base64 32`), paste production Clerk keys.
5. Cloudflare: add A records `beacon` and `api.beacon` → droplet IP. Start **DNS-only (grey cloud)** so Caddy can issue Let's Encrypt certs. Once `https://beacon.thiluxan.com` serves a valid cert, switch to **proxied (orange) + SSL Full (strict)**. Verify WebSockets are allowed on the API host (Network tab).
6. GitHub repo secrets: `SSH_PRIVATE_KEY` (deploy key for user `thiluxan`), `SSH_HOST` (droplet IP), `SSH_KNOWN_HOSTS` (`ssh-keyscan <ip>`), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
7. Clerk dashboard: add a production webhook → `https://beacon.thiluxan.com/api/clerk/webhook`, subscribe `user.created`/`user.updated`, copy the signing secret into `/opt/beacon/.env` as `CLERK_WEBHOOK_SECRET`.
8. First deploy: push to `main` (or re-run the workflow). Watch GitHub Actions. On success, visit `https://beacon.thiluxan.com`, sign in, and confirm a row: `docker compose exec postgres psql -U beacon -d beacon -c 'select clerk_user_id, email from users;'`.
9. Tag the known-good deploy: `git tag -a v0.2.0 -m "First production deploy" && git push --tags`.
```

- [ ] **Step 4: Update `README.md`**

In the Status section, note Phase 2 adds the production deploy: the app is deployable to `https://beacon.thiluxan.com` via push-to-main (GitHub Actions → ghcr → VPS). Keep it current-state and honest (mark it "deploy pipeline built; first live deploy pending provisioning" until the human completes the runbook).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add infrastructure/.env.production.example docs/INFRASTRUCTURE.md README.md
git commit -m "docs(infra): production env reference, INFRASTRUCTURE updates, provisioning runbook"
```

---

## Notes for the executor

- Tasks 1 and 5 are the only ones with real test/round-trip verification; Tasks 2–4, 6–10 are infra artifacts verified by `docker build`, `docker compose config`, `caddy validate`, `shellcheck`, and YAML validation — there is no unit-test cycle for them, and that is expected.
- No task provisions live infrastructure. The droplet, DNS, secrets, and first deploy are the human runbook (Task 10, executed after all artifacts are committed).
- Approval gate: per CLAUDE.md, pause for the human's approval before every `git add`/`git commit`.
