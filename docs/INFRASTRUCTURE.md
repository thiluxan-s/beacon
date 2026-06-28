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
```

The integration credentials key (`INTEGRATIONS_ENCRYPTION_KEY`), Resend email vars (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`), and the WebSocket URL (`NEXT_PUBLIC_WS_URL`) arrive in later phases as those features land, and will be appended to this file then. `POSTGRES_PASSWORD` and `INTERNAL_API_SECRET` are each generated once with `openssl rand -base64 32`. When the integrations key is introduced, note that losing it means losing access to all encrypted integration credentials in the database — they'd need to be reconfigured — so document a rotation procedure here.

---

## DNS

### Cloudflare configuration

- Domain: TBD (subdomain on `thiluxan.com` likely — e.g., `beacon.thiluxan.com` and `api.beacon.thiluxan.com`).
- Cloudflare is the DNS provider; the orange-cloud proxy is enabled for the web app domain (DDoS protection, hides VPS IP).
- For the WebSocket subdomain (`api.beacon.thiluxan.com`), the orange cloud must allow WebSockets — Cloudflare supports this on all tiers, but verify in the Network tab of the dashboard. SSL/TLS mode: **Full (strict)** (Cloudflare validates the origin certificate, which Caddy provides via Let's Encrypt).
- DNS records:
  - `beacon` A record → VPS IP, proxied.
  - `api.beacon` A record → VPS IP, proxied.

### Why Cloudflare in front

Three reasons: DDoS protection (free), hiding the VPS IP from public DNS resolution, and a single place to manage DNS for all my projects. The downside (a layer of caching that complicates some debug scenarios) is manageable.

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
- `check-worker` — same image as `server`, different entrypoint command.
- `integration-worker` — same image, different entrypoint.
- `postgres` — Postgres 16, with volume mount for data persistence.

Image strategy:
- Web and server images are built by GitHub Actions, pushed to GitHub Container Registry (`ghcr.io/thiluxan-s/beacon-web:<sha>`, etc.).
- The Compose file references these tagged images.
- Deploy = update the image tag in the Compose file and `docker compose pull && docker compose up -d`.

Local development uses `docker-compose.dev.yml` (overrides) which builds locally and mounts source for hot reload. Production uses pulled images.

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
5. Cloudflare: add A records `beacon` and `api.beacon` → droplet IP. Start **DNS-only (grey cloud)** so Caddy can issue Let's Encrypt certs. Once `https://beacon.thiluxan.com` serves a valid cert, switch to **proxied (orange) + SSL Full (strict)**. Verify WebSockets are allowed on the API host (Network tab).
6. GitHub repo secrets: `SSH_PRIVATE_KEY` (deploy key for user `thiluxan`), `SSH_HOST` (droplet IP), `SSH_HOST_FINGERPRINT` (the host's SHA256 key fingerprint, pinned by the deploy workflow — generate with `ssh-keyscan -t ed25519 <ip> | ssh-keygen -lf - | cut -d ' ' -f2`, yields `SHA256:...`), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
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
6. Check Cloudflare — is the proxy enabled? Has anything changed?

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
| Cloudflare | $0 | Free tier |
| Cloudflare R2 (backups) | $0 | Within free tier |
| UptimeRobot | $0 | Free tier (50 monitors, 5min intervals) |
| Domain | $0 | Already owned (`thiluxan.com`) |
| Resend (alert emails) | $0 | Within free tier (3000/mo) |
| **Total** | **~$16/mo** | |

If costs change (e.g., bumping the Droplet size), update this table.

---

## Phase-by-phase infrastructure work

Most infrastructure is set up in Phase 2 (after Phase 1 builds the app locally). Subsequent phases add:

- **Phase 3:** Workers running on the VPS, alert email delivery.
- **Phase 5:** UptimeRobot configured. Backups verified end-to-end.
- **Phase 6:** Custom domain finalized, hardening pass, restore procedure tested.

Each phase's doc lists the infrastructure work for that phase. This document accumulates the *current state*.
