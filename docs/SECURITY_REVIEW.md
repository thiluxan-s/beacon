# Security Review

Phase 6 final security review — a whole-app audit against the Phase 6 checklist plus the Phase 6a public-demo enforcement.

- **Reviewed:** `main` @ `4991568`, 2026-07-10.
- **Method:** static review of the codebase, infrastructure config, and git history; the Phase 6a public-demo enforcement was additionally verified live earlier (secret-gated `404`, minimal DTOs, anon WS refusing `global`/private topics).
- **Bottom line:** no Critical or High findings. One Medium (availability) and a few low/hardening items, tracked below.
- **Update (2026-07-11):** all findings are now **resolved or accepted** — every code/infra fix is deployed and verified live in production, and both Ops items (firewall/SSH, token rotation) are confirmed done. The review is closed.

## Status summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | No connection cap on the anonymous WebSocket | Medium | Fixed (this PR) |
| 2 | No Content-Security-Policy header | Low | Fixed — Report-Only (PR #21) then enforced (PR #22); live in prod |
| 3 | API host missing `X-Content-Type-Options: nosniff` | Low | Fixed — live in prod, verified (PRs #23, #24) |
| 4 | Internal-secret compare not constant-time | Low | Fixed (this PR) |
| 5 | WS auth token passed as `?token=` query param | Low | Accepted (browser WS can't set headers) |
| 6 | Firewall/SSH runtime state unverified | Ops | Verified on VPS — ufw active (22/80/443 only), root-login + password-auth disabled |
| 7 | Rotate leaked Vercel + GitHub tokens | Ops | Resolved — both revoked + recreated, integrations re-attached |

## Verified strong (no action)

- **No secrets in git history.** Only placeholder values appear in planning docs (`a-32-char-minimum-secret-value-1234`, `sk_live_or_test_xxx`); no GitHub or Vercel tokens were ever committed. `.gitignore` covers `.env`, `.env.local`, `.env*.local`, `.env.production`; only `.env.example` files are tracked.
- **Integration credentials** are encrypted at rest with **AES-256-GCM** (`apps/server/src/lib/crypto.ts`): random 12-byte IV per blob, 16-byte auth tag, a version byte for scheme evolution, key validated as exactly 32 bytes at startup. Credentials are **never** returned to the client (`toIntegrationDto` omits `credentialsEncrypted`); the encrypt/decrypt round-trip is covered by passing tests.
- **No SQL injection surface.** Every `sql`` `` `` usage is Drizzle-parameterized (bound params) or a static literal; `pg_notify` payloads and `make_interval(days => …)` are bound, not string-concatenated.
- **Clerk webhook** verifies the svix HMAC signature (`svix` `Webhook.verify`); an invalid signature returns `400`; events are processed only after verification succeeds.
- **Internal API** (`/internal/*`) requires the shared secret on every route; Caddy additionally returns `404` for `/internal/*` on the public API host (defense-in-depth), and the server port is published only on the Docker network (not the host). CORS is locked to a single `WEB_ORIGIN` (not a wildcard).
- **Error handling** returns generic messages to clients; full detail is logged server-side only.
- **Public `/demo` lane (Phase 6a):** the anonymous WebSocket is receive-only and topic-scoped — it refuses `global` and private-service topics and serves only `is_public` entities as minimal DTOs; the public read endpoints return `404` when the feature is disabled. Verified live.

## Findings

### 1. No connection cap on the anonymous WebSocket — Medium (availability)

The public WS lane (`?public=1`) opens a receive-only connection with no authentication, and nothing caps the number of concurrent anonymous connections or throttles `subscribe` frames (each `subscribe` triggers a DB lookup — `isServicePublic` / owner resolution). On the small single-VPS host, an attacker could open many connections to exhaust memory or the DB connection pool.

Mitigations already present: a heartbeat reaps dead connections (30s ping, dropped after 2 misses), and UptimeRobot alerts on downtime. Rate limiting was explicitly deferred in the Phase 6a scope.

**Fix (this PR):** a global ceiling on concurrent anonymous connections, enforced at the WS upgrade before the handshake completes. Authenticated (owner) connections are unaffected. A per-IP cap remains a possible future enhancement.

### 2. No Content-Security-Policy header — Low

The web host sets HSTS (with preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`, but no CSP — the largest remaining header-hardening item.

**Deferred to its own PR.** A CSP interacts with Next.js inline/hydration scripts and Clerk's scripts and can silently break the app, so it must be validated against the running application — ideally shipped in `Content-Security-Policy-Report-Only` mode first, then enforced. Kept out of this batch so it can't endanger the safe fixes.

**Status:** A nonce-based CSP now ships in `Content-Security-Policy-Report-Only` mode via `clerkMiddleware`'s `contentSecurityPolicy` option (`strict: true`), with `connect-src` derived from the API/WS env URLs (see `docs/superpowers/specs/2026-07-11-csp-report-only-design.md`). Runtime validation surfaced — and fixed — a real defect: under `strict-dynamic`, Clerk's own `clerk.browser.js` was blocked because it lacked the per-request nonce; the fix is `<ClerkProvider dynamic>`, which routes Clerk through its nonce-aware script path (verified: header nonce == script nonce, no violations in the browser). **Enforced:** after the Report-Only header was validated against production (prod header nonce matched Clerk's prod `clerk.beacon.thiluxan.com` script nonce, zero violations in-browser, `connect-src` carrying the real `https`/`wss://api.beacon.thiluxan.com` origins), the `reportOnly` flag was removed so the browser now blocks on violation. Rollback is a one-line revert (`reportOnly: true`) + redeploy.

### 3. API host missing `X-Content-Type-Options: nosniff` — Low

`api.beacon.thiluxan.com` sets only HSTS. `nosniff` is good practice even on a JSON API.

**Fix:** add `X-Content-Type-Options: nosniff` to the API host's header block in the Caddyfile.

**Status (live + verified):** `nosniff` is deployed on `api.beacon.thiluxan.com` — `curl -sI https://api.beacon.thiluxan.com/health` returns `x-content-type-options: nosniff`. Applying it exposed a deploy-pipeline gap: CI only ever pulled app images and never synced the Caddyfile to the VPS, and an initial `caddy reload` was a no-op because the Caddyfile is a **single-file bind mount** whose inode goes stale when scp atomically replaces the file. Closed across **PR #23** (CI now scp's `Caddyfile`/`docker-compose.yml`/`deploy.sh` to `/opt/beacon`, never `.env`) and **PR #24** (`deploy.sh` **recreates** the caddy container — validating the new config in a throwaway container first — instead of reloading). Infra-as-code config changes now ship and apply automatically. See `docs/INFRASTRUCTURE.md` → Caddyfile / deploy pipeline.

### 4. Internal-secret comparison is not constant-time — Low

The `/internal/*` guards compare the header against `INTERNAL_API_SECRET` with `!==`, which short-circuits and is not constant-time. Practical risk is very low (the endpoint isn't publicly reachable), but a timing-safe compare is cheap defense-in-depth.

**Fix (this PR):** compare with `crypto.timingSafeEqual` via a shared helper, applied to every internal-secret guard.

### 5. WS auth token in the query string — Low (accepted)

Authenticated clients pass their Clerk token as `?token=`, which can surface in proxy/access logs. Browsers cannot set custom headers on a `WebSocket`, so query-param or subprotocol are the only options; this is an accepted constraint. Mitigation: ensure Caddy access logging does not persist query strings (Caddy does not log to disk by default).

### 6. Verify firewall/SSH runtime state on the VPS — Ops

The hardening is documented (ufw allowing only 22/80/443, `PermitRootLogin no`, `PasswordAuthentication no`, fail2ban) but cannot be confirmed from the repo. Verify on the box:

```bash
sudo ufw status verbose
sudo sshd -T | grep -Ei 'permitrootlogin|passwordauthentication'
```

**Verified (2026-07-11):** `ufw status verbose` → `Status: active`, `Default: deny (incoming)` + `deny (routed)`, with only `22/tcp`, `80/tcp`, `443/tcp` allowed in (v4 + v6). SSH: the `sshd_config.d/00-beacon-hardening.conf` drop-in sets `PermitRootLogin no` + `PasswordAuthentication no`, and — because the main config's `Include …sshd_config.d/*.conf` precedes its stock `PermitRootLogin yes` — first-match-wins makes the hardened values effective.

### 7. Rotate the leaked Vercel + GitHub tokens — Ops

A real Vercel token and GitHub PAT were exposed in dev logs during earlier phase smoke tests. They are **not** in git history, but they should still be revoked and recreated.

**Resolved (2026-07-11):** both tokens revoked and recreated at their providers, and the Vercel/GitHub integrations re-attached in-app (credentials are stored AES-256-GCM-encrypted, never in the repo/CI/`.env`). The original dev-log leak vector is also closed — `apps/web/next.config.ts` sets `logging: { serverFunctions: false }`, so Next no longer echoes Server Action arguments (including credential fields) into the dev log.
