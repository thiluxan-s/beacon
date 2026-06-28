# PRD — Beacon

**Tagline:** Monitor anything you ship.

## Problem

I run several deployed projects (Wayfare, Investor Thesis, my portfolio site) and will run more (client projects, future portfolio pieces). Today, when something breaks, I find out:
- Hours later, by accident, when I try to open the site
- From a friend mentioning it
- Never, until it matters

The existing tools either don't fit my workflow (Datadog/Grafana are built for teams, not solo devs), are too narrow (UptimeRobot is just uptime), or are platform-locked (Vercel's dashboard only shows Vercel projects, and the next client I work with might be on Railway, Fly, or AWS).

I want one place to see whether everything I run is healthy — regardless of where it's hosted.

## Solution

A self-hosted, real-time dashboard for services I run. Each service is monitored at the HTTP layer (works for anything with a URL) and optionally enriched with integrations to the platform it's hosted on. WebSocket updates push status changes to the dashboard live. Incidents are logged with timelines I can review. Architecture is built around the abstraction "monitored service" — not "Vercel project" — so adding new platforms later is a one-file change.

This is *my* tool, deployed to *my* infrastructure, monitoring *my* projects. The dashboard URL is the actual production instance, not a sandbox.

## Target user (v1)

Me. Specifically: a solo developer running multiple projects across multiple platforms, who wants better visibility than ad-hoc checking but doesn't want enterprise observability complexity.

A secondary audience: future-me who takes on client projects and wants to monitor those too without changing the tool.

## Non-goals (explicitly)

