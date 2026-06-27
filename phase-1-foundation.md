# Phase 1 — Foundation (Local)

**Goal:** A monorepo with two apps (Next.js web + Hono server) that talk to each other locally, with auth, Postgres in Docker, and basic service CRUD UI scaffolding. **No VPS yet.** Get the local development experience excellent before adding production infrastructure complexity.

**Out of scope this phase:** VPS setup, deploy pipeline, Caddy, real domains, WebSockets, integrations, health checks, alerts. Those come in subsequent phases.

> **Before executing this phase:** let the Superpowers brainstorming/planning skills do their job. This doc is the spec to refine.
>
> **Approval workflow reminder:** pause for my approval before every `git add` / `git commit`. No exceptions.

## Lessons from Wayfare and Investor Thesis to apply

- **Env file split** — `apps/server/src/lib/env.ts` (server) and `apps/web/lib/env.client.ts` (NEXT_PUBLIC_*) from day one.
- **Repository pattern from day one** in `apps/server/src/db/repositories/`.
- **Lazy `ensureUserExists()` fallback** if using Clerk — same pattern that worked in both prior projects.
- **README written for current state**, not for a phase list of "what's coming." Update every phase.
- **`docs/superpowers/` is tracked, not gitignored** — those plans are part of the project record.

## Deliverables

1. Monorepo with npm workspaces: `apps/web`, `apps/server`, `packages/shared`.
2. `apps/web` — Next.js 15 scaffolded with TypeScript strict mode, Tailwind, shadcn/ui (Button, Card, Input, Label, Sonner installed).
3. `apps/server` — Hono server on Node.js with TypeScript strict, returning JSON from a `/health` endpoint.
4. `packages/shared` — workspace for shared Zod schemas. Empty but real (with `package.json`, `tsconfig.json`).
5. Local Postgres via Docker Compose (`infrastructure/docker-compose.dev.yml`). Verifiably running, Drizzle connected.
6. Drizzle ORM in `apps/server`: `users` table only, migration generated and applied locally.
7. Clerk authentication (or DIY auth — decision point in this phase). Sign-in/sign-up pages in `apps/web`. Middleware protecting `(app)/` routes.
8. Clerk webhook handler at `apps/web/app/api/clerk/webhook/route.ts` with Svix verification. Returns `200 { ignored: true }` for unsubscribed event types.
9. `ensureUserExists()` helper invoked from `app/(app)/layout.tsx` for the webhook fallback.
10. Repository pattern set up in `apps/server/src/db/repositories/users.ts`.
11. Env validation split: `apps/server/src/lib/env.ts` AND `apps/web/lib/env.client.ts`, both Zod-validated.
12. `/services` route in `apps/web` renders an empty state ("No services yet") with a disabled "Add service" button.
13. Web → server HTTP call works: `/health` route in web fetches `/health` from server, displays the response. (Proves the two apps communicate over the local network.)
14. Landing page at `/` — brief explanation of Beacon ("Monitor anything you ship — a self-hosted dashboard for the services I run"), CTA to sign in.
15. README that accurately describes current state — what's running locally, how to set up, what's coming. NOT a "phases TODO" list.

## Auth decision point

The Clerk vs. DIY auth question is decided this phase, not punted. Recommended path: **Clerk** — consistent with Wayfare and Investor Thesis, fastest to ship, and the auth layer isn't where this project's differentiation lives. We can revisit and swap for DIY in a future iteration if we want to lean harder into "no-SaaS" — but for v1, Clerk it is.

If the Superpowers brainstorming surfaces good reasons to do DIY auth instead, that's the moment to discuss it. Don't decide silently.

## Folder structure to create

