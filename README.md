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

Beacon runs as three long-running processes on one VPS: a Next.js frontend (`web`), a Hono API (`server`), and a background `worker` that runs the health checks — plus Postgres. Caddy sits in front, terminating TLS and routing traffic to `web` and `server`. When the worker detects a status change, it doesn't wait for the browser to ask — it pushes the update through a WebSocket fan-out, scoped to per-service topics, so every subscribed client sees the change land in real time. Integrations (Vercel, GitHub, and whatever comes next) are a registry of drop-in modules rather than logic wired into the core — adding a provider means adding a file, not touching the worker or the API.

<!-- DIAGRAM: VPS + Docker network — caddy, web, server, worker, postgres; external Vercel/GitHub APIs; WS + data-flow arrows -->
> _📐 Architecture diagram coming soon._

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, including the WebSocket layer and Integration Layer.
