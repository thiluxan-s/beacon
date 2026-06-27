# Phase 2 — VPS Setup & Production Deploy

**Goal:** What we built in Phase 1 is now running on a real VPS at a real URL, with SSL, deployed via GitHub Actions on every push to main. The "self-hosted on DigitalOcean" portfolio story becomes real this phase.

**Prerequisite:** Phase 1 complete.

> **Heads up:** this is the most infrastructure-heavy phase. Budget two weekends, not one. Don't compress.

## Deliverables (high level)

1. **DigitalOcean Droplet provisioned** — Ubuntu 24.04 LTS, $6 or $12 size.
2. **Server hardening** — non-root user, SSH key auth only, ufw firewall, fail2ban, automatic security updates. All steps documented in `INFRASTRUCTURE.md`.
3. **Docker + Docker Compose installed** on the VPS.
4. **Production `docker-compose.yml`** at `infrastructure/docker-compose.yml` defining web, server, postgres, caddy. References images from `ghcr.io`.
5. **Caddy reverse proxy** with auto-SSL via Let's Encrypt. Routes configured for `beacon.<domain>` and `api.beacon.<domain>`.
6. **DNS configured** through Cloudflare. Subdomain points to VPS IP. Cloudflare proxy enabled with Full (strict) SSL mode.
7. **GitHub Actions workflow** — on push to main: typecheck, lint, test, build both Docker images, push to `ghcr.io`, SSH to VPS, pull new images, run migrations, `docker compose up -d`, verify with health check.
8. **Production `.env`** on the VPS at `/opt/beacon/.env` with all required vars (encryption key, Clerk keys, etc.).
9. **Manual deploy script** at `infrastructure/deploy/deploy.sh` as the actual logic CI invokes — works for manual deploys too.
10. **External monitoring** via UptimeRobot on the public URLs.
11. **Backup script** at `infrastructure/scripts/backup.sh` + cron entry. Verified working with at least one successful nightly backup to Cloudflare R2.
12. **First production deploy** — sign-in works on the live URL, the User row gets created.
13. **`INFRASTRUCTURE.md` updated** to reflect actual setup, with the runbook verified.

## Notes for when we get here

- **Don't deploy first, then harden.** Harden the VPS (firewall, SSH, fail2ban) before opening any application ports.
- Cloudflare's Full (strict) SSL mode requires Caddy's origin cert to be valid. Caddy provisions Let's Encrypt automatically; verify both are working before flipping the orange cloud on.
- The deploy script should be **idempotent**. Running it twice in a row should be a no-op if there's nothing to deploy.
- Test the rollback procedure before considering this phase done. Tag a deploy, then intentionally roll back to it. If you can't roll back cleanly, the deploy pipeline is incomplete.
- Test the database restore procedure before considering this phase done. Restore a backup to a test database, verify data integrity, document the date in `INFRASTRUCTURE.md`.
- This phase's commits will mostly be in `infrastructure/` and `.github/workflows/`. App code changes should be minimal — that's a sign the architecture is right.

### Carry-forward from the Phase 1 final review

- **Lock down `/internal/*` at the reverse proxy.** `POST /internal/users/upsert` is guarded only by the `INTERNAL_API_SECRET` shared secret (a plain `!==` comparison — fine on a private localhost network, not constant-time). Once Caddy sits in front of the server, this path must NOT be publicly reachable: block `/internal/*` at Caddy, or bind it to an internal-only interface / Docker network. Make this a deliberate decision, not an oversight.
- **Add an internal web→server URL.** The web server process calls the API via `NEXT_PUBLIC_API_URL` (`api-client.ts`, `ensure-user-exists.ts`). In production that would round-trip out through the public URL/Caddy. Introduce a separate `INTERNAL_API_URL` (Docker service name / internal hostname) for server-to-server traffic and use it in those two call sites; keep `NEXT_PUBLIC_API_URL` for anything that must run in the browser.

---

(More detail to be added before starting this phase.)
