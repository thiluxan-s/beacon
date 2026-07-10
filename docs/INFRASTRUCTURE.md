# Infrastructure

This document is the source of truth for everything outside the application code: the VPS, the network, the deploy pipeline, the backups, and the operational runbook. **Update it any time something changes about how Beacon is hosted, deployed, or recovered.**

Unlike Wayfare and Investor Thesis where infrastructure was "Vercel handles it," Beacon's infrastructure is part of the portfolio piece. The deploy story is the headline of the README.

---

## VPS

### Specs

- **Provider:** DigitalOcean
- **Type:** Basic Droplet
- **Size:** 1 vCPU / 2GB ($12/mo), chosen for WS/worker headroom.
- **OS:** Ubuntu 24.04 LTS
- **Region:** TOR1 (Toronto) — closest to me. Lower latency for me browsing the dashboard; close enough to common monitoring targets.
- **Networking:** Public IPv4, IPv6 enabled.

### First-boot hardening (one-time setup)

The following is run on a fresh Droplet before any application code is deployed. Document the exact commands here as we run them in Phase 2 so the setup is reproducible.

> Detailed setup checklist will live here after Phase 2 — placeholders for now.

- Create a non-root user (`thiluxan` or similar) with sudo.
- Add SSH public key to `~/.ssh/authorized_keys`.
- Disable root SSH login, disable password auth (`PermitRootLogin no`, `PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- Install ufw, allow `OpenSSH`, allow `80/tcp`, allow `443/tcp`, deny incoming default. `ufw enable`.
- Install fail2ban with default Ubuntu config (banning SSH brute-force attempts).
- Set automatic security updates: `unattended-upgrades`.
- Set timezone to UTC.
- Install Docker + Docker Compose plugin from Docker's official APT repo (not the Ubuntu-bundled outdated version).
- Add the non-root user to the `docker` group.
- Verify: `docker run hello-world` works as the non-root user.

### Required env on the VPS

The VPS holds runtime secrets in a single `.env` file at `/opt/beacon/.env` (owned by the deploy user, 600 permissions). This file is NEVER in the repo. Contents:

The committed reference for this file is `infrastructure/.env.production.example` (placeholders only). As of Phase 2 the actual contents are:

```
POSTGRES_PASSWORD=changeme-generate-a-strong-password
DATABASE_URL=postgresql://beacon:changeme-generate-a-strong-password@postgres:5432/beacon
WEB_ORIGIN=https://beacon.thiluxan.com
INTERNAL_API_SECRET=changeme-openssl-rand-base64-32-min-32-chars
NEXT_PUBLIC_API_URL=https://api.beacon.thiluxan.com
INTERNAL_API_URL=http://server:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_or_test_xxx
CLERK_SECRET_KEY=sk_live_or_test_xxx
CLERK_WEBHOOK_SECRET=whsec_xxx
INTEGRATIONS_ENCRYPTION_KEY=changeme-openssl-rand-base64-32
# Email alerts (Phase 5b) — both optional. Unset → alerting disabled, worker idles cleanly.
RESEND_API_KEY=re_xxx
ALERT_FROM_EMAIL=alerts@thiluxan.com
# Public demo mode (Phase 6a) — optional. Set to the owner's Clerk id to enable /demo; unset = off.
PUBLIC_OWNER_CLERK_ID=user_xxx
```

The WebSocket URL (`NEXT_PUBLIC_WS_URL`, e.g. `wss://api.beacon.thiluxan.com/ws`) landed in Phase 3b. Because it is a `NEXT_PUBLIC_*` var, it is inlined into the web bundle at **build time** — it is baked into the web image by the CI build-arg (see the deploy workflow), not read from `/opt/beacon/.env` at runtime, so it does not appear in the list above. The Resend email-alert vars (`RESEND_API_KEY`, `ALERT_FROM_EMAIL`) landed in Phase 5b — see the Email alerts note below. `POSTGRES_PASSWORD`, `INTERNAL_API_SECRET`, and `INTEGRATIONS_ENCRYPTION_KEY` are each generated once with `openssl rand -base64 32`.

> **Before deploying Phase 4a:** the server now validates `INTEGRATIONS_ENCRYPTION_KEY` at startup (used for AES-256-GCM encryption of integration credentials at rest) — both `server` and `worker` will crash-loop without it. Generate it with `openssl rand -base64 32` and add it to `/opt/beacon/.env` *before* the first Phase 4a deploy runs; `deploy.sh` also fail-fasts with a clear error if it's missing. Losing this key means losing access to all encrypted integration credentials in the database — they'd need to be reconfigured — so keep it backed up alongside the other VPS secrets.

### Email alerts (Resend — Phase 5b)

The alert reconciler (a background loop in the `worker` process) emails me when a service incident opens and when it recovers on its own. Delivery is via **Resend's REST API over `fetch`** — no SDK dependency, no new Compose service.

Setup:

1. **Create a Resend account** and add a **sending domain** — a subdomain like `mail.thiluxan.com` is cleanest. Resend gives you DNS records (SPF/DKIM `TXT`, and a DMARC record); add them at Namecheap and wait for Resend to show the domain **Verified**. Email from an unverified domain is rejected.
2. Create an API key and set two vars in `/opt/beacon/.env`:
   - `RESEND_API_KEY=re_…`
   - `ALERT_FROM_EMAIL=alerts@mail.thiluxan.com` (an address on the verified domain).
3. Redeploy so the `worker` picks them up.

**Both vars are optional and safe by default.** If either is unset (or blank), the env schema still validates, the worker logs `alerts disabled: email not configured` once and idles (it runs no alert queries), and the rest of the app is unaffected — so a VPS without Resend configured, or local dev, boots and runs cleanly. There is no `deploy.sh` fail-fast for these (unlike `INTEGRATIONS_ENCRYPTION_KEY`) precisely because absence is a supported state.

The destination address is configured in-app on `/settings` (defaults to the Clerk account email); alerts can be toggled globally and per-service there. `ALERT_FROM_EMAIL` is only the *sender*.

### Public demo mode (Phase 6a)

`PUBLIC_OWNER_CLERK_ID` is the single, optional gate for the anonymous read-only demo. Set it to the owner's Clerk user id to enable the public `/demo` dashboard and the anonymous WebSocket lane; **unset (or blank) disables the feature entirely** — the public read endpoints return `404`, the anonymous WS upgrade is rejected, and `/demo` renders a "not enabled" state. It is read live from `process.env` (like the Resend vars), so toggling it and restarting the `server` cleanly turns the demo on or off with no rebuild.

The read-only guarantee is enforced structurally, not by convention:

- **Only opt-in entities are ever exposed.** Services and domains carry an `is_public` flag (default `false`, toggled per-entity on `/settings`); the public endpoints and the anonymous WS only ever return/stream `is_public` rows, and incidents inherit visibility from their service. Public DTOs are minimal — name/status/timings only, **no** base URLs, config, credentials, or alert settings.
- **The anonymous lane cannot mutate.** The public WS connection (`?public=1`, no token) is receive-only and scoped: it may subscribe **only** to `service:<id>` topics for public services — `global` and private-service topics are refused server-side. There is no anonymous write path; every mutation still goes through a Clerk session (Server Actions) or the internal secret (`/internal/*`), neither of which the demo lane holds.
- **The public read endpoints are still secret-gated.** `/internal/public/*` requires `INTERNAL_API_SECRET` (the web server proxies them server-side); they are never exposed directly to the browser.

#### Runbook — enabling & curating the public demo

The app user (`thiluxan`, uid 1000) **owns `/opt/beacon/.env` and is in the `docker` group**, so none of this needs `sudo` or `root`. (`sudo` would prompt for `thiluxan`'s password anyway — *not* root's, and *not* the DigitalOcean droplet password, which is root-only and usable via the web Console.)

**1. Find the owner's Clerk user id.** It must match a row in the `users` table (the anonymous WS resolves the owner by it):

```bash
cd /opt/beacon
docker compose exec postgres psql -U beacon -d beacon -c "select clerk_user_id, email from users;"
```

**2. Add the var to `/opt/beacon/.env`.** Use an editor (`nano /opt/beacon/.env`) or append with **`>>`** — never `>`, which would wipe every prod secret in that file:

```bash
echo 'PUBLIC_OWNER_CLERK_ID=user_xxxxxxxx' >> /opt/beacon/.env   # note the double >>
grep -n PUBLIC_OWNER_CLERK_ID /opt/beacon/.env                   # confirm it's there exactly once
```

**3. Recreate the `server` container so it re-reads `.env`.** `docker compose restart` will *not* reload `env_file` — the container must be recreated. But a bare `docker compose up -d server` fails: an interactive shell has no `BEACON_VERSION`, so Compose resolves the image to `:latest`, which isn't present locally and triggers a pull of the **private** ghcr image → `error from registry: denied`. Pin the tag that's already running and skip the registry:

```bash
docker compose images server                                     # note the TAG (a git SHA)
BEACON_VERSION=<that-tag> docker compose up -d --pull never --force-recreate server
docker compose logs --tail=20 server                             # expect "listening on ... 3001" + "LISTEN beacon_events started"
```

`--pull never` uses the local image (no registry contact); `--force-recreate` guarantees the new env is loaded. The `.env` line persists across future deploys (the pipeline sets `BEACON_VERSION` itself), so the manual pin is a one-time thing for interactive restarts.

**4. Verify** — via the public URL, **not** `localhost:3001`. The server port is `expose`d on the Docker network only (not `ports:`-published), so `curl localhost:3001` from the host returns `000` (nothing listening) — that's by design, not a fault. Test the real path:

```bash
curl -s https://beacon.thiluxan.com/demo | grep -c "read-only"   # 1 = public mode on, 0 = disabled
```

**5. Curate what's shown.** Everything is private by default. Add services (`/services`) and domains (`/domains`) in the dashboard, then `/settings` → **Public dashboard** → tick the per-entity **public** boxes. New entities sit at *pending* until the worker checks them (services within seconds, domains within a minute), so add them a few minutes before showing anyone.

**Health-check gotcha (the trailing-slash 308).** The checker requests `${baseUrl}${healthCheckPath}` with `redirect: 'manual'` and expects an exact `200` — it does **not** follow redirects. So a base URL with a trailing slash plus a `/` path becomes `https://host//` (double slash), which platforms like Vercel answer with a `308` redirect → recorded as a failure. Fix: **no trailing slash on the base URL**, and point the path at a route that returns a direct `200` (any 3xx counts as not-`200`). Expected status codes aren't editable in the UI, so match a real `200` endpoint rather than trying to whitelist the redirect.

**Rollback** (turn the demo fully off):

```bash
sed -i '/^PUBLIC_OWNER_CLERK_ID=/d' /opt/beacon/.env
docker compose images server            # get the running tag again
BEACON_VERSION=<that-tag> docker compose up -d --pull never --force-recreate server
```

`/demo` immediately reverts to the "not enabled" state and the anonymous WS is rejected; the private app is unaffected either way.

---

## DNS

### DNS configuration (Namecheap)

> **Deviation from the original plan:** the stack doc envisioned Cloudflare as the DNS provider + proxy. In practice `thiluxan.com` is managed at **Namecheap**, and Phase 2 shipped with Namecheap DNS and **no proxy in front of the VPS**. Caddy on the droplet terminates TLS directly via Let's Encrypt, so the proxy layer was never required to ship. The trade-off accepted: no Cloudflare DDoS protection / origin-IP hiding / CDN. Revisit if those become necessary (would mean moving the domain's nameservers to Cloudflare).