- **Not a SaaS.** Single-user. Not optimized for multi-tenancy. (The architecture is *clean* enough that multi-tenancy could be added later, but it's not the product.)
- **Not a competitor to Datadog / Grafana / New Relic.** No metrics ingestion, no log aggregation, no APM. Operational status only.
- **Not a status page.** Internal dashboard. No public-facing component.
- **Not a logging tool.** Logs live where they live (Vercel logs in Vercel, etc.). We surface status, not application output.
- **No on-call / paging features.** A simple email alert or push notification when something breaks. No PagerDuty, no escalation policies.
- **Not AI-powered.** Deliberately. Two AI projects in my portfolio is plenty; this one demonstrates systems engineering.

## v1 scope — what ships in 6 weekends

A signed-in user (me) can:
1. Add a service to monitor by URL. Configure its name, description, expected response code.
2. Optionally attach integrations to a service:
   - **Vercel** — link to a Vercel project for deploy status, build success/failure, deploy frequency.
   - **GitHub** — link to a repo for commit activity, open PRs, CI status.
3. Add domains to monitor (separate concept from services): DNS resolution, SSL certificate expiry, domain registration expiry.
4. See the main dashboard:
   - All services at a glance with current status (up/degraded/down), uptime % (24h, 7d, 30d), response time trend.
   - All domains at a glance with days until SSL/registration expiry, DNS health.
   - Live status updates pushed via WebSocket — no refresh needed.
5. Click into a service:
   - Live status with the recent check history.
   - Integration data (recent deploys from Vercel, recent commits from GitHub, etc.).
   - Incident timeline (when did downtime happen, how long, what status codes).
6. See an incident view:
   - List of incidents across services with start/end/duration.
   - Filterable by service, severity.
7. Receive email alerts when a service goes from "up" to "down" (after 2 consecutive failed checks to avoid flapping).
8. Edit services, integrations, and domains. Pause monitoring on a service without deleting it.

That's it. Anything not on this list is v2.

## v2 — written down so we don't forget, but explicitly not built in v1

- **Additional platform integrations** — Railway, Fly.io, Render, AWS, custom webhook receivers.
- **SSH-based monitoring** for self-hosted Docker containers (`docker ps` + container health over SSH).
- **Anomaly detection** (response time suddenly 3x normal, etc.).
- **Mobile push notifications** instead of email.
- **Slack / Discord webhook integration** for alerts.
- **Public status pages** (per-service or per-customer).
- **Multi-user support / sharing dashboards.**
- **Cost monitoring** (Vercel bandwidth usage, Anthropic API spend, etc.).
- **Synthetic transaction monitoring** (not just "is the homepage up" but "can a user log in").
- **AI-summarized weekly status reports.**

## Success criteria

This is a portfolio piece. Success measured by what it demonstrates:

1. **The demo URL is live, self-hosted, and stable.** A recruiter clicks a link, sees a real dashboard with real status data updating live, and "gets it" in under 90 seconds.
2. **The architecture is legible.** The README explains the integration abstraction, the WebSocket fan-out, the deploy pipeline. A developer reading for 10 minutes understands the system.
3. **The deploy story is the headline.** README has a section explicitly about infrastructure choices — VPS over serverless, Caddy over Nginx, Docker Compose over Kubernetes — with the reasoning. This is the differentiator.
4. **I'm actually using it.** Within 2 weeks of launch, this dashboard is open in a tab I check regularly. If I'm not using it, the product failed.

## Constraints

- **Real monthly cost.** ~$10/mo for the VPS. Worth flagging in README — not a free-tier portfolio piece.
- **Solo, weekends only.** Aggressive scope discipline.
- **Production-grade from day one.** Because *I* will use this, broken builds matter. Failing deploys matter. Real-world reliability isn't optional like it might be for a demo-only project.

## Key decisions and the reasoning

- **Why self-hosted on DigitalOcean instead of Vercel?** The whole point of this project is to demonstrate I can ship outside the serverless box. Vercel doesn't support long-running WebSocket servers cleanly, and "I monitor Vercel from a Vercel deployment" is circular. A DigitalOcean Droplet with Docker is a meaningful infrastructure story I can talk about in interviews.
- **Why DigitalOcean specifically?** Familiar, well-documented, has a free $200 trial credit, geographically diverse. Hetzner would be slightly cheaper; AWS would muddy the "indie self-hosted" narrative; Render/Railway would defeat the "self-hosted" point.
- **Why a long-running Node server (Hono), not Next.js API routes?** WebSockets need persistent connections. Next.js API routes on Vercel can't do that. Even if I were running Next.js on the VPS, separating the API server lets me restart the API independently of the frontend.
- **Why no AI in v1?** Two AI projects in the portfolio is enough. This one demonstrates systems engineering. AI summarization of incidents in v2 is fine — but it's not the headline. ("This person can ship without leaning on AI" is a stronger senior-engineer signal than "this person can only ship AI features.")
- **Why platform-agnostic from day one?** Because I'll actually use this for years, on platforms I haven't picked yet. Designing for extension *now* makes Beacon a forever-useful tool instead of a one-shot portfolio piece. The architectural cost is small (an interface + a registry); the upside is large.
- **Why limit v1 integrations to Vercel + GitHub?** Anything more is scope creep. The architecture is built to make adding Railway, Fly, AWS, etc. a "drop a file" operation. Shipping 5 integrations partial beats shipping 2 well — and a clear "here's how to add more" pattern in the README beats both.
- **Why Caddy over Nginx?** Caddy auto-provisions SSL via Let's Encrypt with zero config. Nginx + Certbot works but adds a setup step (and a renewal cron) that Caddy doesn't need. The simpler choice when it's correct.
- **Why Docker Compose and not bare metal?** Reproducibility. A new VPS should bring up the entire stack with `docker compose up -d`. Anything done outside the compose file is hidden state that bites you in 6 months.
- **Why a monorepo (web + server + shared)?** Type-safe communication between web and server is the killer feature. Shared Zod schemas mean a Server Action and a WebSocket message can use the same validated shape. The boilerplate of a workspace setup is paid back tenfold.
- **Why is the database self-hosted (likely) instead of Neon?** Decided in Phase 1, but leaning self-hosted because: (a) the data is mine alone, (b) running Postgres on the VPS is part of the systems story, (c) we have no need for serverless scaling. Trade-off: I'm responsible for backups. (Plan: nightly `pg_dump` + rclone to Cloudflare R2 or S3-compatible storage.)
- **Why "Beacon"?** Short. Evocative. The watchtower metaphor (always-on, always-visible) does the work of explaining the product. Available as a domain or subdomain easily.
