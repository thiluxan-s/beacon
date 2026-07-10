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