- Domain: `beacon.thiluxan.com` (web) and `api.beacon.thiluxan.com` (API/WS), managed in Namecheap → Advanced DNS.
- DNS records (both **plain A records**, no proxy):
  - Host `beacon` → A record → VPS IP.
  - Host `api.beacon` → A record → VPS IP.
- Namecheap quirk: the Host field takes only the subdomain (`api.beacon`), not the full FQDN — Namecheap appends `.thiluxan.com`.
- Because there is no proxy, there is no grey-cloud/orange-cloud flip and no Cloudflare SSL mode to set: add the records once and Caddy issues the certs on first deploy.

---

## Reverse proxy (Caddy)

### Why Caddy

Auto-SSL via Let's Encrypt with zero config. Caddy renews certificates automatically and handles HTTPS-by-default without manual cron jobs or Certbot. Simpler than Nginx for this use case.

### Caddyfile

Lives at `infrastructure/Caddyfile` in the repo, deployed to `/opt/beacon/Caddyfile` on the VPS, mounted into the Caddy container via Docker Compose.

```caddy
# beacon.<domain> — Next.js web app
beacon.thiluxan.com {
  reverse_proxy web:3000
  
  # Standard hardening headers
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
  }
  
  encode gzip zstd
}

# api.beacon.<domain> — Hono API + WebSocket
api.beacon.thiluxan.com {
  reverse_proxy server:3001
  
  # WebSocket support is automatic with reverse_proxy directive.
  
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
  }
}
```

