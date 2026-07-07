# Phase 5c — Domains Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-06
**Depends on:** Phase 5a (incidents) merged. **Stacked on Phase 5b (alerts)** — 5c shares files with 5b (`workers/index.ts`, `router.ts`, `layout.tsx`, `schema.ts`, `DATA_MODEL.md`), so the `phase-5c-domains` branch is cut from `phase-5b-alerts` (PR #13) to avoid merge conflicts. Its PR self-cleans to a 5c-only diff once #13 merges to `main`.

## Goal

Track domains as first-class monitored entities, separate from services: an hourly worker checks DNS resolution, SSL certificate expiry/issuer, and domain registration expiry; a `/domains` page lists them with days-until-expiry and a status that warns at 30 and 7 days. This is the third and final sub-phase of Phase 5.

## Non-goals (YAGNI / deferred)

- **Live WebSocket updates for domains.** Domains change ~hourly; the page server-renders fresh state on load, and a per-domain **Recheck now** covers "add and see it work." The WS hub (which routes on `serviceId`/`userId`) is untouched. (The PRD mentions live domain updates aspirationally; deferred.)
- **New dependencies.** DNS via native `dns`, SSL via native `tls`, registration via **RDAP over `fetch`** — no WHOIS library, no SDK.
- **Full SSL chain / hostname-mismatch validation.** v1 SSL validity = "a cert is present and not past its `valid_to`." Untrusted-CA / hostname-mismatch detection is deferred; the actionable v1 signal is expiry.
- **Registration expiry for every TLD.** RDAP coverage is best-effort — registries without RDAP, or that omit an expiration event, and multi-part TLDs (`.co.uk`) that the apex fallback can't resolve, leave `domain_expires_at` null ("unknown"). The phase doc explicitly accepts this.
- **Per-domain pause, editable check interval, a domain detail/history page, alerting on domain expiry.** Domains have no `paused` (delete instead); the interval stays the 3600s default (not surfaced in the form); the page is a single list (no detail view); expiry does not send emails in v1 (a possible later tie-in to 5b's alert engine).
- **`domain_checks` retention/pruning.** Hourly cadence = tiny volume; a pruning job is deferred (noted, not built).

## Key decisions (from brainstorm)

1. **Registration expiry via RDAP over `fetch`** — modern structured JSON (`events[]` → `eventAction:'expiration'`), no dependency, graceful null on absence. Chosen over a WHOIS library (adds a dep, brittle text parsing) and over deferring registration entirely.
2. **Server-render + manual recheck, no WS** — right for an hourly signal; the hub stays untouched.
3. **Status = worst-of DNS / SSL / registration.** DNS failure or an unreadable cert = `unhealthy`; anything past-due = `expired`; the min of SSL/registration days-until-expiry drives the 7-day (`expiring_soon`) and 30-day (`warning`) thresholds; unknown registration never falsely warns.
4. **`pending` added to the domain status enum** — a freshly-added domain reads honestly until its first check (matches how services use `pending`). Extends `DATA_MODEL.md`'s enum.
5. **SSL-unreadable (DNS resolves but no cert obtainable) classifies as `unhealthy`** — a monitored domain is expected to serve HTTPS; a broken TLS handshake is a real problem.

## Architecture fit

5c mirrors the shapes already proven in 5a/5b, adding a parallel "domains" stack next to "services":
- A **pure classifier** (`classifyDomain`) like 5a's `decideTransition` — exhaustively testable with no I/O.
- **Probes with pure parsing split from injected I/O** like 5b's email lib (`sendEmail`'s injected `fetch`) — the socket/DNS/`fetch` calls are injectable so tests never hit the network.
- A **background worker loop** like `check-worker`/`alert-worker`, registered as the 4th loop in `workers/index.ts`, with per-item and per-pass `try/catch`.
- A **repository** (`domains.ts`) as the sole DB access, like `services.ts`.
- **Owner-scoped `/internal/*` endpoints** with their own secret guard, like `/internal/incidents`.
- A **Server-Component page + client action components**, like the services pages.

Domains are deliberately independent of services/incidents/alerts — no foreign keys between them. Registration/SSL live on the `domains` row; DNS+SSL history in `domain_checks`.

## Design

### Schema additions

New enum: `domainStatus = pgEnum('domain_status', ['pending','healthy','warning','expiring_soon','expired','unhealthy'])`.

**`domains`** (per `DATA_MODEL.md`, plus `pending` default + the unique index):
```ts
{
  id: uuid (pk, defaultRandom)
  userId: uuid (fk → users.id, on delete cascade, indexed)
  domain: text (not null)                        // "wayfare.thiluxan.com"
  checkIntervalSeconds: integer (not null, default 3600)
  currentStatus: domainStatus (not null, default 'pending')
  sslExpiresAt: timestamptz (nullable)
  domainExpiresAt: timestamptz (nullable)
  sslIssuer: text (nullable)
  lastCheckAt: timestamptz (nullable)
  nextCheckAt: timestamptz (nullable)
  createdAt / updatedAt: timestamptz
}
```
Indexes: `uniqueIndex('domains_user_domain_idx').on(userId, domain)` (no duplicate adds per user); `index('domains_next_check_idx').on(nextCheckAt)` (worker's due query).

**`domain_checks`** (per `DATA_MODEL.md`):
```ts
{
  id: uuid (pk, defaultRandom)
  domainId: uuid (fk → domains.id, on delete cascade, indexed)
  checkedAt: timestamptz (not null, defaultNow)
  dnsResolved: boolean (not null)
  dnsIp: text (nullable)
  sslValid: boolean (nullable)
  sslExpiresAt: timestamptz (nullable)
  sslDaysUntilExpiry: integer (nullable)
  errorMessage: text (nullable)
}
```
Index: `index('domain_checks_domain_checked_idx').on(domainId, checkedAt)`.

Types: `Domain`/`NewDomain`, `DomainCheck`/`NewDomainCheck`. Migration generated, committed, applied locally.

### Probes (`workers/domain-probes.ts`) — pure parsing + injected I/O, never throw

```ts
export type DnsResult = { resolved: boolean; ip: string | null; error?: string };
export type SslResult = { expiresAt: Date | null; issuer: string | null; error?: string };
export type RdapResult = { expiresAt: Date | null; error?: string };

export function resolveDns(host: string, deps?: { lookup?: ... }): Promise<DnsResult>;
export function probeSsl(host: string, deps?: { connect?: ... }): Promise<SslResult>;
export function probeRdap(domain: string, deps?: { fetchFn?: typeof fetch }): Promise<RdapResult>;

// pure, unit-tested directly:
export function parseRdapExpiration(json: unknown): Date | null;   // events[] eventAction 'expiration' → Date
export function parseCertExpiry(cert: { valid_to?: string; issuer?: { O?: string; CN?: string } }): { expiresAt: Date | null; issuer: string | null };
```
- `resolveDns` — `dns.promises.lookup(host)` with a timeout; failure → `{ resolved:false, ip:null, error }`.
- `probeSsl` — `tls.connect(443, host, { servername: host, rejectUnauthorized: false })` (so an expired cert still yields its `valid_to`), read `getPeerCertificate()`, feed to `parseCertExpiry`; connection failure/timeout → `{ expiresAt:null, issuer:null, error }`. Socket destroyed after read.
- `probeRdap` — `fetch('https://rdap.org/domain/<domain>')`; on 200 → `parseRdapExpiration(await res.json())`; on non-200/parse-fail/network-fail → `{ expiresAt:null }`. Best-effort apex: try the domain as entered, then a last-two-labels fallback host; `null` if both miss.

All three catch everything and return a failed result — a probe never throws into the worker.

### Status classifier (`workers/domain-status.ts`) — pure

```ts
export function classifyDomain(input: {
  dnsResolved: boolean;
  sslExpiresAt: Date | null;      // null = no readable cert
  domainExpiresAt: Date | null;   // null = unknown registration
  now: Date;
}): 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';
```
Precedence (first match wins):
1. `!dnsResolved` → `unhealthy`
2. `sslExpiresAt === null` → `unhealthy`
3. `sslExpiresAt < now` OR (`domainExpiresAt && domainExpiresAt < now`) → `expired`
4. `min(sslDays, regDays) <= 7` → `expiring_soon` (`regDays = Infinity` when `domainExpiresAt` is null)
5. `min(sslDays, regDays) <= 30` → `warning`
6. else → `healthy`

`sslDays`/`regDays` = whole days from `now` to the respective date. Exhaustively unit-tested, no I/O.

### Domain worker (`workers/domain-worker.ts`)

`runDomainWorker(deps?)` — loop every `DOMAIN_POLL_INTERVAL_MS` (~30s), `findDueDomains(BATCH_LIMIT)` (`next_check_at <= now`), and for each (bounded concurrency, module in-flight guard like `check-worker`): run the three probes, `classifyDomain`, then `applyDomainCheckResult` — one transaction inserting a `domain_check` row and updating the `domains` row (`current_status`, `ssl_expires_at`, `domain_expires_at`, `ssl_issuer`, `last_check_at`, `next_check_at = now + interval`, `updated_at`). Per-domain and per-pass `try/catch` so one probe failure never crashes the loop. `deps` injects the three probe functions for the worker test. No `pg_notify` (domains don't push live). Registered as the 4th loop in `workers/index.ts` with the same `.catch` pattern.

### Repository (`db/repositories/domains.ts`)

```ts
createDomain(userId, { domain, checkIntervalSeconds }): Promise<Domain>;   // status 'pending', next_check_at = now
listDomainsByUser(userId): Promise<Domain[]>;                              // ordered by domain
getDomain(userId, id): Promise<Domain | null>;                            // uuid guard + ownership
deleteDomain(userId, id): Promise<boolean>;
findDueDomains(limit): Promise<Domain[]>;                                  // next_check_at <= now, order by next_check_at
applyDomainCheckResult({ domain, check, status, sslExpiresAt, domainExpiresAt, sslIssuer }): Promise<void>;
recheckDomain(userId, id): Promise<Domain | null>;                         // next_check_at = now, ownership-checked
```

### Shared schema (`packages/shared`)

```ts
DomainCreateSchema = z.object({
  domain: z.string().trim().regex(HOSTNAME_RE, 'must be a valid domain'),  // case-insensitive; rejects scheme/path/spaces
  checkIntervalSeconds: z.number().int().min(300).max(86_400).default(3600),
});
```
`HOSTNAME_RE` matches dot-separated DNS labels with a TLD (case-insensitive); the form only submits `domain`. **Case is normalized in `createDomain`** (stores `domain.toLowerCase()`) rather than via a Zod transform, so `(user, domain)` uniqueness is effectively case-insensitive without depending on a specific Zod string-transform version.

### HTTP API (`router.ts`, `/internal/domains`, own secret guards + `resolveUserId`)

- `GET /internal/domains` → `listDomainsByUser`.
- `POST /internal/domains` → validate `DomainCreateSchema` (400 on bad domain), `createDomain`, 201. A duplicate `(user, domain)` violates the unique index; `createDomain` catches the Postgres unique-violation (code `23505`) and the route returns **409** with a clean "already tracked" message (no raw constraint text).
- `DELETE /internal/domains/:id` → `deleteDomain` (204/404).
- `POST /internal/domains/:id/recheck` → `recheckDomain` (200 with the row / 404).

Two `app.use` guards (`/internal/domains` and `/internal/domains/*`) checking `x-internal-secret`, mirroring `/internal/incidents`.

### Web (`apps/web`)

- `lib/domains-api.ts` (server-only): `DomainDto`, `fetchDomains`, `createDomainOnServer`, `deleteDomainOnServer`, `recheckDomainOnServer` — mirrors `services-api.ts`.
- `lib/domain-status-style.ts`: `DOMAIN_STATUS_STYLE` (status → `{ text, dot }` tokens) + `formatDaysUntil(date | null)` → `"23d"` / `"expired"` / `"—"`.
- `app/(app)/domains/page.tsx` (Server Component, `currentUser()` + `notFound()`, DB-outage-resilient like the other pages): dense list — **domain · status (dot+label) · SSL (days/expired) · registration (days/"unknown") · DNS (ok/fail)** — with a top **issues strip** counting `warning`+`expiring_soon`+`expired` domains (the 30/7-day banners), an **Add domain** dialog, and per-row **Recheck** / **Delete**. Skeleton/empty states consistent with the services list.
- `components/domains/domain-form-dialog.tsx` (client add form) + `domain-row-actions.tsx` (client recheck/delete via `useTransition`), mirroring the services equivalents.
- `app/(app)/domains/actions.ts`: `createDomainAction`, `deleteDomainAction`, `recheckDomainAction` (`{ok}|{ok,error}`, `revalidatePath('/domains')`).
- `DOMAINS` nav link in `app/(app)/layout.tsx`. Full frontend-design pass on the list.

### Docs / infra

- `DATA_MODEL.md`: the `pending` enum value + the `(user_id, domain)` unique index.
- `INFRASTRUCTURE.md`: one line that the worker makes outbound HTTPS to `rdap.org` (egress already open for service checks + Resend — no firewall change; no new secret).

## Data flow

```
add domain (status pending, next_check_at = now)
domain worker tick (~30s) → findDueDomains picks it
  resolveDns + probeSsl + probeRdap  (each injected/timeout-guarded, never throws)
  classifyDomain(dns, sslExpiresAt, domainExpiresAt, now) → status
  applyDomainCheckResult: insert domain_check + update domains row (status, ssl/reg/issuer, next_check_at = now + 3600)
/domains (Server Component) reads current state on load
Recheck now → next_check_at = now → picked up next tick → revalidate
```

## Error handling

- Probes never throw — each returns a failed result; the worker's per-domain and per-pass `try/catch` keep the loop alive.
- API returns the existing RFC-7807-style problem details; a duplicate domain surfaces a clean "already tracked" message, not a raw constraint error; no internal detail leaked.
- A domain that resolves DNS but serves no readable cert becomes `unhealthy` (not a crash).
- RDAP/registration failures degrade to `domain_expires_at = null`, never failing the whole check.

## Testing (TDD)

- `workers/domain-status.test.ts` — `classifyDomain` exhaustive: DNS-fail → unhealthy; no-cert → unhealthy; past-due SSL/registration → expired; `min(ssl,reg) ≤ 7` → expiring_soon; `≤ 30` → warning; both > 30 (or reg unknown) → healthy; unknown registration never warns.
- `workers/domain-probes.test.ts` — pure `parseRdapExpiration` (fixture with an expiration event → Date; without → null; malformed → null) and `parseCertExpiry` (cert → `valid_to` Date + issuer); `probeRdap` with an injected `fetch` (200 fixture → date; non-200 → null); `resolveDns`/`probeSsl` with injected primitives returning failure → failed result. No network.
- `db/repositories/domains.test.ts` (integration) — CRUD, `findDueDomains` (due vs not-due), `applyDomainCheckResult` (writes the check + updates the row), `recheckDomain` (sets next_check_at now), ownership (non-owner gets null/no-op), the unique `(user, domain)` rejects a duplicate.
- `workers/domain-worker.test.ts` (integration, injected probes) — a due domain gets one `domain_check` row and its `domains` row updated to the classified status + fields; a probe-failure domain becomes `unhealthy` without crashing the pass.
- `router` domains tests — auth (401), ownership, CRUD + recheck, bad domain → 400, duplicate add → 409.
- `packages/shared` — `DomainCreateSchema` accepts valid domains, rejects URLs/spaces/empty.
- Web: no component tests (convention) — typecheck + lint.

## What "done" looks like

1. `npm run typecheck` + `npm run lint` clean (all workspaces).
2. Migration generated, committed, applied locally (`domains`, `domain_checks`, `domain_status` enum, the unique index).
3. Happy path verified end-to-end: add a real domain (e.g. `thiluxan.com`) → within ~30s it shows `healthy` with SSL days-until-expiry, registration days (or "unknown"), DNS ok. Add a domain with a soon-expiring or expired cert → shows `warning`/`expiring_soon`/`expired`. Recheck now reflects a change within a poll. Delete removes it.
4. Failure cases handled: a non-resolving domain → `unhealthy`; a TLD without RDAP → registration "unknown" but SSL/DNS still reported; a duplicate add → clean error.
5. `DATA_MODEL.md` + `INFRASTRUCTURE.md` updated.
6. No new env vars, no new dependencies.
7. Approved before commit; branch `phase-5c-domains` (cut from `phase-5b-alerts`).
