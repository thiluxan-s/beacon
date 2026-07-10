# README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the root `README.md` so it accurately reflects the shipped product and sells the infrastructure story, per `docs/superpowers/specs/2026-07-10-readme-rewrite-design.md`.

**Architecture:** A single prose file, rewritten wholesale and built top-down. This is a documentation task, so the usual TDD loop is adapted: each task's "tests" are concrete doc checks — greppable placeholders present, local doc links resolve, no stale phase-status claims, factual data exact. Each task appends one coherent group of sections and commits.

**Tech Stack:** Markdown. No code or app changes.

## Global Constraints

- **Docs-only.** The only file changed is `README.md`. No app/code/config changes.
- **Branch:** work on `docs-readme-rewrite` off `main` (the human merges via PR).
- **Voice:** senior-engineer technical writing — opinionated, trade-offs acknowledged; never "I used X because it's modern." (CLAUDE.md + PRD.)
- **Link out, don't duplicate.** Link to `docs/ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`, `docs/DATA_MODEL.md`, `docs/DESIGN.md` for depth rather than restating them.
- **No stale claims.** Do not describe any shipped capability (real-time checks, integrations, incidents/alerts, domains, public demo) as unbuilt. The final README must contain **zero** "not built yet / Phase N — not built" status language.
- **Placeholder convention** for every visual slot, greppable and consistent:
  ```markdown
  <!-- SCREENSHOT: <what it shows> -->
  > _📷 Screenshot coming soon._
  ```
  (Architecture diagram uses `<!-- DIAGRAM: ... -->` + the same "coming soon" line.)
- **Verbatim facts** (use exactly): live demo `https://beacon.thiluxan.com/demo`; production URL `https://beacon.thiluxan.com`; cost `~$12/mo` (DO `s-1vcpu-2gb` droplet $12/mo; domain owned, ~$12/yr amortized; DNS/TLS/UptimeRobot free; no AI spend); Node `22`; prior projects Wayfare + Investor Thesis.

---

## Task 1: Top-of-fold — Hero, Live demo, What it does

**Files:**
- Modify (overwrite): `README.md`

**Interfaces:**
- Produces: `README.md` sections `# Beacon` (hero), `## Live demo`, `## What it does`.

- [ ] **Step 1: Create the branch**

Run: `git checkout -b docs-readme-rewrite`

- [ ] **Step 2: Write the hero + live demo + feature list**

Overwrite `README.md` starting from the top. Include, in order:

**Hero** (`# Beacon` + one-paragraph pitch + the hook). Must convey: a real-time monitoring dashboard for the services/domains I run, self-hosted on my own VPS at my own domain; watches anything with an HTTP endpoint plus deeper insight where an integration is configured; the systems-engineering counterpart to two prior serverless projects. Keep the existing "deliberately not serverless" blockquote hook (real ~$12/mo cost is the point, not a flaw). Add the hero screenshot placeholder:
```markdown
<!-- SCREENSHOT: main dashboard — all services at a glance, live status dots -->
> _📷 Screenshot coming soon._
```

**`## Live demo`** — link `https://beacon.thiluxan.com/demo`; state it's the **real production dashboard**, read-only, no login, streaming live over WebSockets.

**`## What it does`** — a tight bullet list, one line each (source: spec §3):
- Real-time HTTP health checks — configurable interval, expected status codes, timeout.
- Live status over WebSockets — per-service topic subscriptions, in-process fan-out.
- Incident timelines — auto-open after consecutive failures, observation events, auto-resolve on recovery.
- Email alerts (Resend) — global + per-service toggles.
- Domain monitoring — DNS, SSL-certificate expiry, and registration expiry (RDAP).
- Pluggable integrations — Vercel & GitHub today, via a drop-in registry.
- Public read-only demo mode — anonymous, opt-in per entity, live.
- Single-user auth (Clerk).

- [ ] **Step 3: Verify no stale status language and placeholder present**