Caddy stores certificates in a Docker volume so they survive container restarts.

---

## Docker Compose

The entire production stack runs from one `docker-compose.yml` at `infrastructure/docker-compose.yml`. Lives in the repo; deployed to the VPS; runs there.

Services:
- `caddy` — reverse proxy.
- `web` — Next.js app, built from `apps/web`.
- `server` — Hono API + WebSocket, built from `apps/server`.
- `worker` — same image as `server`, runs the background check worker (`npm run worker`).
- `postgres` — Postgres 16, with volume mount for data persistence.

### Background worker

A `worker` service runs in the Compose stack using the same `beacon-server` image with `command: npm run worker` (entry `apps/server/src/workers/index.ts`). It polls Postgres for due service checks every ~5s, runs HTTP health checks with a per-check timeout, and writes results + status. It publishes no ports and is restarted by Docker if it crashes (stateless — it resumes from the DB). Locally it runs as part of `npm run dev`.

Image strategy:
- Web and server images are built by GitHub Actions, pushed to GitHub Container Registry (`ghcr.io/thiluxan-s/beacon-web:<sha>`, etc.).
- The Compose file references these tagged images.
- Deploy = update the image tag in the Compose file and `docker compose pull && docker compose up -d`.

Local development uses `docker-compose.dev.yml` (overrides) which builds locally and mounts source for hot reload. Production uses pulled images.

