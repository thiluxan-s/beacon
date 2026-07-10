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
