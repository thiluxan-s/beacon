# Phase 5c — Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track domains as first-class monitored entities — an hourly worker checks DNS, SSL expiry/issuer, and registration expiry (RDAP), surfaced on a `/domains` page that warns at 30 and 7 days.

**Architecture:** A pure `classifyDomain` (worst-of DNS/SSL/registration) + three probes whose pure parsing is split from injected I/O (native `dns`/`tls` + RDAP-over-`fetch`, no deps), driven by a 4th background worker loop; a `domains` repository, owner-scoped `/internal/domains` endpoints, and a Server-Component `/domains` page with add/delete/recheck. Domains are independent of services/incidents/alerts.

**Tech Stack:** Node + Hono, Drizzle (Postgres), native `dns`/`tls`, RDAP over `fetch`, Next.js 16 (App Router), Zod, Vitest.

## Global Constraints

- TypeScript `strict`, **no `any`** — `unknown` + narrow. (CLAUDE.md)
- Zod is source of truth; DB types via Drizzle `$inferSelect`/`$inferInsert`. (CLAUDE.md)
- **All DB access through `db/repositories/`** — no raw Drizzle in routes/workers/components. (CLAUDE.md)
- Dates `timestamptz`, UTC; never store dates as strings. (CLAUDE.md)
- Background workers must never crash the loop on one failure — catch, log, continue. (CLAUDE.md)
- Default to Server Components; `"use client"` only for state/effects. (CLAUDE.md)
- **No new npm dependencies** — DNS via native `dns`, SSL via native `tls`, registration via RDAP over `fetch`. (spec)
- Probes **never throw** — each returns a failed result; the worker keeps going. (spec)
- Status precedence: `!dns` → unhealthy; no readable cert → unhealthy; SSL or registration past-due → expired; `min(sslDays, regDays) ≤ 7` → expiring_soon; `≤ 30` → warning; else healthy. Registration unknown = `Infinity` (never falsely warns). (spec)
- `domain_status` enum = `['pending','healthy','warning','expiring_soon','expired','unhealthy']`. (spec)
- No live WS for domains — server-render + `recheck` (sets `next_check_at = now`). (spec)
- Case is normalized in `createDomain` (`domain.toLowerCase()`); duplicate `(user, domain)` → Postgres `23505` → route returns **409**. (spec)
- **Next 16 is not training-data Next** — the sibling pages under `apps/web/app/(app)/` are ground truth (the `node_modules/next/dist/docs/` path referenced by AGENTS.md may not exist in this install). (apps/web/AGENTS.md)
- Conventional commits. **Per-task commits on `phase-5c-domains` are authorized** (human's approval gate is the PR to main). Branch already created (cut from `phase-5b-alerts`).
- "Done" per task: `npm run typecheck` + `npm run lint` clean.

---

## File map

**Server**
- `apps/server/src/db/schema.ts` — Modify: `domain_status` enum, `domains` + `domain_checks` tables.
- `apps/server/src/workers/domain-status.ts` (+ `.test.ts`) — Create: pure `classifyDomain`.
- `apps/server/src/workers/domain-probes.ts` (+ `.test.ts`) — Create: pure parsers + injected-I/O probes.
- `apps/server/src/db/repositories/domains.ts` (+ `.test.ts`) — Create: CRUD + due + apply + recheck.
- `apps/server/src/router.ts` (+ `router.domains.test.ts`) — Modify: `/internal/domains` guards + routes.
- `apps/server/src/workers/domain-worker.ts` (+ `.test.ts`) — Create: `checkDomainOnce` + `runDomainWorker`.
- `apps/server/src/workers/index.ts` — Modify: register the 4th loop.

**Shared**
- `packages/shared/src/schemas/domain.ts` (+ `.test.ts`) — Create: `DomainCreateSchema`.
- `packages/shared/src/index.ts` — Modify: export it.

**Web**
- `apps/web/lib/domains-api.ts` — Create.
- `apps/web/lib/domain-status-style.ts` — Create.
- `apps/web/app/(app)/domains/actions.ts` — Create.
- `apps/web/app/(app)/domains/page.tsx` — Create.
- `apps/web/components/domains/domain-form-dialog.tsx` — Create (client).
- `apps/web/components/domains/domain-row-actions.tsx` — Create (client).
- `apps/web/app/(app)/layout.tsx` — Modify: DOMAINS nav link.

**Docs**
- `docs/DATA_MODEL.md` — Modify (Task 1).
- `docs/INFRASTRUCTURE.md` — Modify (Task 10).

---

## Task 1: Schema — domains + domain_checks + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `docs/DATA_MODEL.md`
- Create (generated): `apps/server/drizzle/<n>_*.sql`

**Interfaces:**
- Produces: `domains`, `domainChecks` tables; `domainStatus` enum; types `Domain`/`NewDomain`, `DomainCheck`/`NewDomainCheck`.

- [ ] **Step 1: Add the enum + tables to `schema.ts`**

`sql` is already imported. Add after the other enums:

```ts
export const domainStatus = pgEnum('domain_status', ['pending', 'healthy', 'warning', 'expiring_soon', 'expired', 'unhealthy']);
```

Add after `domainChecks`' natural neighbours (anywhere after `users`; group the two together):

```ts
export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    checkIntervalSeconds: integer('check_interval_seconds').notNull().default(3600),
    currentStatus: domainStatus('current_status').notNull().default('pending'),
    sslExpiresAt: timestamp('ssl_expires_at', { withTimezone: true }),
    domainExpiresAt: timestamp('domain_expires_at', { withTimezone: true }),
    sslIssuer: text('ssl_issuer'),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('domains_user_domain_idx').on(t.userId, t.domain),
    index('domains_next_check_idx').on(t.nextCheckAt),
  ],
);

export const domainChecks = pgTable(
  'domain_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    dnsResolved: boolean('dns_resolved').notNull(),
    dnsIp: text('dns_ip'),
    sslValid: boolean('ssl_valid'),
    sslExpiresAt: timestamp('ssl_expires_at', { withTimezone: true }),
    sslDaysUntilExpiry: integer('ssl_days_until_expiry'),
    errorMessage: text('error_message'),
  },
  (t) => [index('domain_checks_domain_checked_idx').on(t.domainId, t.checkedAt)],
);

export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
export type DomainCheck = typeof domainChecks.$inferSelect;
export type NewDomainCheck = typeof domainChecks.$inferInsert;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `apps/server/drizzle/*.sql` with `CREATE TYPE "domain_status"`, `CREATE TABLE "domains"` + `"domain_checks"`, a `CREATE UNIQUE INDEX "domains_user_domain_idx"`, and the two FKs `ON DELETE cascade`.

- [ ] **Step 3: Apply + typecheck**

Run: `npm run db:migrate` (clean apply), then `npm run typecheck` (PASS).

- [ ] **Step 4: Update `DATA_MODEL.md`**

In the `domains` section: add the `pending` value to the `current_status` enum and note the unique `(user_id, domain)` index (no duplicate adds per user).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle docs/DATA_MODEL.md
git commit -m "feat(server): domains + domain_checks schema"
```

---

## Task 2: Pure domain status classifier

**Files:**
- Create: `apps/server/src/workers/domain-status.ts`, `apps/server/src/workers/domain-status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DomainStatus = 'pending' | 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';
  export function classifyDomain(input: { dnsResolved: boolean; sslExpiresAt: Date | null; domainExpiresAt: Date | null; now: Date }): Exclude<DomainStatus, 'pending'>;
  export const WARN_DAYS = 30;
  export const SOON_DAYS = 7;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/workers/domain-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyDomain } from './domain-status';

const now = new Date('2026-07-06T00:00:00.000Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('classifyDomain', () => {
  it('DNS failure is unhealthy regardless of SSL', () => {
    expect(classifyDomain({ dnsResolved: false, sslExpiresAt: inDays(200), domainExpiresAt: inDays(200), now })).toBe('unhealthy');
  });
  it('no readable cert (null) is unhealthy', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: null, domainExpiresAt: inDays(200), now })).toBe('unhealthy');
  });
  it('past-due SSL is expired', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(-1), domainExpiresAt: inDays(200), now })).toBe('expired');
  });
  it('past-due registration is expired', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(-1), now })).toBe('expired');
  });
  it('SSL within 7 days is expiring_soon', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(5), domainExpiresAt: inDays(200), now })).toBe('expiring_soon');
  });
  it('registration within 7 days is expiring_soon (worst-of)', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(3), now })).toBe('expiring_soon');
  });
  it('within 30 days is warning', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(20), domainExpiresAt: inDays(200), now })).toBe('warning');
  });
  it('both far out is healthy', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(300), now })).toBe('healthy');
  });
  it('unknown registration never warns on its own', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: null, now })).toBe('healthy');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- domain-status`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `domain-status.ts`**

```ts
export type DomainStatus = 'pending' | 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';

export const WARN_DAYS = 30;
export const SOON_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export function classifyDomain(input: {
  dnsResolved: boolean;
  sslExpiresAt: Date | null;
  domainExpiresAt: Date | null;
  now: Date;
}): Exclude<DomainStatus, 'pending'> {
  const { dnsResolved, sslExpiresAt, domainExpiresAt, now } = input;
  if (!dnsResolved) return 'unhealthy';
  if (sslExpiresAt === null) return 'unhealthy';

  const t = now.getTime();
  if (sslExpiresAt.getTime() < t || (domainExpiresAt !== null && domainExpiresAt.getTime() < t)) {
    return 'expired';
  }

  const sslDays = Math.floor((sslExpiresAt.getTime() - t) / MS_PER_DAY);
  const regDays = domainExpiresAt !== null ? Math.floor((domainExpiresAt.getTime() - t) / MS_PER_DAY) : Infinity;
  const worst = Math.min(sslDays, regDays);

  if (worst <= SOON_DAYS) return 'expiring_soon';
  if (worst <= WARN_DAYS) return 'warning';
  return 'healthy';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run --workspace @beacon/server test -- domain-status`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workers/domain-status.ts apps/server/src/workers/domain-status.test.ts
git commit -m "feat(server): pure classifyDomain (worst-of DNS/SSL/registration)"
```

---

## Task 3: Domain probes — pure parsers + injected I/O

**Files:**
- Create: `apps/server/src/workers/domain-probes.ts`, `apps/server/src/workers/domain-probes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DnsResult = { resolved: boolean; ip: string | null; error?: string };
  export type SslResult = { expiresAt: Date | null; issuer: string | null; error?: string };
  export type RdapResult = { expiresAt: Date | null; error?: string };
  export type CertLike = { valid_to?: string; issuer?: { O?: string; CN?: string } } | null;
  export function parseRdapExpiration(json: unknown): Date | null;
  export function parseCertExpiry(cert: CertLike): { expiresAt: Date | null; issuer: string | null };
  export function resolveDns(host: string, deps?: { lookup?: (h: string) => Promise<{ address: string }> }): Promise<DnsResult>;
  export function probeSsl(host: string, deps?: { getCert?: (h: string) => Promise<CertLike> }): Promise<SslResult>;
  export function probeRdap(domain: string, deps?: { fetchFn?: typeof fetch }): Promise<RdapResult>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/workers/domain-probes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseRdapExpiration, parseCertExpiry, resolveDns, probeSsl, probeRdap } from './domain-probes';

describe('parseRdapExpiration', () => {
  it('extracts the expiration event date', () => {
    const json = { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-04T00:00:00Z' }] };
    expect(parseRdapExpiration(json)?.toISOString()).toBe('2027-03-04T00:00:00.000Z');
  });
  it('returns null when no expiration event', () => {
    expect(parseRdapExpiration({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] })).toBeNull();
  });
  it('returns null on malformed input', () => {
    expect(parseRdapExpiration(null)).toBeNull();
    expect(parseRdapExpiration({ events: 'nope' })).toBeNull();
    expect(parseRdapExpiration({ events: [{ eventAction: 'expiration', eventDate: 'not-a-date' }] })).toBeNull();
  });
});

describe('parseCertExpiry', () => {
  it('reads valid_to and issuer O', () => {
    const r = parseCertExpiry({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { O: "Let's Encrypt", CN: 'R3' } });
    expect(r.expiresAt?.getFullYear()).toBe(2027);
    expect(r.issuer).toBe("Let's Encrypt");
  });
  it('falls back to issuer CN, and nulls on missing cert', () => {
    expect(parseCertExpiry({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { CN: 'R3' } }).issuer).toBe('R3');
    expect(parseCertExpiry(null)).toEqual({ expiresAt: null, issuer: null });
    expect(parseCertExpiry({}).expiresAt).toBeNull();
  });
});

describe('resolveDns', () => {
  it('resolved with ip on success', async () => {
    const r = await resolveDns('x.com', { lookup: async () => ({ address: '1.2.3.4' }) });
    expect(r).toEqual({ resolved: true, ip: '1.2.3.4' });
  });
  it('not resolved on failure', async () => {
    const r = await resolveDns('x.com', { lookup: async () => { throw new Error('ENOTFOUND'); } });
    expect(r.resolved).toBe(false);
    expect(r.ip).toBeNull();
  });
});

describe('probeSsl', () => {
  it('parses a returned cert', async () => {
    const r = await probeSsl('x.com', { getCert: async () => ({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { O: 'CA' } }) });
    expect(r.expiresAt?.getFullYear()).toBe(2027);
    expect(r.issuer).toBe('CA');
  });
  it('nulls with error when the cert fetch throws', async () => {
    const r = await probeSsl('x.com', { getCert: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.expiresAt).toBeNull();
    expect(r.error).toBeDefined();
  });
});

describe('probeRdap', () => {
  it('returns the expiration on a 200', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: '2027-03-04T00:00:00Z' }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await probeRdap('x.com', { fetchFn });
    expect(r.expiresAt?.toISOString()).toBe('2027-03-04T00:00:00.000Z');
  });
  it('returns null when all candidates fail', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const r = await probeRdap('sub.x.com', { fetchFn });
    expect(r.expiresAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- domain-probes`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `domain-probes.ts`**

```ts
import { promises as dnsPromises } from 'node:dns';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';

export type DnsResult = { resolved: boolean; ip: string | null; error?: string };
export type SslResult = { expiresAt: Date | null; issuer: string | null; error?: string };
export type RdapResult = { expiresAt: Date | null; error?: string };
export type CertLike = { valid_to?: string; issuer?: { O?: string; CN?: string } } | null;

const PROBE_TIMEOUT_MS = 10_000;

export function parseRdapExpiration(json: unknown): Date | null {
  if (typeof json !== 'object' || json === null) return null;
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    if (ev && typeof ev === 'object' && (ev as { eventAction?: unknown }).eventAction === 'expiration') {
      const date = (ev as { eventDate?: unknown }).eventDate;
      if (typeof date === 'string') {
        const d = new Date(date);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  }
  return null;
}

export function parseCertExpiry(cert: CertLike): { expiresAt: Date | null; issuer: string | null } {
  if (!cert || typeof cert.valid_to !== 'string') return { expiresAt: null, issuer: null };
  const d = new Date(cert.valid_to);
  const expiresAt = Number.isNaN(d.getTime()) ? null : d;
  const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? null;
  return { expiresAt, issuer };
}

export async function resolveDns(
  host: string,
  deps: { lookup?: (h: string) => Promise<{ address: string }> } = {},
): Promise<DnsResult> {
  const lookup = deps.lookup ?? ((h: string) => dnsPromises.lookup(h));
  try {
    const res = await lookup(host);
    return { resolved: true, ip: res.address ?? null };
  } catch (err) {
    return { resolved: false, ip: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// Default cert fetch: TLS-connect on 443 with rejectUnauthorized:false so an
// expired cert still yields its valid_to. Boundary adapter — the parsing it
// feeds (parseCertExpiry) is what's unit-tested; this socket code is injected
// past in tests via deps.getCert.
function defaultGetCert(host: string): Promise<CertLike> {
  return new Promise<CertLike>((resolve) => {
    let settled = false;
    const finish = (v: CertLike) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(v);
    };
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate() as PeerCertificate | undefined;
      finish(cert && Object.keys(cert).length > 0 ? (cert as CertLike) : null);
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    socket.on('error', () => finish(null));
  });
}

export async function probeSsl(
  host: string,
  deps: { getCert?: (h: string) => Promise<CertLike> } = {},
): Promise<SslResult> {
  const getCert = deps.getCert ?? defaultGetCert;
  try {
    const cert = await getCert(host);
    return parseCertExpiry(cert);
  } catch (err) {
    return { expiresAt: null, issuer: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function rdapCandidates(domain: string): string[] {
  const labels = domain.split('.');
  if (labels.length <= 2) return [domain];
  return [domain, labels.slice(-2).join('.')];
}

export async function probeRdap(
  domain: string,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<RdapResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  for (const cand of rdapCandidates(domain)) {
    try {
      const res = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(cand)}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const exp = parseRdapExpiration(await res.json());
      if (exp) return { expiresAt: exp };
    } catch {
      // try the next candidate
    }
  }
  return { expiresAt: null };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run --workspace @beacon/server test -- domain-probes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workers/domain-probes.ts apps/server/src/workers/domain-probes.test.ts
git commit -m "feat(server): domain probes — DNS/SSL/RDAP with pure parsers + injected I/O"
```

---

## Task 4: Shared DomainCreateSchema

**Files:**
- Create: `packages/shared/src/schemas/domain.ts`, `packages/shared/src/schemas/domain.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `DomainCreateSchema`, `type DomainCreateInput = { domain: string; checkIntervalSeconds: number }`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/schemas/domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DomainCreateSchema } from './domain';

describe('DomainCreateSchema', () => {
  it('accepts valid domains and defaults the interval', () => {
    const r = DomainCreateSchema.safeParse({ domain: 'thiluxan.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.checkIntervalSeconds).toBe(3600);
    expect(DomainCreateSchema.safeParse({ domain: 'sub.thiluxan.com' }).success).toBe(true);
    expect(DomainCreateSchema.safeParse({ domain: 'a.b.co.uk' }).success).toBe(true);
  });
  it('rejects urls, spaces, empty, and single labels', () => {
    for (const domain of ['https://x.com', 'has space.com', '', 'localhost', 'x.com/path']) {
      expect(DomainCreateSchema.safeParse({ domain }).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/shared test -- domain`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + export**

`packages/shared/src/schemas/domain.ts`:

```ts
import { z } from 'zod';

// Dot-separated DNS labels + a TLD; case-insensitive. Rejects scheme/path/spaces
// and single-label hosts (localhost). Case is normalized server-side in createDomain.
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export const DomainCreateSchema = z.object({
  domain: z.string().trim().regex(HOSTNAME_RE, 'must be a valid domain'),
  checkIntervalSeconds: z.number().int().min(300).max(86_400).default(3600),
});
export type DomainCreateInput = z.infer<typeof DomainCreateSchema>;
```

In `packages/shared/src/index.ts`, add (named-export style, matching the others):

```ts
export { DomainCreateSchema, type DomainCreateInput } from './schemas/domain';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run --workspace @beacon/shared test -- domain`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas/domain.ts packages/shared/src/schemas/domain.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): DomainCreateSchema"
```

---

## Task 5: Domains repository

**Files:**
- Create: `apps/server/src/db/repositories/domains.ts`, `apps/server/src/db/repositories/domains.test.ts`

**Interfaces:**
- Consumes: `domains`, `domainChecks`, `Domain` (schema); `DomainCreateInput` (shared); `Exclude<DomainStatus,'pending'>` (`../../workers/domain-status`).
- Produces:
  ```ts
  export class DomainExistsError extends Error {}
  export function createDomain(userId: string, input: DomainCreateInput): Promise<Domain>;
  export function listDomainsByUser(userId: string): Promise<Domain[]>;
  export function getDomain(userId: string, id: string): Promise<Domain | null>;
  export function deleteDomain(userId: string, id: string): Promise<boolean>;
  export function findDueDomains(limit: number): Promise<Domain[]>;
  export function recheckDomain(userId: string, id: string): Promise<Domain | null>;
  export function applyDomainCheckResult(args: {
    domain: Domain;
    check: { dnsResolved: boolean; dnsIp: string | null; sslValid: boolean | null; sslExpiresAt: Date | null; sslDaysUntilExpiry: number | null; errorMessage: string | null };
    status: Exclude<DomainStatus, 'pending'>;
    sslExpiresAt: Date | null;
    domainExpiresAt: Date | null;
    sslIssuer: string | null;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/domains.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { domainChecks } from '../schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from './users';
import {
  createDomain, listDomainsByUser, getDomain, deleteDomain,
  findDueDomains, recheckDomain, applyDomainCheckResult, DomainExistsError,
} from './domains';

async function makeUser(clerkId = 'dom_user') {
  return (await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` })).id;
}

describe('domains repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('creates a pending domain due now, lowercased', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'Thiluxan.COM', checkIntervalSeconds: 3600 });
    expect(d.domain).toBe('thiluxan.com');
    expect(d.currentStatus).toBe('pending');
    expect(d.nextCheckAt).not.toBeNull();
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(true);
  });

  it('rejects a duplicate (user, domain) with DomainExistsError', async () => {
    const userId = await makeUser();
    await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    await expect(createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 })).rejects.toBeInstanceOf(DomainExistsError);
  });

  it('lists/gets/deletes owner-scoped', async () => {
    const a = await makeUser('a'); const b = await makeUser('b');
    const d = await createDomain(a, { domain: 'a.com', checkIntervalSeconds: 3600 });
    expect(await listDomainsByUser(a)).toHaveLength(1);
    expect(await listDomainsByUser(b)).toHaveLength(0);
    expect(await getDomain(b, d.id)).toBeNull();
    expect(await deleteDomain(b, d.id)).toBe(false);
    expect(await deleteDomain(a, d.id)).toBe(true);
  });

  it('applyDomainCheckResult writes a check + updates the row', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    const ssl = new Date(Date.now() + 40 * 86_400_000);
    await applyDomainCheckResult({
      domain: d,
      check: { dnsResolved: true, dnsIp: '1.2.3.4', sslValid: true, sslExpiresAt: ssl, sslDaysUntilExpiry: 40, errorMessage: null },
      status: 'healthy', sslExpiresAt: ssl, domainExpiresAt: null, sslIssuer: 'CA',
    });
    const updated = await getDomain(userId, d.id);
    expect(updated?.currentStatus).toBe('healthy');
    expect(updated?.sslIssuer).toBe('CA');
    expect(updated?.lastCheckAt).not.toBeNull();
    const checks = await db.select().from(domainChecks).where(eq(domainChecks.domainId, d.id));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.dnsIp).toBe('1.2.3.4');
  });

  it('recheckDomain sets next_check_at to now, owner-scoped', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    // push it into the future first
    await applyDomainCheckResult({ domain: d, check: { dnsResolved: true, dnsIp: null, sslValid: true, sslExpiresAt: null, sslDaysUntilExpiry: null, errorMessage: null }, status: 'healthy', sslExpiresAt: null, domainExpiresAt: null, sslIssuer: null });
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(false);
    const re = await recheckDomain(userId, d.id);
    expect(re).not.toBeNull();
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- domains.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `domains.ts`**

```ts
import { and, asc, eq, lte } from 'drizzle-orm';
import type { DomainCreateInput } from '@beacon/shared';
import { db } from '../index';
import { domainChecks, domains, type Domain } from '../schema';
import type { DomainStatus } from '../../workers/domain-status';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID_RE.test(s);

export class DomainExistsError extends Error {}

export async function createDomain(userId: string, input: DomainCreateInput): Promise<Domain> {
  try {
    const rows = await db
      .insert(domains)
      .values({
        userId,
        domain: input.domain.toLowerCase(),
        checkIntervalSeconds: input.checkIntervalSeconds,
        currentStatus: 'pending',
        nextCheckAt: new Date(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createDomain: no row returned');
    return row;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
      throw new DomainExistsError('domain already tracked');
    }
    throw err;
  }
}

export async function listDomainsByUser(userId: string): Promise<Domain[]> {
  return db.select().from(domains).where(eq(domains.userId, userId)).orderBy(asc(domains.domain));
}

export async function getDomain(userId: string, id: string): Promise<Domain | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db.select().from(domains).where(and(eq(domains.id, id), eq(domains.userId, userId))).limit(1);
  return rows[0] ?? null;
}

export async function deleteDomain(userId: string, id: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(id)) return false;
  const rows = await db.delete(domains).where(and(eq(domains.id, id), eq(domains.userId, userId))).returning({ id: domains.id });
  return rows.length > 0;
}

export async function findDueDomains(limit: number): Promise<Domain[]> {
  return db.select().from(domains).where(lte(domains.nextCheckAt, new Date())).orderBy(asc(domains.nextCheckAt)).limit(limit);
}

export async function recheckDomain(userId: string, id: string): Promise<Domain | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .update(domains)
    .set({ nextCheckAt: new Date(), updatedAt: new Date() })
    .where(and(eq(domains.id, id), eq(domains.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function applyDomainCheckResult(args: {
  domain: Domain;
  check: { dnsResolved: boolean; dnsIp: string | null; sslValid: boolean | null; sslExpiresAt: Date | null; sslDaysUntilExpiry: number | null; errorMessage: string | null };
  status: Exclude<DomainStatus, 'pending'>;
  sslExpiresAt: Date | null;
  domainExpiresAt: Date | null;
  sslIssuer: string | null;
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.domain.checkIntervalSeconds * 1000);
  await db.transaction(async (tx) => {
    await tx.insert(domainChecks).values({ domainId: args.domain.id, checkedAt: now, ...args.check });
    await tx
      .update(domains)
      .set({
        currentStatus: args.status,
        sslExpiresAt: args.sslExpiresAt,
        domainExpiresAt: args.domainExpiresAt,
        sslIssuer: args.sslIssuer,
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
      })
      .where(eq(domains.id, args.domain.id));
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run --workspace @beacon/server test -- domains.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/domains.ts apps/server/src/db/repositories/domains.test.ts
git commit -m "feat(server): domains repository — CRUD, due, apply, recheck"
```

---

## Task 6: HTTP endpoints for domains

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.domains.test.ts`

**Interfaces:**
- Consumes: `createDomain`, `listDomainsByUser`, `deleteDomain`, `recheckDomain`, `DomainExistsError` (Task 5); `DomainCreateSchema` (shared).
- Produces: `GET`/`POST /internal/domains`, `DELETE`/`POST recheck /internal/domains/:id`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/router.domains.test.ts` (mirror `router.incidents.test.ts`):

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, init: RequestInit & { clerkId?: string } = {}) {
  const { clerkId, ...rest } = init;
  return app.request(path, { ...rest, headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, ...(clerkId ? { 'x-clerk-user-id': clerkId } : {}), 'content-type': 'application/json' } });
}

describe('domains routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without secret', async () => {
    expect((await app.request('/internal/domains')).status).toBe(401);
  });

  it('creates, lists, rechecks, deletes; rejects bad domain and duplicate', async () => {
    await upsertFromClerk({ clerkUserId: 'dr', email: 'dr@e.com' });
    const bad = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'https://x.com' }) });
    expect(bad.status).toBe(400);
    const created = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;
    const dup = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    expect(dup.status).toBe(409);
    const list = await req('/internal/domains', { clerkId: 'dr' });
    expect((await list.json()).domains).toHaveLength(1);
    expect((await req(`/internal/domains/${id}/recheck`, { method: 'POST', clerkId: 'dr' })).status).toBe(200);
    expect((await req(`/internal/domains/${id}`, { method: 'DELETE', clerkId: 'dr' })).status).toBe(204);
  });

  it('404 deleting a non-owned domain', async () => {
    await upsertFromClerk({ clerkUserId: 'owner', email: 'o@e.com' });
    await upsertFromClerk({ clerkUserId: 'intruder', email: 'i@e.com' });
    const created = await req('/internal/domains', { method: 'POST', clerkId: 'owner', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    const id = (await created.json()).id as string;
    expect((await req(`/internal/domains/${id}`, { method: 'DELETE', clerkId: 'intruder' })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- router.domains`
Expected: FAIL.

- [ ] **Step 3: Add guards + routes to `router.ts`**

Imports at top: `import { createDomain, listDomainsByUser, deleteDomain, recheckDomain, DomainExistsError } from './db/repositories/domains';` and add `DomainCreateSchema` to the `@beacon/shared` import.

After the other `/internal/*` guards:

```ts
  app.use('/internal/domains', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  app.use('/internal/domains/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
```

Handlers (before `return app;`):

```ts
  app.get('/internal/domains', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json({ domains: await listDomainsByUser(userId) });
  });

  app.post('/internal/domains', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = DomainCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    try {
      const domain = await createDomain(userId, parsed.data);
      return c.json(domain, 201);
    } catch (err) {
      if (err instanceof DomainExistsError) return c.json({ error: 'This domain is already tracked.' }, 409);
      throw err;
    }
  });

  app.delete('/internal/domains/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const ok = await deleteDomain(userId, c.req.param('id'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  app.post('/internal/domains/:id/recheck', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const domain = await recheckDomain(userId, c.req.param('id'));
    return domain ? c.json(domain) : c.json({ error: 'not found' }, 404);
  });
```

- [ ] **Step 4: Run tests + typecheck, commit**

Run: `npm run --workspace @beacon/server test -- router.domains` (PASS), `npm run typecheck` (PASS).

```bash
git add apps/server/src/router.ts apps/server/src/router.domains.test.ts
git commit -m "feat(server): /internal/domains CRUD + recheck endpoints"
```

---

## Task 7: Domain worker

**Files:**
- Create: `apps/server/src/workers/domain-worker.ts`, `apps/server/src/workers/domain-worker.test.ts`
- Modify: `apps/server/src/workers/index.ts`

**Interfaces:**
- Consumes: `classifyDomain` (Task 2); `resolveDns`, `probeSsl`, `probeRdap` + result types (Task 3); `findDueDomains`, `applyDomainCheckResult` (Task 5); `runBounded` (`../lib/concurrency`); `Domain` (schema).
- Produces: `type ProbeDeps`; `checkDomainOnce(domain, deps?)`; `runDomainWorker(deps?)`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/workers/domain-worker.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../db/index';
import { domainChecks, domains } from '../db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from '../db/repositories/users';
import { createDomain } from '../db/repositories/domains';
import { checkDomainOnce } from './domain-worker';

async function seed() {
  const u = await upsertFromClerk({ clerkUserId: 'dw', email: 'dw@e.com' });
  return createDomain(u.id, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
}

describe('domain worker checkDomainOnce (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('classifies healthy and writes a check + updates the row', async () => {
    const d = await seed();
    const ssl = new Date(Date.now() + 60 * 86_400_000);
    await checkDomainOnce(d, {
      resolveDns: async () => ({ resolved: true, ip: '1.2.3.4' }),
      probeSsl: async () => ({ expiresAt: ssl, issuer: 'CA' }),
      probeRdap: async () => ({ expiresAt: new Date(Date.now() + 300 * 86_400_000) }),
    });
    const row = (await db.select().from(domains).where(eq(domains.id, d.id)))[0]!;
    expect(row.currentStatus).toBe('healthy');
    expect(row.sslIssuer).toBe('CA');
    const checks = await db.select().from(domainChecks).where(eq(domainChecks.domainId, d.id));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.sslValid).toBe(true);
  });

  it('classifies unhealthy when DNS fails, without throwing', async () => {
    const d = await seed();
    await checkDomainOnce(d, {
      resolveDns: async () => ({ resolved: false, ip: null, error: 'ENOTFOUND' }),
      probeSsl: async () => ({ expiresAt: null, issuer: null, error: 'x' }),
      probeRdap: async () => ({ expiresAt: null }),
    });
    const row = (await db.select().from(domains).where(eq(domains.id, d.id)))[0]!;
    expect(row.currentStatus).toBe('unhealthy');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- domain-worker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `domain-worker.ts`**

```ts
import { findDueDomains, applyDomainCheckResult } from '../db/repositories/domains';
import { classifyDomain } from './domain-status';
import { probeRdap, probeSsl, resolveDns, type DnsResult, type RdapResult, type SslResult } from './domain-probes';
import { runBounded } from '../lib/concurrency';
import type { Domain } from '../db/schema';

const POLL_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 100;
const MAX_CONCURRENCY = 5;
const MS_PER_DAY = 86_400_000;

export type ProbeDeps = {
  resolveDns?: (host: string) => Promise<DnsResult>;
  probeSsl?: (host: string) => Promise<SslResult>;
  probeRdap?: (domain: string) => Promise<RdapResult>;
};

const inFlight = new Set<string>();

export async function checkDomainOnce(domain: Domain, deps: ProbeDeps = {}): Promise<void> {
  const dnsFn = deps.resolveDns ?? resolveDns;
  const sslFn = deps.probeSsl ?? probeSsl;
  const rdapFn = deps.probeRdap ?? probeRdap;
  const now = new Date();

  const [dns, ssl, rdap] = await Promise.all([dnsFn(domain.domain), sslFn(domain.domain), rdapFn(domain.domain)]);

  const status = classifyDomain({ dnsResolved: dns.resolved, sslExpiresAt: ssl.expiresAt, domainExpiresAt: rdap.expiresAt, now });
  const sslDays = ssl.expiresAt ? Math.floor((ssl.expiresAt.getTime() - now.getTime()) / MS_PER_DAY) : null;
  const sslValid = ssl.expiresAt ? ssl.expiresAt.getTime() > now.getTime() : null;

  await applyDomainCheckResult({
    domain,
    check: {
      dnsResolved: dns.resolved,
      dnsIp: dns.ip,
      sslValid,
      sslExpiresAt: ssl.expiresAt,
      sslDaysUntilExpiry: sslDays,
      errorMessage: dns.error ?? ssl.error ?? rdap.error ?? null,
    },
    status,
    sslExpiresAt: ssl.expiresAt,
    domainExpiresAt: rdap.expiresAt,
    sslIssuer: ssl.issuer,
  });
}

export async function runDomainWorker(deps: ProbeDeps = {}): Promise<never> {
  while (true) {
    try {
      const due = await findDueDomains(BATCH_LIMIT);
      const runnable = due.filter((d) => !inFlight.has(d.id));
      await runBounded(runnable, MAX_CONCURRENCY, async (d) => {
        inFlight.add(d.id);
        try {
          await checkDomainOnce(d, deps);
        } catch (err) {
          // one domain's failure must never crash the loop
          console.error('[beacon-domain] check failed', d.id, err);
        } finally {
          inFlight.delete(d.id);
        }
      });
    } catch (err) {
      console.error('[beacon-domain] poll cycle failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
```

- [ ] **Step 4: Register the loop in `workers/index.ts`**

Add `import { runDomainWorker } from './domain-worker';` and, after the alert loop:

```ts
console.log('[beacon-worker] starting domain loop');
void runDomainWorker().catch((err) => console.error('[beacon-worker] domain loop crashed', err));
```

- [ ] **Step 5: Run tests + typecheck, commit**

Run: `npm run --workspace @beacon/server test -- domain-worker` (PASS), `npm run typecheck` (PASS).

```bash
git add apps/server/src/workers/domain-worker.ts apps/server/src/workers/domain-worker.test.ts apps/server/src/workers/index.ts
git commit -m "feat(server): domain worker loop (DNS/SSL/RDAP → classify → persist)"
```

---

## Task 8: Web — domains API client + server actions

**Files:**
- Create: `apps/web/lib/domains-api.ts`, `apps/web/app/(app)/domains/actions.ts`

**Interfaces:**
- Consumes: the endpoints from Task 6; `DomainCreateSchema` (shared).
- Produces: `DomainDto`, `fetchDomains`, `createDomainOnServer`, `deleteDomainOnServer`, `recheckDomainOnServer`; actions `createDomainAction`, `deleteDomainAction`, `recheckDomainAction`.

- [ ] **Step 1: Implement the API client (mirrors `services-api.ts`)**

`apps/web/lib/domains-api.ts`:

```ts
import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type DomainDto = {
  id: string;
  domain: string;
  currentStatus: 'pending' | 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';
  sslExpiresAt: string | null;
  domainExpiresAt: string | null;
  sslIssuer: string | null;
  lastCheckAt: string | null;
};

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchDomains(clerkUserId: string): Promise<DomainDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchDomains failed: ${res.status}`);
  return (await res.json()).domains as DomainDto[];
}

export async function createDomainOnServer(clerkUserId: string, input: { domain: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains`, { method: 'POST', headers: headers(clerkUserId), body: JSON.stringify(input), cache: 'no-store' });
  if (res.ok) return { ok: true };
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: err.error ?? `Request failed (${res.status})` };
}

export async function deleteDomainOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}`, { method: 'DELETE', headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok && res.status !== 404) throw new Error(`deleteDomain failed: ${res.status}`);
}

export async function recheckDomainOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}/recheck`, { method: 'POST', headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`recheckDomain failed: ${res.status}`);
}
```

- [ ] **Step 2: Implement the server actions (mirrors `services/actions.ts`)**

`apps/web/app/(app)/domains/actions.ts`:

```ts
'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { DomainCreateSchema } from '@beacon/shared';

import { createDomainOnServer, deleteDomainOnServer, recheckDomainOnServer } from '@/lib/domains-api';

type Result = { ok: true } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function createDomainAction(input: unknown): Promise<Result> {
  const parsed = DomainCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const res = await createDomainOnServer(clerkId, { domain: parsed.data.domain });
    if (res.ok) revalidatePath('/domains');
    return res;
  } catch (err) {
    console.error('[beacon-web] createDomainAction failed', err);
    return { ok: false, error: 'Could not add the domain.' };
  }
}

export async function deleteDomainAction(id: string): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await deleteDomainOnServer(clerkId, id);
    revalidatePath('/domains');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] deleteDomainAction failed', err);
    return { ok: false, error: 'Could not delete the domain.' };
  }
}

export async function recheckDomainAction(id: string): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await recheckDomainOnServer(clerkId, id);
    revalidatePath('/domains');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] recheckDomainAction failed', err);
    return { ok: false, error: 'Could not recheck the domain.' };
  }
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` (PASS).

```bash
git add apps/web/lib/domains-api.ts "apps/web/app/(app)/domains/actions.ts"
git commit -m "feat(web): domains API client + server actions"
```

---

## Task 9: Web — /domains page + dialog + row actions + nav

**Files:**
- Create: `apps/web/lib/domain-status-style.ts`
- Create: `apps/web/components/domains/domain-form-dialog.tsx`, `apps/web/components/domains/domain-row-actions.tsx`
- Create: `apps/web/app/(app)/domains/page.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `fetchDomains`, `DomainDto` (Task 8); `createDomainAction`, `deleteDomainAction`, `recheckDomainAction` (Task 8).

- [ ] **Step 1: Read the existing pages**

Read `apps/web/app/(app)/services/page.tsx`, `apps/web/components/services/service-form-dialog.tsx`, `apps/web/components/services/service-row-actions.tsx`, and `apps/web/app/(app)/layout.tsx` — mirror their conventions (the Next 16 docs path in AGENTS.md may not exist; the pages are ground truth).

- [ ] **Step 2: Create `domain-status-style.ts`**

```ts
// Domain status → status tokens (globals.css @theme). warning/expiring lean amber,
// expired/unhealthy red, healthy green, pending neutral. The label carries the specifics.
export const DOMAIN_STATUS_STYLE: Record<string, { text: string; dot: string }> = {
  pending:       { text: 'text-zinc-400',        dot: 'bg-zinc-300' },
  healthy:       { text: 'text-status-up',       dot: 'bg-status-up' },
  warning:       { text: 'text-status-degraded', dot: 'bg-status-degraded' },
  expiring_soon: { text: 'text-status-degraded', dot: 'bg-status-degraded' },
  expired:       { text: 'text-status-down',     dot: 'bg-status-down' },
  unhealthy:     { text: 'text-status-down',     dot: 'bg-status-down' },
};

export function formatDaysUntil(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  return days < 0 ? 'expired' : `${days}d`;
}
```

- [ ] **Step 3: Create the add-domain dialog (client)**

`apps/web/components/domains/domain-form-dialog.tsx` — copy `service-form-dialog.tsx`'s structure (backdrop, Escape handling, `useTransition`) with a single `domain` field:

```tsx
'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createDomainAction } from '@/app/(app)/domains/actions';

export function DomainFormDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function close() { if (!pending) { setOpen(false); setError(null); } }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !pending) { setOpen(false); setError(null); } }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, pending]);

  function onSubmit(formData: FormData) {
    setError(null);
    const domain = String(formData.get('domain') ?? '');
    start(async () => {
      const res = await createDomainAction({ domain });
      if (res.ok) setOpen(false);
      else setError(res.error);
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add domain</Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add a domain">
          <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />
          <form action={onSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12">
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">Add a domain</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">Beacon will check DNS, SSL, and registration within a minute.</p>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="space-y-1.5">
                <label htmlFor="dfd-domain" className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400">Domain</label>
                <Input id="dfd-domain" name="domain" required autoFocus placeholder="thiluxan.com" className="h-8 font-mono text-[12px]" />
              </div>
              {error && <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">{error}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3.5">
              <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button type="submit" size="sm" disabled={pending}>{pending ? 'Adding…' : 'Add domain'}</Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Create the row actions (client)**

`apps/web/components/domains/domain-row-actions.tsx`:

```tsx
'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { deleteDomainAction, recheckDomainAction } from '@/app/(app)/domains/actions';

export function DomainRowActions({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await recheckDomainAction(id); })}>
        Recheck
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} className="text-status-down/80 hover:bg-red-50 hover:text-status-down" onClick={() => start(async () => { await deleteDomainAction(id); })}>
        Delete
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Create the `/domains` page (Server Component)**

`apps/web/app/(app)/domains/page.tsx` (mirrors `services/page.tsx`'s auth guard + DB-outage-resilient banner):

```tsx
import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchDomains, type DomainDto } from '@/lib/domains-api';
import { DOMAIN_STATUS_STYLE, formatDaysUntil } from '@/lib/domain-status-style';
import { relativeTime } from '@/lib/relative-time';
import { DomainFormDialog } from '@/components/domains/domain-form-dialog';
import { DomainRowActions } from '@/components/domains/domain-row-actions';

const ISSUE_STATUSES = new Set(['warning', 'expiring_soon', 'expired', 'unhealthy']);

export default async function DomainsPage() {
  const user = await currentUser();
  if (!user) notFound();

  let domains: DomainDto[] | null = null;
  try {
    domains = await fetchDomains(user.id);
  } catch (err) {
    console.error('[beacon-web] domains page load failed', err);
  }

  if (!domains) {
    return (
      <main className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
          <h1 className="text-sm font-semibold text-zinc-900">Domains</h1>
        </div>
        <div className="flex items-center gap-2 border-b border-zinc-200/40 bg-zinc-50/50 px-5 py-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400" aria-hidden="true" />
          <span className="font-mono text-[11px] text-zinc-500">Couldn’t load domains — retrying.</span>
        </div>
      </main>
    );
  }

  const issues = domains.filter((d) => ISSUE_STATUSES.has(d.currentStatus)).length;

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div>
          <h1 className="text-sm font-semibold text-zinc-900">Domains</h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">DNS, SSL, and registration health.</p>
        </div>
        <DomainFormDialog />
      </div>

      {domains.length > 0 && (
        <div className={['flex items-center gap-5 border-b px-5 py-2', issues > 0 ? 'border-red-100/80 bg-red-50/40' : 'border-zinc-200/40 bg-zinc-50/50'].join(' ')}>
          {issues > 0 ? (
            <span className="font-mono text-[11px] font-medium text-status-down">
              {issues} need{issues === 1 ? 's' : ''} attention
            </span>
          ) : (
            <span className="font-mono text-[11px] text-status-up/70">all domains healthy</span>
          )}
        </div>
      )}

      {domains.length === 0 ? (
        <p className="px-5 py-6 text-[12px] text-zinc-400">No domains tracked yet. Add one to watch its DNS, SSL, and registration.</p>
      ) : (
        <>
          <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
            <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Domain</span>
            <span className="w-28 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Status</span>
            <span className="w-16 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">SSL</span>
            <span className="w-20 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Registration</span>
            <span className="w-24 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Checked</span>
            <div className="w-[132px]" />
          </div>
          <ul className="divide-y divide-zinc-200/40">
            {domains.map((d) => {
              const style = DOMAIN_STATUS_STYLE[d.currentStatus] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300' };
              return (
                <li key={d.id} className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-zinc-50/70">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-900">{d.domain}</span>
                  <div className="flex w-28 items-center gap-1.5">
                    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                    <span className={`text-[12px] font-medium capitalize ${style.text}`}>{d.currentStatus.replace('_', ' ')}</span>
                  </div>
                  <span className="w-16 text-right font-mono text-[11px] tabular-nums text-zinc-500">{formatDaysUntil(d.sslExpiresAt)}</span>
                  <span className="w-20 text-right font-mono text-[11px] tabular-nums text-zinc-500">{formatDaysUntil(d.domainExpiresAt)}</span>
                  <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-400">{relativeTime(d.lastCheckAt)}</span>
                  <div className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                    <DomainRowActions id={d.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Add the DOMAINS nav link**

In `apps/web/app/(app)/layout.tsx`, add a `DOMAINS` link to the nav cluster (`SERVICES` / `INCIDENTS` / `SETTINGS`), matching that style.

- [ ] **Step 7: Design pass (frontend-design skill)**

Invoke the frontend-design skill: dense list consistent with the services/incidents pages; the issues strip mirrors the services one; make `expiring_soon`/`expired` read as more urgent than `warning` (label + dot). Document any real decision in `docs/DESIGN.md`.

- [ ] **Step 8: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` (PASS). Manually load `/domains`.

```bash
git add apps/web/lib/domain-status-style.ts apps/web/components/domains "apps/web/app/(app)/domains" apps/web/app/\(app\)/layout.tsx docs/DESIGN.md
git commit -m "feat(web): /domains page — list, add, recheck, delete + nav"
```

---

## Task 10: Infra docs + full verification

**Files:**
- Modify: `docs/INFRASTRUCTURE.md`

- [ ] **Step 1: Document the RDAP egress in `INFRASTRUCTURE.md`**

Add a one-line note (near the worker/background section) that the domain worker makes outbound HTTPS to `rdap.org` for registration-expiry lookups — egress is already open (service checks + Resend), no firewall change, no new secret. RDAP failures degrade to "unknown," never a crash.

- [ ] **Step 2: Full typecheck + lint + server suite**

Run: `npm run typecheck && npm run lint && npm run --workspace @beacon/server test`
Expected: all PASS.

- [ ] **Step 3: Manual happy-path (use the `run`/`verify` skill)**

With the app running: add `thiluxan.com` on `/domains` → within ~30s it shows `healthy` with SSL days-until-expiry, registration days (or "unknown"), DNS ok. Add a domain with a soon-expiring/expired cert (e.g. a known test endpoint) → `warning`/`expiring_soon`/`expired`. Click Recheck → reflects within a poll. Delete removes it. Add a non-resolving domain → `unhealthy`. Add a duplicate → clean "already tracked" error.

- [ ] **Step 4: Commit + finish the branch**

```bash
git add docs/INFRASTRUCTURE.md
git commit -m "docs(infra): domain worker RDAP egress note"
```

Then invoke `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** schema (T1), classifier (T2), probes (T3), shared schema (T4), repository (T5), endpoints (T6), worker (T7), web client + actions (T8), page + components + nav (T9), infra docs + verification (T10). Non-goals (live WS, deps, full chain validation, pause/interval/detail page, expiry alerting, pruning) not built.
- **Interface consistency:** `DomainStatus`/`classifyDomain` (T2) consumed by the repo's `applyDomainCheckResult` arg and the worker (T5, T7); `DnsResult`/`SslResult`/`RdapResult`/`CertLike` (T3) consumed by the worker's `ProbeDeps` (T7); `DomainCreateInput`/`DomainCreateSchema` (T4) consumed by the repo (T5), endpoint (T6), and action (T8); `DomainExistsError` (T5) caught in the endpoint (T6) → 409; `DomainDto` (T8) consumed by the page (T9). `createDomain` lowercases; the unique index + `23505` → `DomainExistsError` → 409 chain is consistent across T5/T6.
