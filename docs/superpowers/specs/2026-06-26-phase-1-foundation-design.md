# Phase 1 — Foundation (Local): Design Spec

**Date:** 2026-06-26
**Phase doc:** `docs/phases/phase-1-foundation.md`
**Branch:** `phase-1-foundation`
**Status:** Approved (design), pending implementation plan

---

## Goal

A local-only monorepo with two communicating apps — Next.js 15 web + Hono server — plus a
shared package, Clerk auth, Postgres (Docker) wired through Drizzle, and the scaffolding for
service CRUD. **No VPS, no WebSockets, no integrations, no health checks, no alerts** — those
are later phases. The bar for "done" is an excellent local dev experience:
`npm install && docker compose up -d postgres && npm run dev` yields a working two-process
system with auth in under five minutes.

This spec refines `docs/phases/phase-1-foundation.md`; where this spec is more specific, it wins.
Where it would contradict that doc, the contradiction is called out explicitly (none currently).

---

## Confirmed decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| — | Workspaces | npm workspaces | Per phase doc; simplest for a portfolio monorepo. |
| — | Server runtime | Node 22 + `@hono/node-server` | Node, not Bun, in v1 (phase doc). Node 22 LTS confirmed installed. |
| — | Auth | Clerk | Confirmed by user; consistent with Wayfare / Investor Thesis. |
| — | Accent color | Graphite / near-black `#27272A` | Most disciplined reading of DESIGN.md "color only for status." |
| — | Status palette | `up #3F7D58`, `degraded #C18A1F`, `down #B23A48`, `paused` zinc-500 `#71717A` | From DESIGN.md working assumptions / decisions-log example. |
| A | Dev orchestration | `concurrently` | One tiny dev dep, prefixed logs; Turborepo is overkill for 2 apps + 1 lib. |
| B | `@beacon/shared` consumption | TypeScript source directly (no build step) | `exports` point at `src`; each app transpiles via its own toolchain. No watch-rebuild friction. |
| C | Fonts | Geist Sans + Geist Mono (`geist` package) | First-party Next, zero-config, monochrome-friendly, matches the visual bar. |

### Local environment note

Docker is not currently reachable in this WSL2 distro. The user will enable Docker Desktop's
WSL2 integration (Settings → Resources → WSL Integration). All non-Docker scaffolding proceeds
in parallel; the Postgres-dependent acceptance criteria are verified once Docker is live.

---

## Repository structure (end state of Phase 1)

```
.
├── CLAUDE.md
├── README.md                       # describes CURRENT state, not a phase TODO
├── package.json                    # root: workspaces + scripts
├── tsconfig.base.json              # shared strict TS config
├── .gitignore
├── .env.example                    # root example, points at per-app examples
├── .prettierrc / eslint.config.mjs # shared lint/format at root
├── docs/                           # (existing docs already moved here)
│   ├── PRD.md ARCHITECTURE.md INFRASTRUCTURE.md DATA_MODEL.md DESIGN.md KICKOFF_PROMPT.md
│   ├── phases/phase-1..6.md
│   └── superpowers/specs/2026-06-26-phase-1-foundation-design.md   # this file (tracked)
├── infrastructure/
│   └── docker-compose.dev.yml      # Postgres 16 for local dev
├── apps/
│   ├── web/                        # Next.js 15
│   │   ├── package.json tsconfig.json next.config.ts
│   │   ├── tailwind.config.ts postcss.config.mjs
│   │   ├── middleware.ts           # clerkMiddleware, protects (app)/*
│   │   ├── .env.example .env.local(gitignored)
│   │   ├── app/
│   │   │   ├── layout.tsx page.tsx globals.css
│   │   │   ├── (auth)/sign-in/[[...sign-in]]/page.tsx
│   │   │   ├── (auth)/sign-up/[[...sign-up]]/page.tsx
│   │   │   ├── (app)/layout.tsx            # calls ensureUserExists()
│   │   │   ├── (app)/services/page.tsx     # empty state, disabled "Add service"
│   │   │   ├── health/page.tsx             # PUBLIC server-component fetch of server /health
│   │   │   └── api/clerk/webhook/route.ts  # Svix-verified
│   │   ├── components/ui/          # shadcn: button card input label sonner
│   │   └── lib/
│   │       ├── env.client.ts        # Zod-validated NEXT_PUBLIC_* only
│   │       ├── api-client.ts        # typed fetch wrapper for the server app
│   │       └── ensure-user-exists.ts
│   └── server/                     # Hono
│       ├── package.json tsconfig.json drizzle.config.ts
│       ├── .env.example .env(gitignored)
│       ├── src/
│       │   ├── index.ts            # @hono/node-server on :3001
│       │   ├── router.ts           # /health, /internal/users (webhook upsert target)
│       │   ├── lib/env.ts          # Zod-validated server env
│       │   └── db/
│       │       ├── index.ts        # pg pool + drizzle client
│       │       ├── schema.ts       # users table ONLY
│       │       └── repositories/users.ts
│       └── drizzle/                # generated migration(s)
└── packages/
    └── shared/
        ├── package.json tsconfig.json
        └── src/index.ts            # near-empty; one real export to prove wiring
```