Run: `grep -niE "not built|phase [0-9].*(complete|live|not)" README.md`
Expected: no matches (no stale phase build-log language).
Run: `grep -c "Screenshot coming soon" README.md`
Expected: `1` (the hero slot).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): hero, live demo, and feature list"
```

---

## Task 2: Why this exists + Architecture

**Files:**
- Modify (append): `README.md`

**Interfaces:**
- Consumes: `README.md` from Task 1.
- Produces: `## Why this exists`, `## Architecture` sections.

- [ ] **Step 1: Append the two sections**

**`## Why this exists`** — the systems-engineering-counterpart narrative: my two prior portfolio projects (Wayfare, Investor Thesis) are Next.js-on-Vercel serverless; Beacon is deliberately the opposite — a long-running Node server, native WebSockets, self-hosted Postgres, a real deploy pipeline on a box I own. The contrast is the point. (Source: spec §4, PRD.)

**`## Architecture`** — 1–2 short paragraphs: three long-running processes (Next.js `web`, Hono API `server`, background `worker`) + Postgres, on one VPS behind Caddy; status changes are pushed from workers to browsers over a WebSocket fan-out (per-service topics); integrations are a registry of drop-in modules. Then the diagram placeholder and a link out:
```markdown
<!-- DIAGRAM: VPS + Docker network — caddy, web, server, worker, postgres; external Vercel/GitHub APIs; WS + data-flow arrows -->
> _📐 Architecture diagram coming soon._

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, including the WebSocket layer and Integration Layer.
```

- [ ] **Step 2: Verify the doc link resolves**

Run: `test -f docs/ARCHITECTURE.md && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): why-this-exists + architecture overview"
```

---

## Task 3: Infrastructure decisions (centerpiece)

**Files:**
- Modify (append): `README.md`

**Interfaces:**
- Consumes: `README.md` from Task 2.
- Produces: `## Infrastructure decisions` section.

- [ ] **Step 1: Append the centerpiece section**

**`## Infrastructure decisions`** — the meatiest section. Open with one line framing this as the differentiator. Then each decision as its own short subsection or bolded bullet: **the choice → the constraint that drove it → the trade-off acknowledged.** Cover all of these (sources: PRD "Key decisions", CLAUDE.md "deliberately not in the stack", INFRASTRUCTURE.md):

- **VPS over serverless** — Vercel can't cleanly host a long-running WebSocket server; "monitor Vercel from a Vercel deployment" is circular. A Droplet with Docker is a real infra story.
- **DigitalOcean specifically** — familiar, well-documented, trial credit; not AWS (muddies the indie self-hosted narrative), not Render/Railway (defeats the self-hosted point). Hetzner slightly cheaper; DO won on familiarity.
- **A long-running Hono server, not Next.js API routes** — persistent WS connections need a persistent process; separating the API also lets it restart independently of the frontend.
- **Caddy over Nginx** — automatic Let's Encrypt TLS and a far simpler config for a single-box reverse proxy.
- **Docker Compose over Kubernetes** — one box; k8s is overkill and would be résumé-driven, not problem-driven.
- **Self-hosted Postgres on the same box** — no managed dependency; the app degrades gracefully during brief DB restarts rather than hard-failing.
- **Native `ws` over Socket.io** — we want plain WebSockets, not an abstraction and its reconnect/transport magic we don't need.
- **No Redis, no AI in v1** — Redis only when a measured reason appears; AI deliberately omitted so this project signals systems engineering, not another AI feature.
- **Namecheap plain A records, no proxy in front** — Caddy terminates TLS directly; no Cloudflare proxy layer.

Keep each entry 2–4 sentences. Link `[`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md)` at the end for the full setup.

- [ ] **Step 2: Verify coverage + link**

Run: `grep -ciE "serverless|caddy|kubernetes|postgres|socket\.io|digitalocean" README.md`
Expected: `>= 6` (all major decisions present).
Run: `test -f docs/INFRASTRUCTURE.md && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): infrastructure decisions (the centerpiece)"
```

---

## Task 4: Adding an integration + Tech stack + Deploy pipeline

**Files:**
- Modify (append): `README.md`

**Interfaces:**
- Consumes: `README.md` from Task 3.
- Produces: `## Adding an integration`, `## Tech stack`, `## Deploy pipeline` sections.