The worker also runs a daily maintenance pass: once per 24h it prunes `service_checks` rows older than 30 days so the history table stays bounded. This is best-effort — a failure is logged and never crashes the poll loop.

As of Phase 5c the same `worker` process also runs a **domain worker** loop (~30s poll) that checks tracked domains' DNS (native `dns`), SSL cert expiry/issuer (native `tls` on :443), and registration expiry. Registration expiry is looked up via **RDAP over HTTPS to `rdap.org`** — so the worker makes outbound HTTPS to `rdap.org` in addition to the endpoints it already reaches (the monitored services and, if configured, `api.resend.com`). Egress is already open, so **no firewall change and no new secret** is needed. RDAP failures (a registry without RDAP, a multi-part TLD the apex fallback can't resolve) degrade to a null/"unknown" registration date — never a crash. DNS + SSL are always checked regardless.

---

### Real-time (WebSockets)

The API host also serves a WebSocket endpoint at `wss://api.beacon.thiluxan.com/ws` (Caddy upgrades it automatically via the `reverse_proxy` directive — no extra Caddy config). Clients authenticate with their Clerk session token passed as a `?token=` query param, verified server-side via `@clerk/backend` (`CLERK_SECRET_KEY`). Status changes reach clients through Postgres `LISTEN/NOTIFY`: on a status change the worker emits `pg_notify('beacon_events', …)` inside the same transaction that writes the status, and the server's dedicated `LISTEN beacon_events` connection relays each event, in memory, to the subscribed sockets — filtered to the owning user and to the `global` / `service:<id>` topic. This slice adds **no new Compose service** (the WS lives in the existing `server` process) and no new runtime secret on the VPS; `CLERK_SECRET_KEY` is already present and `NEXT_PUBLIC_WS_URL` is baked into the web image at build time.

---

## Deploy pipeline

### Trigger

Pushing to `main` triggers GitHub Actions. PR builds run typecheck/lint/test but don't deploy.

### Stages

```
1. checkout
2. install (npm ci across workspaces)
3. typecheck (npm run typecheck across workspaces)
4. lint (npm run lint across workspaces)
5. test (workspace-level Vitest where present)
6. build web image (Docker buildx, multi-platform amd64)
7. build server image (Docker buildx)
8. push both images to ghcr.io with SHA tag
9. SSH into VPS
10. Pull new images
11. Run any pending DB migrations (`npm run db:migrate` inside the server container)
12. docker compose up -d (rolling update)
13. Verify: curl beacon.<domain>/health expects 200 within 30s, else exit non-zero
14. If verify fails: roll back by updating tag back to previous SHA, up -d again, notify
```