```
.
├── CLAUDE.md
├── README.md
├── package.json                 (monorepo root, workspaces config)
├── tsconfig.base.json           (shared TS config)
├── .gitignore
├── .env.example                 (root example, references per-workspace examples)
├── infrastructure/
│   ├── docker-compose.dev.yml   (Postgres for local dev)
│   └── ... (other infra files come in Phase 2)
├── docs/
│   ├── CLAUDE.md ... (existing docs)
│   └── phases/
│       ├── phase-1-foundation.md
│       ├── phase-2-vps-and-deploy.md
│       ├── phase-3-health-checks-and-realtime.md
│       ├── phase-4-integrations.md
│       ├── phase-5-incidents-and-alerts.md
│       └── phase-6-polish.md
├── apps/
│   ├── web/                     (Next.js)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── middleware.ts
│   │   ├── .env.example
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx           (landing)
│   │   │   ├── globals.css
│   │   │   ├── (auth)/
│   │   │   │   ├── sign-in/[[...sign-in]]/page.tsx
│   │   │   │   └── sign-up/[[...sign-up]]/page.tsx
│   │   │   ├── (app)/
│   │   │   │   ├── layout.tsx
│   │   │   │   └── services/page.tsx
│   │   │   └── api/
│   │   │       └── clerk/webhook/route.ts
│   │   ├── components/ui/         (shadcn)
│   │   └── lib/
│   │       ├── env.client.ts
│   │       └── api-client.ts      (typed fetch wrapper for hitting the server app)
│   └── server/                  (Hono)
│       ├── package.json
│       ├── tsconfig.json
│       ├── drizzle.config.ts
│       ├── .env.example
│       ├── src/
│       │   ├── index.ts           (Hono entry, listens on :3001)
│       │   ├── router.ts
│       │   ├── lib/
│       │   │   └── env.ts
│       │   └── db/
│       │       ├── index.ts
│       │       ├── schema.ts
│       │       └── repositories/
│       │           └── users.ts
│       └── drizzle/             (migrations)
└── packages/
    └── shared/
        ├── package.json
        ├── tsconfig.json
        └── src/
            └── index.ts         (exports — start empty, will hold shared Zod)
```

## Key implementation details to confirm during planning

- **Workspaces:** npm workspaces (default). If Claude Code argues for pnpm convincingly (faster installs, stricter linking), discuss — but npm is simpler for portfolio purposes.
- **Project name in root package.json:** `beacon`.
- **Hono runtime:** Node.js, not Bun (in v1). Bun is tempting but Node is the safe choice for a project where I'll be running on a stock VPS. We can switch later if I want to make a Bun-vs-Node story part of the portfolio.
- **Local server port:** Hono on 3001, Next.js on 3000.
- **Local Postgres port:** 5432 inside Docker, exposed to host so Drizzle Studio works.
- **Branch:** start on `phase-1-foundation`, merge into `main` at phase end.

## Acceptance criteria

- [ ] `npm run typecheck` passes from the root, across all workspaces.
- [ ] `npm run lint` clean across all workspaces.
- [ ] `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres` brings up Postgres successfully.
- [ ] `npm run dev` in the root brings up both `apps/web` (on :3000) and `apps/server` (on :3001).
- [ ] Visiting http://localhost:3000 shows the landing page.
- [ ] Signing up creates a User row in Postgres (verifiable via `docker compose exec postgres psql -U beacon -d beacon -c 'select * from users;'`).
- [ ] Signed-out user visiting `/services` is redirected to sign-in.
- [ ] Signed-in user at `/services` sees the empty dashboard.
- [ ] The `/health` Server Component on the web app successfully fetches from the server's `/health` endpoint and displays "server: ok."
- [ ] No secrets in the repo. `.env.example` files in both `apps/web` and `apps/server`.
- [ ] README accurately describes current state.

## Definition of done

The local development experience is excellent. I can clone the repo, run `npm install && docker compose up -d postgres && npm run dev`, and have a working two-process system with auth in under 5 minutes. **No VPS work yet** — that's Phase 2.

---

> **Next phase (preview, not now):** Phase 2 = VPS setup + production deploy pipeline. Provisions the DigitalOcean Droplet, configures Caddy + Docker Compose for production, sets up GitHub Actions CI/CD, deploys what we built in Phase 1 to the real URL. This is the most infrastructure-heavy phase and will probably take longer than a single weekend — plan for two.