---

## Components & responsibilities

### `packages/shared`
- **What:** Home for Zod schemas/types shared between web and server. Phase 1 keeps it minimal.
- **Interface:** `@beacon/shared` resolves to `src/index.ts` (decision B). Exports at least one real
  symbol (e.g. a `HealthResponseSchema` Zod schema used by both the server `/health` handler and the
  web `api-client`), proving the cross-package type-sharing seam works from day one.
- **Depends on:** `zod`.

### `apps/server` (Hono)
- **Entry (`index.ts`):** validates env, constructs the app, listens on `:3001`.
- **Router (`router.ts`):**
  - `GET /health` → `HealthResponseSchema`-shaped `{ status: 'ok', service: 'beacon-server', time }`.
  - `POST /internal/users/upsert` → upsert a user from Clerk identity data. Called by the web
    webhook route and by `ensureUserExists()`. Guarded by a shared secret header
    (`INTERNAL_API_SECRET`) so only the web app can call it. (See "web↔server boundary" below.)
- **Env (`lib/env.ts`):** Zod, fail-fast. `DATABASE_URL`, `PORT` (default 3001), `LOG_LEVEL`,
  `WEB_ORIGIN`, `INTERNAL_API_SECRET`.
- **DB (`db/`):** `index.ts` builds a `pg` Pool + Drizzle client. `schema.ts` defines **only**
  the `users` table. `repositories/users.ts` is the **sole** DB access path
  (`getByClerkId`, `upsertFromClerk`) — no raw Drizzle outside repositories (CLAUDE.md invariant).
- **CORS:** allow `WEB_ORIGIN` only. Not exercised by Phase 1's server-to-server `/health` fetch,
  but configured correctly now for Phase 3's browser traffic.

#### `users` table (Drizzle, this phase only)
Mirrors `DATA_MODEL.md`:
```
id            uuid pk default gen_random_uuid()
clerk_user_id text unique not null            -- indexed (unique implies index)
email         text not null
created_at    timestamptz not null default now()
updated_at    timestamptz not null default now()
```
One generated migration in `apps/server/drizzle/`, applied locally. Generated migrations are
committed; never edited after applying.

### `apps/web` (Next.js 15, App Router, TS strict)
- **Auth:** `middleware.ts` uses `clerkMiddleware` to protect `(app)/*`; signed-out users hitting
  `(app)/*` are redirected to sign-in. `(auth)/sign-in` and `(auth)/sign-up` are Clerk catch-all
  routes. Exact Clerk + Next 15 middleware API verified via Context7 before implementation.
- **User sync:**
  - `app/api/clerk/webhook/route.ts` verifies the Svix signature, and on `user.created` /
    `user.updated` calls the server's `/internal/users/upsert`. Returns `200 { ignored: true }`
    for any other event type. Svix verification logic is unit-tested.
  - `lib/ensure-user-exists.ts` is the lazy fallback, invoked from `(app)/layout.tsx`: on each
    authenticated app load, ensure the current Clerk user has a row (idempotent upsert via the
    same server endpoint). Self-heals missed/delayed webhooks (Wayfare/IT pattern).