The deploy script lives at `infrastructure/deploy/deploy.sh`. CI calls it over SSH.

### Secrets in CI

GitHub Actions secrets:
- `SSH_PRIVATE_KEY` — deploy key for SSH access to VPS.
- `SSH_HOST_FINGERPRINT` — host's SHA256 key fingerprint, pinned by the deploy workflow to prevent MITM.
- `GHCR_TOKEN` — for pushing images (or use GITHUB_TOKEN).
- Production environment variables are NOT in CI — they live on the VPS in `/opt/beacon/.env`.

### Rollback procedure

```bash
# SSH into VPS
cd /opt/beacon

# Find the previous image tag
docker images | grep ghcr.io/thiluxan-s/beacon

# Update docker-compose.yml to reference the previous tag (or use env var BEACON_VERSION)
# Then:
docker compose pull
docker compose up -d
```

Document the SHAs of known-good deploys somewhere — Git tags work well, e.g., `git tag -a v1.0.0` on known-stable commits.

---

## Database

### Production Postgres

Runs as a Docker container in the Compose stack. Data persisted in a named volume (`beacon_postgres_data`) on the VPS.

Connection: the `server` container connects via the Docker network at `postgres:5432`. No external network exposure for the database — it's only reachable from within the Docker Compose network.

### Migrations

Drizzle migrations live in the repo at `apps/server/drizzle/`. On every deploy, the deploy script runs:

```bash
docker compose run --rm server npm run db:migrate
```

before bringing up the new server. If a migration fails, the deploy aborts before flipping traffic.

### Backups

Nightly cron job on the VPS:

```bash
# /etc/cron.d/beacon-backup
0 3 * * * thiluxan /opt/beacon/scripts/backup.sh
```

The script:
1. `docker compose exec postgres pg_dump -U beacon beacon | gzip > /tmp/beacon-$(date +%F).sql.gz`
2. `rclone copy /tmp/beacon-*.sql.gz remote:beacon-backups/`
3. Delete local copy.
4. Prune old backups in R2 (keep last 30 days).

Rclone is configured with a Cloudflare R2 remote. R2 free tier: 10 GB storage, plenty for daily SQL dumps. R2 API keys live in `/root/.config/rclone/rclone.conf`, 600 permissions, owned by root.

### Restore procedure

```bash
# Download a backup
rclone copy remote:beacon-backups/beacon-YYYY-MM-DD.sql.gz /tmp/

# Restore
gunzip -c /tmp/beacon-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U beacon -d beacon
```

Test this procedure at least once before considering Beacon "production." Document the date of the last verified restore here.

> **Last verified restore:** TBD — verify in Phase 5.

---

## Self-monitoring

The dashboard cannot reliably alert on its own downtime — if the server is down, it can't send anything. External watcher needed.

**UptimeRobot** (free tier):
- Monitor 1: `https://beacon.thiluxan.com` — every 5 minutes.
- Monitor 2: `https://api.beacon.thiluxan.com/health` — every 5 minutes.
- Alerts: email to my personal address.

If both UptimeRobot monitors go red, the dashboard is genuinely down and I need to SSH in.

---

## Runbook — first-time provisioning (Phase 2)