- [ ] **Step 1: Append "Adding an integration"**

**`## Adding an integration`** — show the architectural seam: every integration is one file implementing the `IntegrationDefinition` interface (`apps/server/src/integrations/types.ts`), registered with a single map entry in `apps/server/src/integrations/registry.ts`. Adding one is always "drop a file + register it" — never a change to core code (if it required core changes, the abstraction would be wrong). Include a small illustrative sketch and link the ARCHITECTURE Integration Layer section:
```markdown
`apps/server/src/integrations/vercel.ts` implements the interface; `registry.ts` registers it:

​```ts
// apps/server/src/integrations/registry.ts
export const IntegrationRegistry = new Map([
  [vercel.id, vercel],
  [github.id, github],
  // add a new integration here — that's the whole wiring change
]);
​```
```
(Confirm the real shape of `registry.ts` while drafting and match it; don't invent an API.)

- [ ] **Step 2: Append the tech stack table**

**`## Tech stack`** — a markdown table (source: spec §8, CLAUDE.md locked stack):

| Layer | Choice |
|-------|--------|
| Backend | Node.js + Hono (long-running HTTP + WS) |
| Frontend | Next.js 16 (App Router) + TypeScript strict |
| Realtime | Native `ws` |
| Database | Postgres + Drizzle ORM |
| Styling | Tailwind + shadcn/ui |
| Auth | Clerk (single-user) |
| Validation | Zod |
| Reverse proxy / TLS | Caddy 2 (auto Let's Encrypt) |
| Containers | Docker Compose |
| Host | DigitalOcean Droplet, Ubuntu 24.04 |
| CI/CD | GitHub Actions → ghcr → SSH deploy |

- [ ] **Step 3: Append the deploy pipeline paragraph**

**`## Deploy pipeline`** — one paragraph: push to `main` → GitHub Actions runs typecheck/lint/tests → builds and pushes both images (`web`, `server`) to ghcr → deploys over SSH via `infrastructure/deploy/deploy.sh`, which pulls images, runs migrations, `docker compose up`, health-verifies both hosts, and rolls back on failure. Link `[`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md)`.

- [ ] **Step 4: Verify**

Run: `test -f apps/server/src/integrations/registry.ts && test -f apps/server/src/integrations/types.ts && echo OK`
Expected: `OK` (the referenced seam files exist).
Run: `grep -c "| " README.md`
Expected: `>= 11` (stack table rows present).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): integration seam, tech stack table, deploy pipeline"
```

---

## Task 5: Screenshots + Roadmap + Cost ledger + Run it locally

**Files:**
- Modify (append): `README.md`

**Interfaces:**
- Consumes: `README.md` from Task 4.
- Produces: `## Screenshots`, `## Roadmap`, `## Cost`, `## Run it locally` sections.

- [ ] **Step 1: Append the screenshots gallery (placeholders)**

**`## Screenshots`** — three placeholder slots:
```markdown
<!-- SCREENSHOT: service detail — live status stream + recent checks -->
> _📷 Screenshot coming soon._

<!-- SCREENSHOT: incident timeline — opened → observed → resolved -->
> _📷 Screenshot coming soon._

<!-- SCREENSHOT: integration card — Vercel/GitHub snapshot on a service -->
> _📷 Screenshot coming soon._
```

- [ ] **Step 2: Append the roadmap**

**`## Roadmap`** — condensed v2 list, framed "explicitly not in v1" (source: PRD v2): more platform integrations (Railway, Fly, Render, AWS, custom webhooks), SSH-based container monitoring, anomaly detection, push/Slack/Discord alerts, public status pages, multi-user/sharing, cost monitoring, synthetic transactions, AI-summarized weekly reports.

- [ ] **Step 3: Append the cost ledger**

**`## Cost`** — framed as a feature, not a flaw. **~$12/mo**: DigitalOcean `s-1vcpu-2gb` droplet ($12/mo); domain already owned (~$12/yr amortized); DNS (Namecheap), TLS (Caddy/Let's Encrypt), external uptime check (UptimeRobot) all free; no AI/API spend. One line: "This is deliberately not a free-tier portfolio piece — the cost is the point."

- [ ] **Step 4: Append "Run it locally"**

**`## Run it locally`** — compact, accurate quickstart (facts verified: Node 22; both apps have `.env.example`; root `npm run dev` runs web+server+worker via concurrently; dev Postgres compose exists; `npm run db:migrate` is a root script):
```markdown
Requires Node 22 and Docker.

​```bash
git clone https://github.com/thiluxan-s/beacon && cd beacon
npm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local          # fill in Clerk keys, secrets
docker compose -f infrastructure/docker-compose.dev.yml up -d   # local Postgres
npm run db:migrate
npm run dev                                            # web + API server + worker
​```
```

- [ ] **Step 5: Verify placeholder count + local-dev facts**

Run: `grep -c "Screenshot coming soon" README.md`
Expected: `4` (1 hero + 3 gallery).
Run: `grep -q '"dev"' package.json && test -f infrastructure/docker-compose.dev.yml && test -f apps/web/.env.example && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): screenshots, roadmap, cost ledger, local dev"
```

---

## Task 6: Final verification pass

**Files:**
- Modify (if fixes needed): `README.md`

**Interfaces:**
- Consumes: complete `README.md`.

- [ ] **Step 1: All local doc links resolve**

Run:
```bash
grep -oE '\]\(([^)]+)\)' README.md | sed -E 's/^\]\(//; s/\)$//' | grep -vE '^https?://|^#' | while read -r f; do [ -e "$f" ] && echo "OK $f" || echo "MISSING $f"; done
```
Expected: every line `OK ...`, no `MISSING`.

- [ ] **Step 2: No stale status language anywhere**

Run: `grep -niE "not built yet|phase [0-9]+ —|coming in a later phase|still a later phase" README.md`
Expected: no matches.

- [ ] **Step 3: Placeholder + hero-fact sanity**

Run: `grep -c "coming soon" README.md`
Expected: `5` (4 screenshots + 1 diagram).
Run: `grep -c "beacon.thiluxan.com/demo" README.md`
Expected: `>= 1`.

- [ ] **Step 4: Full read-through**

Read the whole file top to bottom. Confirm: voice is consistent and opinionated; Infrastructure decisions is clearly the meatiest section; no duplicated prose that should be a link; the "$12/mo" figure appears only in the cost ledger and hook (consistent). Fix anything inline.

- [ ] **Step 5: Render check (optional but preferred)**

Run: `npx --yes markdown-link-check README.md 2>/dev/null | tail -20 || echo "skipped (no network) — rely on Step 1"`
Expected: external links pass, or gracefully skipped.

- [ ] **Step 6: Commit any fixes**

```bash
git add README.md
git commit -m "docs(readme): final verification pass — links, no stale claims"
```

- [ ] **Step 7: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` (push + PR — the human merges).

---

## Self-Review

- **Spec coverage:** hero/live-demo/features (T1 ← spec §1–3), why-exists + architecture + diagram placeholder (T2 ← §4–5), infrastructure decisions centerpiece (T3 ← §6), integration seam + stack table + deploy pipeline (T4 ← §7–9), screenshots + roadmap + cost + local-dev (T5 ← §10–13), verification incl. no-stale-claims + link resolution + placeholder convention (T6 ← success criteria). All spec sections mapped.
- **Placeholder scan:** the plan's own steps carry concrete content, exact commands, and verbatim data; the only "placeholders" are the intended README image slots (a deliverable requirement, per approved scope), each with a fixed greppable convention.
- **Consistency:** placeholder string "coming soon" and the `<!-- SCREENSHOT: -->` / `<!-- DIAGRAM: -->` markers are used identically across T1/T2/T5/T6; the "$12/mo" figure and demo URL are defined once in Global Constraints and reused; section names in Interfaces match the headings in the steps.
