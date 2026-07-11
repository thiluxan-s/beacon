# Beacon

Beacon is a real-time monitoring dashboard for the services and domains I run — self-hosted on my own DigitalOcean VPS, served from my own domain. It watches anything with an HTTP endpoint, and goes deeper wherever an integration is configured (Vercel, GitHub today; more via a drop-in registry). It's the systems-engineering counterpart to my two prior projects, Wayfare and Investor Thesis — both Next.js on Vercel — where Beacon is deliberately a long-running server instead.

> **Deliberately not serverless.** Monitoring a serverless app from another serverless app is circular — the monitor needs to stay up on its own terms, not the platform's. That's why this runs as a persistent Node process holding open WebSocket connections, on a box I manage, for about **~$12/mo**. Real infrastructure cost, on purpose — a feature of the project, not an oversight.

<!-- SCREENSHOT: main dashboard — all services at a glance, live status dots -->
> _📷 Screenshot coming soon._

## Live demo

**[beacon.thiluxan.com/demo](https://beacon.thiluxan.com/demo)**

This is the real production dashboard at [beacon.thiluxan.com](https://beacon.thiluxan.com) — not a sandbox seeded with fake data. The demo view is read-only, requires no login, and streams live status updates over the same WebSocket connection the authenticated app uses.

## What it does

- **Real-time HTTP health checks** — configurable interval, expected status codes, timeout.
- **Live status over WebSockets** — per-service topic subscriptions, in-process fan-out.
- **Incident timelines** — auto-open after consecutive failures, observation events, auto-resolve on recovery.
- **Email alerts (Resend)** — global + per-service toggles.
- **Domain monitoring** — DNS, SSL-certificate expiry, and registration expiry (RDAP).
- **Pluggable integrations** — Vercel & GitHub today, via a drop-in registry.
- **Public read-only demo mode** — anonymous, opt-in per entity, live.
- **Single-user auth** (Clerk).

## Why this exists

Wayfare and Investor Thesis, my two prior portfolio projects, are both Next.js on Vercel — serverless front to back. That stack is the right call for a CRUD app with bursty traffic, but it's the wrong shape for a monitor: a function that only runs when invoked can't hold a WebSocket open, can't tick a check on a fixed interval without an external scheduler, and can't watch itself for the gaps between invocations. A monitoring system needs a process that's just *running*, continuously, on infrastructure I control.

So Beacon is the deliberate opposite: a long-running Node server instead of functions, native WebSockets instead of polling, a self-hosted Postgres instead of a managed edge database, and a real deploy pipeline — build, SSH, restart — onto a box I own instead of a `git push` to someone else's platform. The contrast is the point. Wayfare and Investor Thesis prove I can ship product on serverless; Beacon proves I can own the machine underneath it.

## Architecture

Beacon runs as three long-running processes on one VPS: a Next.js frontend (`web`), a Hono API (`server`), and a background `worker` that runs the health checks — plus Postgres. Caddy sits in front, terminating TLS and routing traffic to `web` and `server`. When the worker detects a status change, it doesn't wait for the browser to ask — it writes the change and fires a Postgres `NOTIFY` in the same transaction; the `server` process holds the matching `LISTEN` connection and relays the event straight into its WebSocket fan-out, scoped to per-service topics, so every subscribed client sees the change land in real time. Integrations (Vercel, GitHub, and whatever comes next) are a registry of drop-in modules rather than logic wired into the core — adding a provider means adding a file, not touching the worker or the API.

<!-- DIAGRAM: VPS + Docker network — caddy, web, server, worker, postgres; external Vercel/GitHub APIs; WS + data-flow arrows -->
> _📐 Architecture diagram coming soon._

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, including the WebSocket layer and Integration Layer.

## Infrastructure decisions

This is the part of the project I'd point a hiring manager at first. Anyone can pick a framework; the interesting signal is in the stack *underneath* it — every choice below is a constraint I hit and the trade-off I accepted to get past it, not a default I inherited from a starter template.

**VPS over serverless.** A monitor has to hold WebSocket connections open and tick health checks on a fixed interval — neither of which a function-per-invocation platform does without bolting on an external scheduler and a separate socket service. And monitoring a Vercel app *from* a Vercel deployment is circular: the watcher goes down exactly when the platform does. So Beacon runs as persistent processes on a Droplet I manage. The trade-off is honest — I now own patching, backups, and uptime that Vercel would have handled for free.

**DigitalOcean specifically.** I picked DO for familiarity, its documentation, and trial credit — not AWS, which is CLO-adjacent day-job territory and would muddy the "indie self-hosted" story, and not Render or Railway, which are just serverless with extra steps and defeat the point of owning the box. Hetzner is slightly cheaper for the same specs; DO won on how fast I could move on it. The box is a single `s-1vcpu-2gb` running Ubuntu 24.04.

**A long-running Hono server, not Next.js API routes.** The persistent WebSocket fan-out needs a process that stays resident between requests, which App Router route handlers aren't built to be. Splitting the API into its own Hono service also means it restarts independently of the frontend — I can redeploy the dashboard without dropping every open socket, and the worker keeps checking either way. The cost is a second process to run and route to, versus one unified Next.js deployment.

**Caddy over Nginx.** Caddy provisions and renews Let's Encrypt certificates automatically with zero cron jobs or certbot glue, and its config for a single-box reverse proxy is a handful of lines instead of a server block I'd copy-paste and misconfigure. Nginx is more battle-tested at scale and more tunable — but for one box terminating TLS in front of two upstreams, that tunability is complexity I'd be paying for and not using.

**Docker Compose over Kubernetes.** Everything runs on one machine, so orchestration means "start five containers on the same host in the right order" — exactly Compose's job. Reaching for Kubernetes here would be résumé-driven rather than problem-driven; there's no cluster, no autoscaling, no multi-node scheduling to justify it. The cost is present-tense, not hypothetical: no rolling restarts or multi-node failover, so a `compose up` briefly cycles a container instead of shifting traffic away first. If Beacon ever genuinely outgrew one box, that's when the k8s conversation earns its keep — not before.

**Self-hosted Postgres on the same box.** Postgres runs as a container alongside the app rather than on managed Neon or RDS, which keeps the whole system reproducible from this repo with no external data dependency — and lets the worker use `LISTEN/NOTIFY` as the real-time backbone instead of adding a message broker. The app is built to degrade gracefully while the database restarts (a "data unavailable, retrying" state, not a crash), which is the price of not having a managed HA setup underneath it.

**Native `ws` over Socket.io.** I wanted plain WebSockets, not Socket.io's transport fallbacks, custom framing, and reconnect magic layered on top — abstractions I'd have to reason around every time the connection misbehaved. The `ws` library is a thin, well-maintained implementation of the actual protocol, so the reconnect/backoff/resubscribe logic is code I wrote and understand. The trade-off is exactly that: I own that logic instead of getting it handed to me.

**No Redis, no AI in v1.** In-process state and Postgres cover everything Beacon does today, so adding Redis would be caching a problem I don't have yet — it goes in when there's a measured reason, not preemptively. The trade-off: `LISTEN/NOTIFY` fan-out is in-process and single-server, so there's no cross-process pub/sub if Beacon ever ran on more than one node. AI is left out on purpose too — no anomaly detection, no incident summarization — since this project's whole job is to signal systems engineering, and a bolted-on LLM feature would blur that signal against the two AI projects already in my portfolio.

**Namecheap plain A records, no proxy in front.** DNS is plain A records pointing straight at the Droplet, with no Cloudflare or other proxy layer between the internet and Caddy. That keeps Caddy terminating TLS directly and makes the request path trivial to reason about — what hits the box is what the client sent. The trade-off is giving up the DDoS absorption and edge caching a proxy would add, which is a fair deal for a single-user portfolio dashboard.

See [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) for the full VPS setup, deploy pipeline, and networking details.

## Adding an integration

Every data source Beacon knows how to read — Vercel deploys, GitHub Actions runs, whatever comes next — is a single file implementing the `IntegrationDefinition` interface in [`apps/server/src/integrations/types.ts`](apps/server/src/integrations/types.ts): a Zod schema for credentials, a Zod schema for config, field metadata for the generic attach form, a `testCredentials` check, and a `fetchData` call. Wiring it in is an import plus one entry in the registry map:

```ts
// apps/server/src/integrations/registry.ts
import { railwayIntegration } from './railway';

export const IntegrationRegistry: Map<string, IntegrationDefinition> = new Map([
  [vercelIntegration.id, vercelIntegration as IntegrationDefinition],
  [githubIntegration.id, githubIntegration as IntegrationDefinition],
  [railwayIntegration.id, railwayIntegration as IntegrationDefinition],
  // one import + one entry — that's the whole wiring change
]);
```

That's the entire seam: drop `apps/server/src/integrations/railway.ts`, implement the interface, add the import and one line to the map above. No changes to the worker, the API routes, or the WebSocket fan-out — they all consume `IntegrationRegistry` generically. If adding a provider ever required touching core code, that would mean the abstraction had a hole in it. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full Integration Layer design, including the credential-encryption and attach-form details.

## Tech stack

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

## Deploy pipeline

A push to `main` triggers GitHub Actions: typecheck, lint, and tests run first, then the `web` and `server` images build and push to ghcr. Deployment happens over SSH via [`infrastructure/deploy/deploy.sh`](infrastructure/deploy/deploy.sh), which syncs infra config to the box, pulls the new images, runs any pending database migrations, brings the stack up with `docker compose up`, recreates the proxy to pick up config changes, and health-checks both `web` and `server` before considering the deploy complete — rolling back automatically if either fails. See [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) for the rollback mechanics and CI workflow definitions.

## Security posture

Beacon is single-user, but "only I log in" isn't a security model — a public dashboard on a box I own is still exposed to the whole internet. So it's hardened in depth, and — the part I care about more — **verified against the running system, not assumed from config**:

- **Host & network.** `ufw` allows only 22/80/443 inbound (default-deny on incoming *and* routed traffic); SSH is key-only, with root login and password authentication disabled. DNS points straight at the Droplet with no proxy in front, so what reaches Caddy is exactly what the client sent.
- **Transport.** Caddy terminates TLS with auto-renewed Let's Encrypt certificates; HSTS is sent with `preload`.
- **HTTP headers.** The web host sends an **enforcing, nonce-based Content-Security-Policy** (`strict-dynamic`, no `unsafe-inline` for scripts), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy`; the API host sends HSTS + `nosniff`.
- **Auth & internal surface.** Clerk gates every app route, and the Clerk webhook verifies its svix HMAC signature before processing anything. The internal `web → server` API requires a shared secret compared in constant time; Caddy returns `404` for `/internal/*` on the public host; and the server port is published only on the Docker network, never the host. CORS is locked to a single origin.
- **Secrets & data.** Integration credentials (Vercel/GitHub tokens) are encrypted at rest with **AES-256-GCM**, never returned to the client, and never logged. No secrets live in git — `.env` files are untracked; only `.env.example` placeholders are committed. Every query runs through Drizzle's parameterized builder, so there's no string-concatenated SQL surface.
- **Public demo lane.** The anonymous `/demo` WebSocket is receive-only and topic-scoped (it refuses global and private-service topics), capped in concurrent connections, serves only opted-in entities as minimal DTOs, and is disabled entirely unless explicitly switched on.

### Phase 6: the security review

Rather than trust that all of the above was wired correctly, Phase 6 was a whole-app audit against a written checklist — code, infrastructure config, and git history — documented finding-by-finding in [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md). No critical or high findings; everything else was fixed or explicitly accepted, and **each fix was verified in production, not just merged.** Two are worth calling out, because shipping carefully is what caught real bugs:

- **The CSP shipped `Report-Only` first.** A strict CSP can silently break a Next.js + Clerk app, so it went out in report-only mode and was validated against the live app before enforcing — and that caught a genuine defect: under `strict-dynamic`, Clerk's own script was loading *without* the per-request nonce and would have been **blocked** the moment the policy enforced, breaking sign-in for real users. The fix (`<ClerkProvider dynamic>`, which routes Clerk through its nonce-aware script path) was confirmed against production — the response's nonce matching the script tag's — and only then flipped to enforcing.
- **A one-line header fix that exposed a deploy-pipeline gap.** Adding `nosniff` to the API host quietly did nothing: the pipeline only ever pulled application *images* and never synced infra config (the Caddyfile) to the VPS — and because the Caddyfile is a single-file Docker bind mount, an atomic file replace left the running container pinned to the old inode, so even a `caddy reload` was a no-op. Fixed by having CI sync config to the box and the deploy **recreate** the proxy container. Config-as-code now actually ships.

The two operational items — confirming the firewall/SSH state on the box, and rotating two API tokens that had leaked into local dev logs during earlier smoke tests (never into git) — were both closed out and verified on the VPS.

## Screenshots

<!-- SCREENSHOT: service detail — live status stream + recent checks -->
> _📷 Screenshot coming soon._

<!-- SCREENSHOT: incident timeline — opened → observed → resolved -->
> _📷 Screenshot coming soon._

<!-- SCREENSHOT: integration card — Vercel/GitHub snapshot on a service -->
> _📷 Screenshot coming soon._

## Roadmap

Explicitly not in v1:

- More platform integrations — Railway, Fly, Render, AWS, custom webhooks
- SSH-based container monitoring
- Anomaly detection
- Push/Slack/Discord alerts
- Public status pages
- Multi-user / sharing
- Cost monitoring
- Synthetic transactions
- AI-summarized weekly reports

## Cost

**~$12/mo.** DigitalOcean `s-1vcpu-2gb` droplet ($12/mo) is the only real line item — domain is already owned (~$12/yr amortized), DNS (Namecheap), TLS (Caddy/Let's Encrypt), and the external uptime check (UptimeRobot) are all free, and there's no AI/API spend. This is deliberately not a free-tier portfolio piece — the cost is the point.

## Run it locally

Requires Node 22 and Docker.

```bash
git clone https://github.com/thiluxan-s/beacon && cd beacon
npm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local          # fill in Clerk keys, secrets
docker compose -f infrastructure/docker-compose.dev.yml up -d   # local Postgres
npm run db:migrate
npm run dev                                            # web + API server + worker
```
