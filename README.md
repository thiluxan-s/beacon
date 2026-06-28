# Beacon

A real-time monitoring dashboard for the services I run — self-hosted on my own VPS, at my own domain. Beacon watches anything with an HTTP endpoint (my deployed projects, my domains, future client work) and adds deeper insight where I've configured an integration. It's the systems-engineering counterpart to my two prior projects: where those are Next.js-on-Vercel serverless apps, Beacon is deliberately a long-running Node server, WebSockets, Postgres, and a real deploy pipeline on a box I own.

> **Deliberately not serverless.** This project has real monthly infrastructure costs (~$16/mo: a DigitalOcean droplet + a domain; Cloudflare and UptimeRobot on free tiers). That's the point — it demonstrates the self-hosted, own-the-stack side of building, not the managed-platform side. The cost is a feature, not a flaw.

## Status

**Phase 1 (local foundation) — complete.** This repo currently runs as a two-process local development system: a Next.js web app and a Hono API server talking to a Postgres database, with authentication wired up.

**Phase 2 (production deploy) — live.** The app is deployed at **[`https://beacon.thiluxan.com`](https://beacon.thiluxan.com)** via push-to-main: GitHub Actions runs checks, builds both images and pushes them to ghcr, then deploys over SSH onto a DigitalOcean VPS (Caddy auto-TLS reverse proxy + Docker Compose: web, Hono server, Postgres). `deploy.sh` runs migrations, health-verifies both hosts, and rolls back on failure. The full provisioning runbook is in [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md). Real-time monitoring is still a later phase.

### What works today

- **Landing page** (`/`) — the product pitch, with a system-status link.
- **Authentication** (Clerk) — sign-in / sign-up pages, route protection. Signed-out visits to `/services` redirect to sign-in; signed-in users reach the app shell.
- **User persistence** — a Postgres `users` table (Drizzle ORM + migration). New users are upserted into it on sign-in via a Clerk webhook (Svix-verified) with a lazy `ensureUserExists()` fallback for local dev.
- **Web ↔ server round-trip** — `/health` is a Server Component that fetches the API server's `/health` endpoint and degrades gracefully when the server is down. This proves the two processes communicate over the local network.
- **Services dashboard shell** (`/services`) — an honest empty state (no fake data) ready for real monitoring data.

### Not built yet

Tracked in [`docs/phases/`](docs/phases/):

- **Phase 3** — background health-check workers and real-time status streaming over WebSockets.
- **Phase 4** — the integration layer (Vercel, GitHub today; Railway, Fly, custom webhooks tomorrow).
- **Phase 5** — incident timelines and alerting.
- **Phase 6** — polish.

## Architecture

```mermaid
flowchart TD
    Visitor([Browser / recruiter]) -->|HTTPS · Namecheap DNS| Caddy

    subgraph Droplet["DigitalOcean droplet · Ubuntu 24.04 · Docker Compose"]
        Caddy[Caddy<br/>auto-TLS + reverse proxy]
        Caddy -->|beacon.thiluxan.com| Web[Next.js 16 web<br/>Server Components]
        Caddy -->|api.beacon.thiluxan.com| Server[Hono server<br/>long-running · HTTP + WS hub]
        Web <-->|reads · internal Docker network| Server
        Server --> DB[(Postgres 16<br/>Drizzle · also the job queue)]
        Workers[Background workers<br/>health checks · integration fetches] --> DB
        Server -. live status_changed .-> Web
    end

    Workers -. probe · poll .-> External[Monitored targets<br/>Vercel · GitHub · any HTTP endpoint]

    subgraph Pipeline["Push-to-main deploy"]
        Actions[GitHub Actions<br/>typecheck · lint · test · build] --> Registry[(ghcr.io images)]
    end
    Registry -. deploy.sh over SSH · pull · migrate · verify · rollback .-> Caddy

    classDef planned fill:#eef1f5,stroke:#9aa5b1,stroke-dasharray:4 3,color:#33404f;
    class Workers,External planned;
```

> **Solid** = live today (Phases 1–2: web, server, Postgres, and the push-to-main deploy pipeline). **Dashed** = the background workers, real-time WebSocket updates, and integration layer landing in Phases 3–5.

The central abstraction is the **integration layer**: every source of monitoring data (Vercel, GitHub, a plain HTTP check) implements one interface and registers itself. Adding a new platform is always a "drop in a file + register it" operation, never a change to core code. That design — and how the long-running server, WebSockets, and database fit together — is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Tech stack

| Layer | Choice |
| --- | --- |
| Web | Next.js 16 (App Router), TypeScript strict, Tailwind v4, shadcn/ui |
| API server | Node.js + Hono (long-running HTTP, WebSockets to come) |
| Database | Postgres (Docker locally), Drizzle ORM |
| Auth | Clerk (single-user) |
| Validation | Zod everywhere — schemas are the source of truth |
| Shared types | `@beacon/shared` workspace package |

### Monorepo layout

```
apps/
  web/        # Next.js 16 frontend (port 3000)
  server/     # Hono API server (port 3001)
packages/
  shared/     # Zod schemas + types shared across web and server
infrastructure/
  docker-compose.dev.yml   # local Postgres
docs/         # PRD, architecture, data model, design, infrastructure, phases
```

npm workspaces. No build step for `@beacon/shared` — it ships raw TypeScript and Next transpiles it via `transpilePackages`.

## Local setup

**Prerequisites:** Node.js 20.9+ (22 recommended), Docker, and a [Clerk](https://clerk.com) application (a free test instance is fine).

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres
docker compose -f infrastructure/docker-compose.dev.yml up -d postgres

# 3. Configure the server env
cp apps/server/.env.example apps/server/.env
#    then set INTERNAL_API_SECRET to a real value:
#    openssl rand -base64 32

# 4. Configure the web env
cp apps/web/.env.example apps/web/.env.local
#    then set:
#    - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (from your Clerk dashboard)
#    - INTERNAL_API_SECRET — MUST match the value in apps/server/.env

# 5. Run the database migration
npm run db:migrate

# 6. Start both apps
npm run dev          # web on :3000, server on :3001
```

Visit **http://localhost:3000**. Sign up, and you'll land on `/services`; your user row is created in Postgres on first load.

> **Why `INTERNAL_API_SECRET` appears in both apps:** the web app's Clerk webhook and `ensureUserExists()` call the server's internal upsert endpoint, which is guarded by this shared secret. If the two values don't match, the server rejects the call with 401.

> **Clerk webhooks in production:** locally, user rows are created by the `ensureUserExists()` fallback, so a real `CLERK_WEBHOOK_SECRET` isn't required. The production webhook (pointing at the deployed URL) is configured in Phase 2.

## Scripts

Run from the repo root (they fan out across workspaces):

```bash
npm run dev          # both apps, concurrently
npm run typecheck    # tsc --noEmit across all workspaces
npm run lint         # eslint across all workspaces
npm test             # vitest across all workspaces
npm run db:migrate   # apply Drizzle migrations
npm run db:generate  # generate a new migration from schema changes
```

## Conventions

- TypeScript `strict`, no `any`. Zod schemas derive types; Drizzle schema derives DB types.
- Server Components by default; `"use client"` only when genuinely needed.
- All database access goes through `apps/server/src/db/repositories/` — no raw queries in routes.
- Timestamps are `timestamptz`, server clocks in UTC.
- Secrets never land in the repo. `.env.example` files hold placeholders; real values live in gitignored `.env` / `.env.local`.

See [`CLAUDE.md`](CLAUDE.md) for the full project context and working conventions.
