# README Rewrite — Design Spec

**Date:** 2026-07-10
**Type:** Documentation (the headline deliverable of Phase 6 — "Polish, Demo, Ship")

## Goal

Rewrite the root `README.md` so it accurately reflects the finished product and sells the **infrastructure story** — the deliberate choice to build a long-running, self-hosted system instead of another serverless app. The current README is stale (its Status section claims Phases 3–6 are "not built yet" when real-time checks, integrations, incidents/alerts, and the public demo are all live and shipped), which actively undersells the project to anyone who lands on the repo.

## Audience & voice

- **Audience:** hiring managers / senior engineers reviewing a portfolio. They skim first, then read the parts that signal depth.
- **Voice:** a senior engineer's technical writing — opinionated, defended, trade-offs acknowledged. Avoid "I used X because it's modern"; instead "I used X because Y constraint mattered more than Z." (Per CLAUDE.md + PRD.)
- **Length:** comprehensive but scannable. The Infrastructure decisions section is the meatiest; everything else is tight.

## Framing decisions (approved)

1. **Link out, don't duplicate.** The README is punchy and centered on the infra story; it links to the existing deep docs (`docs/ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`, `docs/DATA_MODEL.md`, `docs/DESIGN.md`) for detail rather than restating them.
2. **Drop the phase-by-phase "Status" build-log** in favor of a "what it does today" feature framing. The phased journey stays in `docs/phases/` for anyone curious.

## Visual assets (approved scope)

Prose is fully written this pass; **visuals are placeholders**. Screenshots (dashboard, service detail, incident timeline, integration card), the custom architecture diagram, and the demo video are separate deliverables produced later and dropped into the marked slots. Use a consistent, greppable placeholder convention, e.g.:

```markdown
<!-- SCREENSHOT: main dashboard — all services at a glance -->
> _📷 Screenshot coming soon._
```

so every slot is easy to find and fill later.

## Section outline & content

1. **Hero.** One-line what-it-is; the "deliberately not serverless" hook; live demo link (`https://beacon.thiluxan.com/demo` — real production dashboard, read-only, no login); one-line stack summary. `[hero dashboard screenshot placeholder]`
2. **Live demo.** Short callout linking `/demo`; note it's the real production dashboard streaming live over WebSockets, read-only.
3. **What it does.** Tight feature list (each one line):
   - Real-time HTTP health checks — configurable interval, expected status codes, timeout.
   - Live status over WebSockets — per-service topic subscriptions, in-process fan-out.
   - Incident timelines — auto-open after N consecutive failures, observation events, auto-resolve on recovery.
   - Email alerts (Resend) — global + per-service toggles.
   - Domain monitoring — DNS, SSL-cert expiry, and registration expiry (RDAP).
   - Pluggable integrations — Vercel & GitHub today, via a drop-in registry.
   - Public read-only demo mode — anonymous, opt-in-per-entity, live.
   - Single-user auth (Clerk).
4. **Why this exists.** The systems-engineering-counterpart story: contrast with the two prior serverless Vercel projects (Wayfare, Investor Thesis); Beacon is deliberately a long-running Node server + WebSockets + self-hosted Postgres + real deploy pipeline on an owned box.
5. **Architecture.** Short prose on the three processes (web, API server, workers) + Postgres, the WebSocket fan-out, and the Integration Layer seam. `[architecture diagram placeholder]`. Link `docs/ARCHITECTURE.md`.
6. **Infrastructure decisions** ⭐ *centerpiece, meatiest section.* Each as an opinionated, defended trade-off (source: PRD "Key decisions" + CLAUDE.md "deliberately not in the stack"):
   - VPS over serverless (Vercel can't do long-running WS; "monitor Vercel from Vercel" is circular).
   - DigitalOcean specifically (familiar, documented, trial credit; not AWS — muddies the indie story; not Render/Railway — defeats self-hosted point).
   - Long-running Hono server over Next.js API routes (persistent WS connections; independent restart of API vs frontend).
   - Caddy over Nginx (auto Let's Encrypt, far simpler config for this use).
   - Docker Compose over Kubernetes (one box; k8s is overkill).
   - Self-hosted Postgres on the same box (app resilient to brief DB outages; no managed dependency).
   - Native `ws` over Socket.io (no abstraction we don't need).
   - No Redis until a measured reason; no AI in v1 (this project demonstrates systems engineering, not another AI feature).
   - Namecheap plain A records, no proxy in front (Caddy terminates TLS directly).
7. **Adding an integration.** Show the architectural seam: one file per integration implementing `IntegrationDefinition`, registered with a single map entry in `registry.ts` — adding one is always "drop a file + register it," never a change to core code. Tiny code sketch. Link the ARCHITECTURE Integration Layer section.
8. **Tech stack table.** Backend (Node + Hono), Frontend (Next.js 16 App Router + TS strict), Realtime (native `ws`), DB (Postgres + Drizzle), Styling (Tailwind + shadcn/ui), Auth (Clerk), Validation (Zod), Proxy (Caddy 2), Containers (Docker Compose), Host (DigitalOcean Ubuntu 24.04), CI/CD (GitHub Actions → ghcr → SSH deploy).
9. **Deploy pipeline.** One paragraph: push-to-main → GitHub Actions (typecheck/lint/test) → build + push both images to ghcr → SSH deploy via `deploy.sh` (pull images, run migrations, `compose up`, health-verify both hosts, roll back on failure). Link `docs/INFRASTRUCTURE.md`.
10. **Screenshots.** Gallery of placeholders: `[service detail]`, `[incident timeline]`, `[integration card]`.
11. **Roadmap (v2).** From the PRD v2 list (additional platform integrations, SSH container monitoring, anomaly detection, push/Slack alerts, status pages, multi-user, cost monitoring, synthetic transactions, AI weekly reports) — condensed, framed as "explicitly not in v1."
12. **Cost ledger.** Framed as a feature, not a flaw: **~$12/mo** — DigitalOcean `s-1vcpu-2gb` droplet ($12/mo); domain already owned (~$12/yr amortized); DNS (Namecheap), TLS (Caddy/Let's Encrypt), and external uptime check (UptimeRobot) all free; no AI/API spend. "This is deliberately not a free-tier portfolio piece."
13. **Run it locally.** Compact quickstart: clone, `npm install`, copy `.env.example`s, `docker compose -f infrastructure/docker-compose.dev.yml up -d` for Postgres, `npm run db:migrate`, `npm run dev`. Link the docs for full detail. Signals it's a real, runnable project.

## Out of scope (this task)

- Capturing screenshots, drawing the architecture diagram, recording the demo video (separate deliverables; slots are placeholdered).
- Any code or app changes. This is a docs-only change to `README.md`.
- Other Phase 6 items (mobile pass, a11y, OG image/favicon, security review, portfolio-site update).

## Success criteria

- No stale claims: the README reflects what's actually shipped and live.
- A developer reading for ~10 minutes understands the system (per PRD success criterion #2).
- The Infrastructure decisions section reads like defended senior-engineer writing and is clearly the differentiator (PRD #3).
- Every visual slot is a consistent, greppable placeholder.
- Links to deep docs resolve; no duplicated prose.
