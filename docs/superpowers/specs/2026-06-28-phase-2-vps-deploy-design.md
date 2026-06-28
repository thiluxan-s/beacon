# Phase 2 — VPS Setup & Production Deploy — Design Spec

**Date:** 2026-06-28
**Phase:** 2 (VPS + production deploy)
**Status:** Design approved; pending spec review → implementation plan.

## Goal

Phase 1's app runs live at `https://beacon.thiluxan.com`, with SSL, auto-deployed on every push to `main` via GitHub Actions. The "self-hosted on DigitalOcean" portfolio story becomes real.

## Execution model

**Build all infrastructure-as-code first; the human executes the live steps.** Every repository artifact (Dockerfiles, compose, Caddyfile, deploy script, CI workflow, bootstrap + backup scripts, runbook) is built, reviewed, and committed. The human then provisions the droplet / DNS / secrets following the runbook, with Claude guiding and debugging. No live infrastructure is provisioned by Claude.

## Locked decisions

- **Domain:** `beacon.thiluxan.com` (web) + `api.beacon.thiluxan.com` (API/WS). Reconcile the landing-page footer's `thiluxan.dev` → `.com`.
- **Droplet:** DigitalOcean Basic, Ubuntu 24.04 LTS, **$12/mo (1 vCPU / 2GB)** — headroom for the Phase 3 WS layer + workers. Update the INFRASTRUCTURE.md cost ledger to ~$16/mo.
- **Server prod image runtime:** run via **tsx** (`tsx src/index.ts`, the existing `start` script). No compile step. Migrations run through the same tsx path.
- **Registry / deploy mechanism:** build images in CI (buildx, linux/amd64), push to `ghcr.io`, SSH to VPS, `docker compose pull && up -d`. (Per INFRASTRUCTURE.md.)
- **Backups + external monitoring scope:** commit `backup.sh` + cron entry as artifacts now; defer LIVE R2 wiring, backup verification, and UptimeRobot to **Phase 5** (per INFRASTRUCTURE.md's phase-by-phase section).

## Scope

**In scope (Phase 2 deliverables 1–9, 12, 13):** droplet provisioning + hardening; Docker + Compose on VPS; production `docker-compose.yml` (web, server, postgres, caddy); Caddy auto-SSL + routes; Cloudflare DNS (Full-strict); GitHub Actions CI/CD; production `/opt/beacon/.env`; manual deploy script; first production deploy with working sign-in; INFRASTRUCTURE.md updated to actual state.

**Built but deferred:** `backup.sh` + cron entry committed, not wired to R2 (deliverable #11 partial).

**Out of scope:** UptimeRobot (#10 → Phase 5); `check-worker` / `integration-worker` services (Phase 3/4); integrations encryption key, Resend, WS URL (later phases).

## Repository artifacts

| File | Purpose |
| --- | --- |
| `apps/web/Dockerfile` | Multi-stage; Next.js `output: 'standalone'` runtime image |
| `apps/server/Dockerfile` | Multi-stage; runs `tsx src/index.ts`; includes `drizzle/` migrations |
| `infrastructure/docker-compose.yml` | Prod stack: `caddy`, `web`, `server`, `postgres`; references `ghcr.io` images via a `BEACON_VERSION` tag var; `env_file: /opt/beacon/.env` |
| `infrastructure/Caddyfile` | Two vhosts + hardening headers; **blocks `/internal/*`** on the API host; certs in a named volume |
| `.github/workflows/deploy.yml` | On push to `main`: typecheck/lint/test → build+push both images → SSH deploy. PRs run checks only (no deploy). |
| `infrastructure/deploy/deploy.sh` | The deploy logic CI calls over SSH (also runnable manually): pull, migrate, `up -d`, health-verify, auto-rollback |
| `infrastructure/scripts/bootstrap-vps.sh` | First-boot hardening: non-root sudo user, SSH key-only + disable root/password, ufw (22/80/443), fail2ban, unattended-upgrades, UTC, Docker from official repo, docker group |
| `infrastructure/scripts/backup.sh` + cron entry | `pg_dump | gzip`; R2 upload deferred (Phase 5) — committed with the rclone step stubbed/guarded |
| `apps/web/.env.production.example`, `apps/server/.env.production.example` (or a single documented prod env reference) | Document prod vars without secrets |

## Production topology

```
Cloudflare (orange-cloud proxy, SSL Full (strict))
        │
      Caddy (auto-SSL via Let's Encrypt; certs in named volume)
        ├── beacon.thiluxan.com      → web:3000   (Next.js standalone)
        └── api.beacon.thiluxan.com  → server:3001 (Hono)
              └── handle /internal/* → respond 404   (blocked at the proxy)

   web    ──(Docker network: http://server:3001)──► server   (all server-side calls)
   server ──► postgres:5432   (no published host port; named volume beacon_postgres_data)
```

All four services share a Docker network. Postgres is never published to the host. The web container's server-side fetches reach the API over the internal network, not back out through Caddy.

## Deploy pipeline (push to `main`)

```
1. checkout
2. npm ci (workspaces)
3. typecheck (all workspaces)
4. lint (all workspaces)
5. test (vitest where present)
6. build web image (buildx, linux/amd64)
7. build server image (buildx, linux/amd64)
8. push both to ghcr.io with the commit SHA tag (auth via GITHUB_TOKEN)
9. SSH to VPS → invoke infrastructure/deploy/deploy.sh with the new SHA
     a. docker compose pull
     b. docker compose run --rm server npm run db:migrate   (abort deploy on failure)
     c. docker compose up -d
     d. verify: curl https://beacon.thiluxan.com/health and https://api.beacon.thiluxan.com/health → 200 within 30s
     e. on verify failure: roll back BEACON_VERSION to previous SHA, up -d, exit non-zero
```

PR builds run steps 1–5 only. Known-good deploys are git-tagged.

## App-code changes (Phase 1 carry-forwards realized here)

1. **Internal web→server URL.** `apps/web/lib/ensure-user-exists.ts` and `apps/web/lib/api-client.ts` server-side fetches use `process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL`. Production sets `INTERNAL_API_URL=http://server:3001`; locally it is unset and falls back to `NEXT_PUBLIC_API_URL` (`http://localhost:3001`) — no local behavior change. (`NEXT_PUBLIC_API_URL` remains the browser-facing URL for future WS/client use.)
2. **`/internal/*` lockdown** at Caddy (404 on the public API host) — the upsert endpoint is reachable only inside the Docker network.
3. **`output: 'standalone'`** in `apps/web/next.config.ts` for a lean web image.
4. **Landing footer** `thiluxan.dev` → `thiluxan.com`.

## Secrets & environment

Production `/opt/beacon/.env` (600, owned by deploy user, never in repo) — scoped to what the Phase-1 app uses:

```
POSTGRES_PASSWORD=<generated>
DATABASE_URL=postgresql://beacon:<POSTGRES_PASSWORD>@postgres:5432/beacon
WEB_ORIGIN=https://beacon.thiluxan.com
INTERNAL_API_SECRET=<openssl rand -base64 32>
NEXT_PUBLIC_API_URL=https://api.beacon.thiluxan.com
INTERNAL_API_URL=http://server:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<prod>
CLERK_SECRET_KEY=<prod>
CLERK_WEBHOOK_SECRET=<prod webhook signing secret>
```

GitHub Actions secrets: `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_KNOWN_HOSTS` (image push uses the built-in `GITHUB_TOKEN` against ghcr).

Production webhook: a real `CLERK_WEBHOOK_SECRET` is configured this phase (Clerk dashboard → webhook endpoint at `https://beacon.thiluxan.com/api/clerk/webhook`), making the webhook the primary user-creation path in prod (with `ensureUserExists()` still the fallback).

## Testing strategy (de-risk before the live box)

- `docker build` both images locally; confirm they run.
- Bring up the **full prod compose stack on localhost** with a local `.env` (Caddy in an internal/no-public-CA mode or host-port mapping) to smoke-test web + server + postgres + caddy together, including the migration step and the internal-URL path.
- `shellcheck` `deploy.sh`, `bootstrap-vps.sh`, `backup.sh`; `docker compose config` to validate the compose file; lint/validate the GitHub Actions YAML.
- The **first live deploy + live sign-in** (deliverable #12) is the end-to-end integration test.

## Live runbook (executed by the human, Claude guiding)

1. Create the DigitalOcean droplet (Ubuntu 24.04, $12/2GB, TOR1), add SSH key.
2. Run `bootstrap-vps.sh` (hardening + Docker).
3. Create `/opt/beacon/.env` from the documented reference with real secrets.
4. Place `docker-compose.yml` + `Caddyfile` under `/opt/beacon/` (via the deploy mechanism).
5. Cloudflare: two proxied A records (`beacon`, `api.beacon`) → droplet IP; SSL Full (strict); verify WebSockets allowed for the API host.
6. Add the GitHub Actions secrets.
7. Configure the Clerk production webhook + signing secret.
8. Push to `main` → watch the Actions deploy → verify both health endpoints and live sign-in.
9. Update `INFRASTRUCTURE.md` to the actual setup; tag the known-good deploy.

## Acceptance criteria

- [ ] Droplet provisioned + hardened; hardening steps reflected in `INFRASTRUCTURE.md`.
- [ ] `https://beacon.thiluxan.com` serves the app over valid SSL; `https://api.beacon.thiluxan.com/health` returns 200.
- [ ] `https://api.beacon.thiluxan.com/internal/users/upsert` returns 404 (blocked at Caddy).
- [ ] Push to `main` triggers the full pipeline and deploys automatically; PRs run checks only.
- [ ] A failed health check rolls the deploy back to the previous image.
- [ ] Sign-in works on the live URL; a User row is created (via production webhook and/or `ensureUserExists()`).
- [ ] No secrets in the repo; prod secrets live only on the VPS / in GitHub secrets.
- [ ] `deploy.sh` works as a manual deploy too.
- [ ] `backup.sh` committed (R2 wiring + verification deferred to Phase 5, noted in the script and INFRASTRUCTURE.md).
- [ ] `INFRASTRUCTURE.md` updated to actual state; runbook verified.

## Open risks / notes

- **DB durability:** production data lives in a single named volume on one droplet with no offsite backup until Phase 5. Acceptable because Phase 1 data is minimal (a users table), but call it out — do not treat prod as durable until Phase 5 backups are verified.
- **Cloudflare proxy + Caddy SSL:** Full (strict) requires Caddy's Let's Encrypt cert to provision before flipping the orange cloud; sequence DNS-unproxied → cert issued → enable proxy, to avoid a chicken-and-egg TLS failure.
- **Single point of failure:** one droplet, no redundancy. Intentional for cost/scope; the external watcher (Phase 5) covers detection.
```