1. Create the droplet (DigitalOcean → Ubuntu 24.04, $12/2GB, TOR1) with your SSH key.
2. As root: `bash bootstrap-vps.sh "<your-ssh-public-key>"` (creates user `thiluxan`, hardens SSH, ufw, fail2ban, Docker, `/opt/beacon`).
3. Copy `infrastructure/docker-compose.yml`, `infrastructure/Caddyfile`, and `infrastructure/deploy/deploy.sh` to `/opt/beacon/` (deploy/ keeps deploy.sh). Copy `infrastructure/scripts/` too.
4. Create `/opt/beacon/.env` (chmod 600) from `infrastructure/.env.production.example` with real secrets: generate `POSTGRES_PASSWORD` and `INTERNAL_API_SECRET` (`openssl rand -base64 32`), paste production Clerk keys.
5. Namecheap (Advanced DNS): add two **A records** → droplet IP — Host `beacon` and Host `api.beacon` (Host field is the subdomain only; Namecheap appends `.thiluxan.com`). No proxy, so there is nothing to flip afterwards — Caddy issues Let's Encrypt certs on first deploy. Verify with `dig +short beacon.thiluxan.com` / `dig +short api.beacon.thiluxan.com` (both must return the droplet IP — watch for typos).
6. GitHub repo secrets (4 total): `SSH_PRIVATE_KEY` (private deploy key for user `thiluxan`), `SSH_HOST` (droplet IP), `SSH_HOST_FINGERPRINT`, and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (the `pk_live_…` key — **required at build time**, the web image bakes `NEXT_PUBLIC_*` in during the CI build; setting it only in `/opt/beacon/.env` is NOT enough). For the fingerprint, generate the **ECDSA** key's SHA256 (appleboy/ssh-action's Go SSH client negotiates the ECDSA host key, not ed25519): `ssh-keyscan -t ecdsa <ip> | ssh-keygen -lf - | cut -d ' ' -f2` → yields `SHA256:...`.
7. Clerk dashboard: add a production webhook → `https://beacon.thiluxan.com/api/clerk/webhook`, subscribe `user.created`/`user.updated`, copy the signing secret into `/opt/beacon/.env` as `CLERK_WEBHOOK_SECRET`.
8. First deploy: push to `main` (or re-run the workflow). Watch GitHub Actions. **Note:** on the very first deploy Caddy is still obtaining Let's Encrypt certs, so `deploy.sh`'s HTTPS health checks can fail (and, with no previous version, the job reports failure) even though the stack came up — give it a minute and re-run the workflow once the cert is issued. On success, visit `https://beacon.thiluxan.com`, sign in, and confirm a row: `BEACON_VERSION=$(cat /opt/beacon/.deployed_version) docker compose exec postgres psql -U beacon -d beacon -c 'select clerk_user_id, email from users;'`.
9. Tag the known-good deploy: `git tag -a v0.2.0 -m "First production deploy" && git push --tags`.

---

## Runbook — common problems and fixes

### "I can't reach the dashboard"

1. `ssh thiluxan@<vps-ip>` — can you even SSH in?
2. `docker compose ps` — are containers running?
3. `docker compose logs --tail=200 caddy` — is Caddy crashing? SSL renewal failed?
4. `docker compose logs --tail=200 web` — is Next.js crashing?
5. Check DigitalOcean dashboard — is the Droplet alive?
6. Check Namecheap DNS — do `beacon`/`api.beacon` still resolve to the droplet IP (`dig +short …`)? Has a record changed?

### "Status checks are running but data isn't updating"

1. `docker compose logs --tail=200 check-worker` — worker crashed?
2. `docker compose logs --tail=200 server` — server up?
3. WebSocket layer issue — check browser console for connection errors.

### "Postgres is broken"

1. `docker compose logs postgres` — what's it saying?
2. Check disk space: `df -h`. If full, free space and restart.
3. If genuinely corrupted: restore from the most recent backup (see above).

### "I need to deploy but CI is broken"

Manual deploy as fallback:

```bash
ssh thiluxan@<vps-ip>
cd /opt/beacon
# Set the version
export BEACON_VERSION=<some-sha>
docker compose pull
docker compose up -d
```

---

## Cost ledger

Track real monthly costs here so it's visible.

| Item | Monthly | Notes |
|------|---------|-------|
| DigitalOcean Droplet | $12 | 1 vCPU / 2GB, chosen for WS/worker headroom |
| DNS (Namecheap) | $0 | Plain A records, no proxy (Caddy terminates TLS) |
| Cloudflare R2 (backups) | $0 | Within free tier |
| UptimeRobot | $0 | Free tier (50 monitors, 5min intervals) |
| Domain | $0 | Already owned (`thiluxan.com`) |
| Resend (alert emails) | $0 | Within free tier (3000/mo) |
| **Total** | **~$12/mo** | |

If costs change (e.g., bumping the Droplet size), update this table.

---

## Phase-by-phase infrastructure work

Most infrastructure is set up in Phase 2 (after Phase 1 builds the app locally). Subsequent phases add:

- **Phase 3:** Workers running on the VPS, alert email delivery.
- **Phase 5:** UptimeRobot configured. Backups verified end-to-end.
- **Phase 6:** Custom domain finalized, hardening pass, restore procedure tested.

Each phase's doc lists the infrastructure work for that phase. This document accumulates the *current state*.