- **Pages:**
  - `/` — landing: brief Beacon pitch ("Monitor anything you ship — a self-hosted dashboard for
    the services I run") + sign-in CTA. Public.
  - `(app)/services` — dense empty state ("No services yet") with a **disabled** "Add service"
    button. No Card-wrapping-everything; whitespace-as-grouping per CLAUDE.md UI anti-patterns.
  - `/health` (public, top-level — outside the `(app)` group so it's verifiable without signing
    in) — Server Component that fetches the server's `/health` through `api-client` and renders
    "server: ok" (proves cross-process communication).
- **Env (`lib/env.client.ts`):** Zod-validated, `NEXT_PUBLIC_*` only — `NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Server-only secrets (`CLERK_SECRET_KEY`,
  `CLERK_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`) are read in route/server code, never client env.
- **`lib/api-client.ts`:** typed fetch wrapper around `NEXT_PUBLIC_API_URL`; parses responses with
  shared Zod schemas; returns the `{ ok: true, data } | { ok: false, error }` shape across the boundary.
- **Design tokens:** Tailwind config + `globals.css` carry graphite accent `#27272A`, the status
  palette, Geist Sans/Mono, and a `tabular-nums` utility. shadcn primitives installed: Button,
  Card, Input, Label, Sonner.

### `infrastructure/docker-compose.dev.yml`
- Postgres 16, named volume for persistence, port 5432 exposed to host (Drizzle Studio).
- Env (`POSTGRES_USER=beacon`, `POSTGRES_DB=beacon`, password) sourced so `DATABASE_URL` matches.

---

## The web ↔ server boundary (resolved)

CLAUDE.md requires that **Drizzle only lives in `apps/server`** and all DB access goes through its
repositories. The Clerk webhook and `ensureUserExists()` run in the **web** app but need to write a
user row. Resolution: **web calls the server over HTTP** at `POST /internal/users/upsert`, guarded
by an `INTERNAL_API_SECRET` shared-secret header. This keeps the DB-access invariant intact and
avoids importing Drizzle into the web app. Locally, web→server is `http://localhost:3001`.

Rejected alternative: a shared DB action package imported by web — would leak Drizzle/`pg` into the
web runtime and violate the architecture's layering.

---

## Data flow: sign-up → user row

```
1. User signs up via Clerk hosted/embedded UI on apps/web.
2. Clerk fires user.created → POST apps/web /api/clerk/webhook.
3. Webhook verifies Svix signature, extracts { clerkUserId, email },
   calls server POST /internal/users/upsert (with INTERNAL_API_SECRET header).
4. Server upserts via repositories/users.ts → users row exists.
   (Fallback: if the webhook is missed, the next authenticated load of (app)/layout.tsx
    calls ensureUserExists() → same upsert endpoint, idempotent.)
5. Verify: docker compose exec postgres psql -U beacon -d beacon -c 'select * from users;'
```

---

## Environment variables

**Root `.env.example`** — pointer/comment file referencing the two app examples.

**`apps/server/.env.example`**
```
DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon
PORT=3001
LOG_LEVEL=info
WEB_ORIGIN=http://localhost:3000
INTERNAL_API_SECRET=changeme-generate-a-random-string
```

**`apps/web/.env.example`**
```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...
INTERNAL_API_SECRET=changeme-generate-a-random-string   # must match server
```

All env validated by Zod at startup (`apps/server/src/lib/env.ts`, `apps/web/lib/env.client.ts`).
Real values live in gitignored `.env` / `.env.local`. No secrets committed.

---

## Error handling

- **Env:** Zod parse failure → process exits with a readable message (fail fast). No partial boot.
- **Server actions / API boundary:** `{ ok: true, data } | { ok: false, error }`; never throw across
  the boundary. `/internal/users/upsert` returns a problem-shaped error on failure; the webhook still
  returns 200 to Clerk where appropriate to avoid retry storms on non-actionable errors, logging detail.
- **Webhook:** invalid Svix signature → `400`. Unsubscribed event type → `200 { ignored: true }`.
- **`/health` round-trip:** if the server is unreachable, the web health page renders a clear
  "server: unavailable" state rather than throwing (early instance of the "data unavailable" discipline).

---

## Testing strategy (TDD where there's real logic)

Unit-test (Vitest) the pieces with actual behavior:
- Env Zod schemas (valid passes; missing/invalid fails with a useful message).
- `users` repository mapping (Clerk identity → row shape; upsert idempotency) against a test DB
  or a mocked Drizzle client.
- Svix webhook handler: valid signature dispatches upsert; invalid → 400; unsubscribed type →
  `200 { ignored: true }`.

Not unit-tested (verified via acceptance checklist): scaffolding, config, page rendering.

---

## Acceptance criteria (from phase doc)

- [ ] `npm run typecheck` passes from root across all workspaces.
- [ ] `npm run lint` clean across all workspaces.
- [ ] `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres` brings up Postgres.
- [ ] `npm run dev` brings up web (:3000) and server (:3001) together.
- [ ] http://localhost:3000 shows the landing page.
- [ ] Signing up creates a `users` row (verifiable via psql).
- [ ] Signed-out user visiting `/services` is redirected to sign-in.
- [ ] Signed-in user at `/services` sees the empty dashboard.
- [ ] The web `/health` Server Component fetches the server `/health` and shows "server: ok."
- [ ] No secrets in the repo; `.env.example` in both apps.
- [ ] README accurately describes current state.

---

## Out of scope (explicit)

VPS, Caddy, production Docker Compose, GitHub Actions, real domains, WebSockets, integrations,
health-check workers, incidents, alerts, domains table, all non-`users` tables. These belong to
Phases 2–6.

---

## Context7 / library-version checks before coding

Per CLAUDE.md, confirm current docs before non-trivial code against: Next.js 15 (App Router, fonts),
Clerk (`clerkMiddleware`, Next 15 integration, Svix webhook), Drizzle (`pg` driver, config, migrate),
Hono (`@hono/node-server`), Tailwind + shadcn setup. Library surfaces drift; verify rather than
rely on training data.
