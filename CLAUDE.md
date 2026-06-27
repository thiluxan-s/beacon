# Beacon

> **Read these documents in order before starting any task:**
> 1. This file (project context, conventions, principles, workflow)
> 2. `docs/PRD.md` (what we're building and why)
> 3. `docs/ARCHITECTURE.md` (how it fits together — especially the Integration Layer section)
> 4. `docs/INFRASTRUCTURE.md` (VPS setup, deploy pipeline, networking — this is a first-class doc on this project, not a footnote)
> 5. `docs/DATA_MODEL.md` (database schema and the reasoning)
> 6. `docs/DESIGN.md` (visual design — required reading before any UI work)
> 7. The current phase doc in `docs/phases/`
>
> If anything in a phase doc contradicts this file, **stop and ask** — don't reconcile silently.

---

## Working with this codebase

When Superpowers skills activate (brainstorming, planning, TDD, debugging, verification), follow them. They are the workflow. This document gives you the *context* those skills consume — not a replacement for them.

Use Context7 to pull current docs for any library before writing non-trivial code against it (Drizzle, Hono, ws, Tailwind, Caddy config, Docker Compose syntax). Library and tool surfaces drift; training-data knowledge of them does not age well.

Use the frontend-design skill for any UI work — not just polish passes. Invoke it on every screen, every component, every page. The skill encodes design tokens, spacing, typography, and aesthetic guardrails that beat what either of us would invent from scratch.

If a plugin skill and this document conflict on *process* (when to test, how to plan, how to debug), the plugin wins. If they conflict on *project context* (what we're building, the tech stack, the conventions, the data model, the deploy story), this document wins — flag the contradiction so we can update whichever is wrong.

## Approval workflow — REQUIRED

Same rule as Investor Thesis. Before staging or committing any code:

1. Summarize the change in 1-3 sentences: what you changed, why, and the most important thing for me to look at.
2. Show me the relevant diffs (or describe them clearly if they're large).
3. **Wait for my explicit approval** before running `git add` or `git commit`.
4. If I push back, address the feedback and re-summarize.

No exceptions for "small" changes. This is especially important on this project because infrastructure mistakes compound — a bad reverse proxy config or firewall rule can take the server offline, and rolling back is more painful than rolling back a code change.

## What this is

Beacon is a portfolio project: a real-time monitoring dashboard for the services I run, self-hosted on my own VPS, accessed at my own domain. It watches my deployed projects (Wayfare, Investor Thesis, my portfolio site), my domains, and — designed for extension — any future services I take on, including client projects on platforms other than Vercel.

The product is platform-agnostic by design. "What does this monitor?" → "Anything with an HTTP endpoint, plus deeper insight where I've configured an integration (Vercel, GitHub today; Railway, Fly, AWS, custom webhooks tomorrow)."

The audience is hiring managers reviewing my portfolio. The demo lands in under 90 seconds: a recruiter sees a real-time dashboard with real services I run, watches a status update happen live, clicks into an incident timeline, understands the value. The demo URL is my actual production dashboard — not a sandbox.

This is the systems-engineering complement to my two prior projects. Wayfare and Investor Thesis are both Next.js + Vercel + serverless. Beacon is deliberately *different*: a long-running Node/Bun server, WebSockets, self-hosted on DigitalOcean, with a real deploy pipeline. The contrast is intentional.

## Who I am

I'm Thiluxan, a full-stack developer with 3 years on a production React/TypeScript/Vite EMR (CLO) on AWS, plus two shipped portfolio projects:
- Wayfare (https://github.com/thiluxan-s/TravelApp) — travel "second brain" with one-shot AI extraction from PDFs
- Investor Thesis (link TBD) — investment thesis tracker with agentic AI

I'm building this with Claude Code on weekends. I value:

- **Minimal targeted changes.** Follow existing patterns. Don't refactor things that aren't part of the task.
- **Understanding the reasoning** behind every change. Explain *why* in one sentence so I can learn from it.
- **Running typecheck before committing.** No exceptions.
- **Treating infrastructure as code.** Every server-side decision should be reproducible from this repo. If a change can't be expressed as a config file or a script, push back on the change.

## Tech stack — locked in

These are decided. Don't propose swaps without asking.

### Application layer
- **Backend:** Node.js + Hono (long-running HTTP + WebSocket server). NOT serverless functions.
- **Frontend:** Next.js 15 (App Router) + TypeScript strict — served from the same VPS, behind the same reverse proxy.
- **WebSockets:** Native `ws` library (small, well-maintained, no Socket.io magic). Connection state managed in-process.
- **Database:** Postgres (self-hosted on the VPS via Docker, or managed Neon — decision in Phase 1).
- **ORM:** Drizzle.
- **Styling:** Tailwind + shadcn/ui.
- **Auth:** Single-user. Either Clerk OR a simple session-cookie-with-bcrypt-password (decision in Phase 1; leaning toward Clerk for consistency).
- **Validation:** Zod everywhere.

### Infrastructure layer
- **VPS:** DigitalOcean Droplet (smallest reasonable size — likely $6-12/mo).
- **OS:** Ubuntu 24.04 LTS.
- **Reverse proxy + SSL:** Caddy 2 (auto-Let's Encrypt; way simpler than Nginx for this use case).
- **Containerization:** Docker Compose for the app + Postgres + any sidecars.
- **Deploy:** GitHub Actions → SSH-based rsync or `docker compose pull && up` strategy. No external deploy platform.
- **Firewall:** ufw (only 22/80/443 open; SSH key auth only, no passwords).
- **DNS:** Cloudflare (free tier, sits in front of the VPS).
- **Monitoring of the monitor:** UptimeRobot free tier as the external watcher of Beacon itself. (Because the monitor can't reliably alert on its own downtime.)

### Deliberately not in the stack and not to be proposed
- **Vercel** (the whole point of this project is to NOT be on Vercel).
- **AWS** (CLO-adjacent, would muddy the "self-hosted indie" story).
- **Kubernetes** (way overkill for one server).
- **Inngest / hosted background job services** (background workers are just processes on the VPS).
- **Redis** (don't reach for it until we have a measured reason).
- **Socket.io** (we want native WebSockets, not the abstraction).
- **Any frontend state library** (Redux, Zustand, MobX) — Server Components own state.

## Conventions

### TypeScript
- `strict: true` in tsconfig. No `any`. Use `unknown` and narrow when needed.
- Prefer `type` over `interface` unless declaration merging is needed.
- Zod schemas are source of truth — derive types with `z.infer<typeof Schema>`.
- DB types derive from Drizzle schema via `$inferSelect` / `$inferInsert`.

### File structure

```
apps/
  web/                       # Next.js frontend
    app/
      (auth)/
      (app)/
        services/
        services/[serviceId]/
        incidents/
        settings/
      api/                   # only for things that absolutely need server-side handlers
    components/
      ui/
      services/
      incidents/
    lib/                     # frontend-only utilities (hooks, formatters)
  server/                    # Hono backend
    src/
      index.ts               # entry point
      router.ts              # HTTP routes
      ws/                    # WebSocket handlers
      workers/               # background check workers
      integrations/          # Vercel, GitHub, etc.
      db/
        schema.ts
        repositories/
      lib/
        env.ts
        crypto.ts            # for encrypted integration credentials
packages/
  shared/                    # types and zod schemas shared between web and server
    schemas/
infrastructure/
  docker-compose.yml         # production compose file
  docker-compose.dev.yml     # local dev overrides
  Caddyfile                  # reverse proxy config
  deploy/
    deploy.sh                # invoked by CI
docs/
  PRD.md
  ARCHITECTURE.md
  INFRASTRUCTURE.md
  DATA_MODEL.md
  DESIGN.md
  KICKOFF_PROMPT.md
  superpowers/               # created by Superpowers
  phases/
```

This is a monorepo. Use npm workspaces (or pnpm if Claude Code argues for it convincingly — verify via Context7).

### Imports
- Absolute imports via `@/` within each package.
- Cross-package imports via `@beacon/shared` etc.
- External → workspace → relative, blank line between groups.

### Naming
- Components: `PascalCase.tsx`.
- Hooks: `useCamelCase.ts`.
- Utilities: `kebab-case.ts` for files, `camelCase` for exports.
- DB tables: `snake_case`.
- Zod schemas: `SomethingSchema`; type as `Something`.

### Server vs client (web app)
- Default to Server Components. `"use client"` only when state, effects, or browser APIs are genuinely needed.
- Mutations through Server Actions where possible. WebSocket-driven mutations live in client components with hooks.
- The frontend talks to the backend over HTTP for reads (Server Components fetching from the API), and over WebSockets for real-time updates (client components subscribing to status changes).

### Error handling
- Server Actions return `{ ok: true, data } | { ok: false, error }` — never throw across the boundary.
- HTTP API endpoints return RFC 7807-style problem details on error. Consistent shape across the API.
- WebSocket messages are typed: `{ type: 'service.status_changed', payload: { ... } }`. Define every message shape in `packages/shared/schemas/ws.ts`.
- Background workers should never crash the process on a single check failure. Catch, log, mark the check as failed, continue.

### Database
- All schema changes through Drizzle migrations. Never edit migrations after applied.
- Every table has `id`, `created_at`, `updated_at`.
- Cascade deletes for owned relationships.
- All queries through `lib/db/repositories/`. No raw Drizzle in routes, workers, or components.
- **Database lives on the same VPS** (or as Neon-managed — decided in Phase 1). Either way, the *app* must be resilient to brief DB outages — if Postgres is restarting, the dashboard should show a "data unavailable, retrying" state, not crash.

### Integrations (the central abstraction of this project)

Read the Architecture doc's Integration Layer section for the full design. Key conventions:

- Each integration is a class implementing the `MonitoringIntegration` interface in `apps/server/src/integrations/types.ts`.
- One file per integration: `apps/server/src/integrations/vercel.ts`, `github.ts`, etc.
- Integrations register themselves in a central `IntegrationRegistry` at startup.
- Adding a new integration in the future is **always** a "drop a new file + register it" operation. If a new integration requires changing core code outside `integrations/`, the abstraction is wrong — pause and reconsider.
- Credentials for integrations are encrypted at rest using a server-side master key. Never logged. Never returned to the client in full (only metadata like "this integration is configured").

### WebSocket conventions
- One persistent connection per client. Multiplex topic subscriptions over it ("subscribe me to service X's status").
- Reconnection logic on the client with exponential backoff and resubscription.
- Server-side: track connections, fan out events to subscribed clients, clean up on disconnect.
- Heartbeat ping every 30s. If a client misses 2 heartbeats, drop them.
- Don't trust client message origin — every subscription request goes through auth check.

### Environment variables
- All env vars validated by Zod at startup.
- Backend env in `apps/server/src/lib/env.ts`.
- Frontend env in `apps/web/lib/env.client.ts` (only `NEXT_PUBLIC_*` vars).
- `.env.example` committed for each app. `.env.local` and `.env.production` gitignored.

### Git
- Branch per phase: `phase-1-foundation`, `phase-2-vps-setup`, etc.
- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `infra:`).
- **Pause for my approval before every `git add` / `git commit`.**
- I handle PRs and merges into `main` at phase boundaries.

## Anti-patterns — don't do these

### General
- **Don't reach for `useEffect`** to fetch initial data — Server Components or Server Actions.
- **Don't store dates as strings.** `timestamptz` always. Server clocks in UTC.
- **Don't suppress TypeScript errors silently.** Comment if you must `@ts-expect-error`.
- **Don't add dependencies without asking.** Especially anything that overlaps with what we use.
- **Don't write tests retroactively for coverage.** Tests come from the TDD skill during implementation.
- **Don't generate placeholder data and ship it.** Real data flow or honest empty states.

### Systems-specific
- **Don't put secrets in the repo.** Even gitignored `.env` files should never accidentally land in a commit. Use `.env.example` with placeholders, real values in untracked files or VPS environment.
- **Don't ship infrastructure changes without a rollback plan.** Every `docker-compose.yml` change, every `Caddyfile` change, every deploy script change needs a "how do I undo this without SSH" answer.
- **Don't bypass the integration interface.** If you need data from Vercel anywhere in the app, it goes through `integrations/vercel.ts`. No ad-hoc Vercel API calls scattered across the codebase.
- **Don't poll where you can push.** If the backend already has the data via webhook or scheduled check, push it over WebSockets instead of having the frontend poll the API.
- **Don't run background work in the request lifecycle.** If a check takes >100ms, it's a worker, not an HTTP handler.
- **Don't expose internal state in error messages to clients.** "Database query failed" → client sees "Could not load services right now." Logs get the full detail.

### UI anti-patterns
- **Default shadcn Card wrapping everything.** Many surfaces should be flat. The dashboard especially benefits from density.
- **Centered narrow columns everywhere.** This is a dashboard. Use the full viewport. Sidebars, multi-column layouts, asymmetric grids.
- **Single font weight across the entire app.** Weight contrast deliberately.
- **Gray borders everywhere.** Whitespace is the primary grouping mechanism.
- **Spinners as default loading state.** Skeletons matching the layout that's coming.
- **`"use client"` at the top of files that don't need it.** Server Components feel snappier; the perceived performance is part of the visual quality.

## Frontend quality bar

Same bar as Investor Thesis. The visual quality bar for Beacon is **Linear, Vercel's dashboard, Plain, and Cron's dashboard.** Information-dense surfaces done well. Not "looks like a Tailwind admin template."

After implementing a new screen or significant UI component, run a **design pass** before moving on:
1. Re-engage the frontend-design skill.
2. Look at the current state honestly.
3. Ask: "Would this be at home in Linear's product, or Plain's, or Vercel's?"
4. If not, what's the gap?

Document meaningful design decisions in `docs/DESIGN.md` as they're made.

The highest-leverage screens on this project are:
- The **main dashboard** (all services at a glance — the screenshot that goes on the README).
- The **service detail view** with live status updates streaming in via WebSockets.
- The **incident timeline** view (the wow moment that shows the system is doing real work).

Spend extra time on these.

## When you're unsure

Ask one focused question rather than guessing. I'd rather answer a clarifying question now than untangle a wrong direction later. If you're stuck between two reasonable options, present them as A/B with trade-offs.

## Cost awareness

Unlike Wayfare and Investor Thesis (free-tier infrastructure), Beacon will have real monthly costs:
- DigitalOcean Droplet: ~$6-12/mo
- Domain (already owned)
- Cloudflare: free
- UptimeRobot: free
- Anthropic API: N/A (this project deliberately has no AI in v1)
- Total: ~$10/mo

This is fine and worth flagging in the README — "this project has real infrastructure costs because it's deliberately not serverless." It's a feature, not a flaw.

## What "done" looks like for any task

1. `npm run typecheck` passes (both apps).
2. `npm run lint` clean (both apps).
3. Happy path works end-to-end manually (or via test).
4. At least one failure case handled.
5. New env vars added to `.env.example` and the relevant `env.ts`.
6. If schema changed: migration generated and applied (locally and to production via deploy script).
7. If infrastructure changed: `INFRASTRUCTURE.md` updated to reflect the change.
8. A clear commit message explaining *why*.
9. **I've approved the change before you committed.**
