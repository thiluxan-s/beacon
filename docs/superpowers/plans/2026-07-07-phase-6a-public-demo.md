# Phase 6a — Public Read-Only Demo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/demo` dashboard where an unauthenticated visitor watches real-time status of only the entities the owner marked public, with a hard guarantee they cannot mutate anything.

**Architecture:** A read-only lane beside the authed app — `is_public` opt-in flags, secret-gated public read endpoints (404 when disabled), and an anonymous receive-only WebSocket scoped to public service topics — gated by `PUBLIC_OWNER_CLERK_ID`. The mutation path (Server Action + internal secret) is untouched.

**Tech Stack:** Node + Hono, Drizzle (Postgres), native `ws`, Next.js 16 (App Router), Zod, Vitest.

## Global Constraints

- TypeScript `strict`, **no `any`**. (CLAUDE.md)
- Zod source of truth; DB types via `$inferSelect`/`$inferInsert`. (CLAUDE.md)
- All DB access through `db/repositories/`. (CLAUDE.md)
- Default to Server Components; `"use client"` only for state/effects/WS. (CLAUDE.md)
- **No new dependencies.** (spec)
- `is_public` defaults to `false` on `services` + `domains`; incidents inherit from their service. (spec)
- **`PUBLIC_OWNER_CLERK_ID` gates the whole feature** — unset → public endpoints `404`, anon WS rejected, `/demo` shows "not enabled." Read **live from `process.env`** (like the Resend vars) so it's testable and toggles cleanly. (spec)
- Anon WS is **receive-only**; a `public` conn may subscribe only to `service:<id>` where the service `is_public` — **`global` and private-service topics are refused**. (spec)
- Public DTOs are minimal (name/status/timings) — **no** URLs, config, credentials, or alert settings. (spec)
- The mutation path is not modified — Server Actions still require a Clerk session; the internal API still requires the secret. (spec)
- **Next 16 is not training-data Next** — sibling pages under `apps/web/app/` are ground truth. (apps/web/AGENTS.md)
- Conventional commits. **Per-task commits on `phase-6a-public-demo` are authorized** (human's gate is the PR to main). Branch already created (off `main`).
- "Done" per task: `npm run typecheck` + `npm run lint` clean.

---

## File map

**Server**
- `apps/server/src/db/schema.ts` — Modify: `is_public` on `services` + `domains`.
- `apps/server/src/lib/env.ts` — Modify: `PUBLIC_OWNER_CLERK_ID` optional.
- `apps/server/src/lib/public-mode.ts` (+ `.test.ts`) — Create: `publicModeEnabled` / `publicOwnerClerkId`.
- `apps/server/.env.example` — Modify.
- `apps/server/src/db/repositories/services.ts` — Modify: `listPublicServices`, `isServicePublic`.
- `apps/server/src/db/repositories/incidents.ts` — Modify: `listPublicIncidents`.
- `apps/server/src/db/repositories/domains.ts` — Modify: `listPublicDomains`, `setDomainPublic`.
- `apps/server/src/db/repositories/*.test.ts` — Modify.
- `apps/server/src/router.ts` (+ `router.public.test.ts`) — Modify: public read endpoints + domain visibility.
- `apps/server/src/ws/auth.ts` (+ `.test.ts`) — Modify: public connection path.
- `apps/server/src/ws/connections.ts` (+ `.test.ts`) — Modify: `Conn.public` + subscribe scoping.
- `apps/server/src/ws/server.ts` — Modify: public upgrade flag + threaded deps.

**Shared**
- `packages/shared/src/schemas/service.ts` (+ `.test.ts`) — Modify: `ServiceUpdateSchema.isPublic`.

**Web**
- `apps/web/lib/ws-client.ts` (+ `.test.ts`) — Modify: public mode + route all events to service topics.
- `apps/web/lib/public-api.ts` — Create.
- `apps/web/lib/use-ws.tsx` — Modify: `PublicWsProvider`.
- `apps/web/components/public/` — Create: `PublicServicesList`, `PublicIncidentsList`, `PublicDomainsList`.
- `apps/web/app/demo/page.tsx` — Create.
- `apps/web/middleware.ts` — Modify: add `/domains`, keep `/demo` public.
- `apps/web/lib/services-api.ts`, `apps/web/lib/domains-api.ts` — Modify: `isPublic` on DTOs + a domain visibility fn.
- `apps/web/app/(app)/settings/page.tsx`, `.../settings/actions.ts`, `apps/web/components/settings/` — Modify/Create: "Public dashboard" toggle section.

**Docs**
- `docs/DATA_MODEL.md` — Modify (Task 1).
- `docs/INFRASTRUCTURE.md` — Modify (Task 9).

---

## Task 1: Schema — is_public columns

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `docs/DATA_MODEL.md`
- Create (generated): `apps/server/drizzle/<n>_*.sql`

**Interfaces:**
- Produces: `services.isPublic`, `domains.isPublic` columns (both `boolean NOT NULL DEFAULT false`).

- [ ] **Step 1: Add the columns**

In `schema.ts`, add to the `services` table (after `alertsEnabled`):
```ts
    isPublic: boolean('is_public').notNull().default(false),
```
And to the `domains` table (after `currentStatus`):
```ts
    isPublic: boolean('is_public').notNull().default(false),
```

- [ ] **Step 2: Generate + inspect + apply**

Run: `npm run db:generate` → expect a migration adding `is_public` to both tables (`ADD COLUMN "is_public" boolean DEFAULT false NOT NULL`). Then `npm run db:migrate` (clean apply), `npm run typecheck` (PASS).

- [ ] **Step 3: Update `DATA_MODEL.md`**

Note `is_public` (default false) on `services` and `domains` — opt-in visibility for the public `/demo` dashboard; incidents inherit from their service.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle docs/DATA_MODEL.md
git commit -m "feat(server): is_public columns on services + domains"
```

---

## Task 2: Feature gate + shared schema

**Files:**
- Modify: `apps/server/src/lib/env.ts`, `apps/server/.env.example`
- Create: `apps/server/src/lib/public-mode.ts`, `apps/server/src/lib/public-mode.test.ts`
- Modify: `packages/shared/src/schemas/service.ts`, `packages/shared/src/schemas/service.test.ts`

**Interfaces:**
- Produces: `publicModeEnabled(): boolean`, `publicOwnerClerkId(): string | undefined`; `ServiceUpdateSchema` accepts `isPublic?: boolean`.

- [ ] **Step 1: Add the env var**

In `env.ts` `EnvSchema` (after the Resend vars):
```ts
  // Public read-only demo mode (Phase 6a). Optional — set to the owner's Clerk id
  // to enable /demo + the anonymous read-only WS; unset disables public mode entirely.
  PUBLIC_OWNER_CLERK_ID: z.string().optional(),
```
In `apps/server/.env.example`:
```
# Public read-only demo (optional). Set to your Clerk user id to enable /demo; unset = off.
PUBLIC_OWNER_CLERK_ID=
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/lib/public-mode.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicModeEnabled, publicOwnerClerkId } from './public-mode';

afterEach(() => vi.unstubAllEnvs());

describe('public-mode', () => {
  it('disabled when PUBLIC_OWNER_CLERK_ID is unset/blank', () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
    expect(publicModeEnabled()).toBe(false);
    expect(publicOwnerClerkId()).toBeUndefined();
  });
  it('enabled when set', () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'user_owner');
    expect(publicModeEnabled()).toBe(true);
    expect(publicOwnerClerkId()).toBe('user_owner');
  });
});
```

- [ ] **Step 3: Run it (RED)**

Run: `npm run --workspace @beacon/server test -- public-mode`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `public-mode.ts`**

```ts
// Read live from process.env (not the frozen `env`) so tests can toggle with
// vi.stubEnv and an unset value cleanly disables the feature — same pattern as
// the Resend email vars in lib/email.ts.
export function publicOwnerClerkId(): string | undefined {
  return process.env.PUBLIC_OWNER_CLERK_ID || undefined;
}

export function publicModeEnabled(): boolean {
  return Boolean(publicOwnerClerkId());
}
```

Run: `npm run --workspace @beacon/server test -- public-mode` (PASS).

- [ ] **Step 5: Add `isPublic` to `ServiceUpdateSchema`**

`packages/shared/src/schemas/service.ts` — in `ServiceUpdateSchema`'s `.extend({...})` (alongside `paused`/`alertsEnabled`):
```ts
  isPublic: z.boolean().optional(),
```
Append to `packages/shared/src/schemas/service.test.ts`:
```ts
it('ServiceUpdateSchema accepts isPublic', () => {
  expect(ServiceUpdateSchema.safeParse({ isPublic: true }).success).toBe(true);
  expect(ServiceUpdateSchema.safeParse({ isPublic: 'yes' }).success).toBe(false);
});
```
(Ensure `ServiceUpdateSchema` is imported in the test.) Run: `npm run --workspace @beacon/shared test -- service` (PASS).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (PASS).
```bash
git add apps/server/src/lib/env.ts apps/server/.env.example apps/server/src/lib/public-mode.ts apps/server/src/lib/public-mode.test.ts packages/shared/src/schemas/service.ts packages/shared/src/schemas/service.test.ts
git commit -m "feat: PUBLIC_OWNER_CLERK_ID gate + ServiceUpdateSchema.isPublic"
```

---

## Task 3: Public repository reads

**Files:**
- Modify: `apps/server/src/db/repositories/services.ts` (+ `.test.ts`)
- Modify: `apps/server/src/db/repositories/incidents.ts` (+ `.test.ts`)
- Modify: `apps/server/src/db/repositories/domains.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // services.ts
  listPublicServices(): Promise<Service[]>;            // WHERE is_public = true, ordered by name
  isServicePublic(serviceId: string): Promise<boolean>; // exists AND is_public
  // incidents.ts
  listPublicIncidents(): Promise<IncidentListRow[]>;   // incidents JOIN services WHERE services.is_public, newest first
  // domains.ts
  listPublicDomains(): Promise<Domain[]>;              // WHERE is_public = true, ordered by domain
  setDomainPublic(userId: string, id: string, isPublic: boolean): Promise<Domain | null>; // uuid-guarded, owner-scoped
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/db/repositories/services.test.ts`:
```ts
import { listPublicServices, isServicePublic } from './services';

it('listPublicServices returns only is_public services; isServicePublic reflects the flag', async () => {
  const userId = await makeUser('pub_svc');
  const pub = await createService(userId, { name: 'Public', baseUrl: 'https://p.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  const priv = await createService(userId, { name: 'Private', baseUrl: 'https://q.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  await updateService(userId, pub.id, { isPublic: true });
  const list = await listPublicServices();
  expect(list.map((s) => s.id)).toEqual([pub.id]);
  expect(await isServicePublic(pub.id)).toBe(true);
  expect(await isServicePublic(priv.id)).toBe(false);
  expect(await isServicePublic('not-a-uuid')).toBe(false);
});
```
Append to `apps/server/src/db/repositories/incidents.test.ts` (reuse its existing `seedService`/`openInc`-style helpers; here written explicitly):
```ts
import { listPublicIncidents } from './incidents';
import { updateService } from './services';

it('listPublicIncidents includes only incidents of public services', async () => {
  const { userId, service } = await seedService('pi_owner'); // seedService helper already in this file
  const checkId = await seedCheck(service.id);
  await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
  expect(await listPublicIncidents()).toHaveLength(0); // service not public yet
  await updateService(userId, service.id, { isPublic: true });
  const pub = await listPublicIncidents();
  expect(pub).toHaveLength(1);
  expect(pub[0]!.serviceName).toBe('Svc');
});
```
Append to `apps/server/src/db/repositories/domains.test.ts`:
```ts
import { listPublicDomains, setDomainPublic } from './domains';

it('setDomainPublic flips the flag (owner-scoped); listPublicDomains returns only public', async () => {
  const userId = await makeUser('pub_dom');
  const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
  expect(await listPublicDomains()).toHaveLength(0);
  expect(await setDomainPublic('00000000-0000-0000-0000-000000000000', d.id, true)).toBeNull(); // non-owner
  const updated = await setDomainPublic(userId, d.id, true);
  expect(updated?.isPublic).toBe(true);
  expect((await listPublicDomains()).map((x) => x.id)).toEqual([d.id]);
});
```

- [ ] **Step 2: Run them (RED)**

Run: `npm run --workspace @beacon/server test -- services.test incidents.test domains.test`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement**

`services.ts` (add; `isPublic` column exists from Task 1):
```ts
export async function listPublicServices(): Promise<Service[]> {
  return db.select().from(services).where(eq(services.isPublic, true)).orderBy(services.name);
}

export async function isServicePublic(serviceId: string): Promise<boolean> {
  if (!isUuid(serviceId)) return false;
  const rows = await db.select({ id: services.id }).from(services).where(and(eq(services.id, serviceId), eq(services.isPublic, true))).limit(1);
  return rows.length > 0;
}
```

`incidents.ts` (add — mirror `listIncidents`'s join, filtering on `services.isPublic`):
```ts
export async function listPublicIncidents(): Promise<IncidentListRow[]> {
  const rows = await db
    .select({
      id: incidents.id, serviceId: incidents.serviceId, serviceName: services.name,
      severity: incidents.severity, startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt, durationSeconds: incidents.durationSeconds,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .where(eq(services.isPublic, true))
    .orderBy(desc(incidents.startedAt));
  return rows.map((r) => ({
    id: r.id, serviceId: r.serviceId, serviceName: r.serviceName, severity: 'down',
    startedAt: r.startedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    durationSeconds: r.durationSeconds,
  }));
}
```

`domains.ts` (add):
```ts
export async function listPublicDomains(): Promise<Domain[]> {
  return db.select().from(domains).where(eq(domains.isPublic, true)).orderBy(asc(domains.domain));
}

export async function setDomainPublic(userId: string, id: string, isPublic: boolean): Promise<Domain | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .update(domains)
    .set({ isPublic, updatedAt: new Date() })
    .where(and(eq(domains.id, id), eq(domains.userId, userId)))
    .returning();
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run (GREEN) + commit**

Run: `npm run --workspace @beacon/server test -- services.test incidents.test domains.test` (PASS), `npm run typecheck` (PASS).
```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/services.test.ts apps/server/src/db/repositories/incidents.ts apps/server/src/db/repositories/incidents.test.ts apps/server/src/db/repositories/domains.ts apps/server/src/db/repositories/domains.test.ts
git commit -m "feat(server): public repo reads (list public services/incidents/domains, isServicePublic, setDomainPublic)"
```

---

## Task 4: Public read endpoints + domain visibility

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.public.test.ts`

**Interfaces:**
- Consumes: `publicModeEnabled` (Task 2); `listPublicServices`, `listPublicIncidents`, `listPublicDomains`, `setDomainPublic` (Task 3).
- Produces: `GET /internal/public/{services,incidents,domains}`; `POST /internal/domains/:id/visibility`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/router.public.test.ts`:
```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from './router';
import { pool, db } from './db/index';
import { services } from './db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from './db/repositories/users';
import { createService } from './db/repositories/services';
import { env } from './lib/env';

const app = createRouter();
function pub(path: string) {
  return app.request(path, { headers: { 'x-internal-secret': env.INTERNAL_API_SECRET } });
}

describe('public endpoints', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await pool.end(); });

  it('401 without the secret', async () => {
    expect((await app.request('/internal/public/services')).status).toBe(401);
  });

  it('404 when public mode disabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
    expect((await pub('/internal/public/services')).status).toBe(404);
  });

  it('returns only public rows when enabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'owner');
    const u = await upsertFromClerk({ clerkUserId: 'owner', email: 'o@e.com' });
    const s = await createService(u.id, { name: 'Pub', baseUrl: 'https://p.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await createService(u.id, { name: 'Priv', baseUrl: 'https://q.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await db.update(services).set({ isPublic: true }).where(eq(services.id, s.id));
    const res = await pub('/internal/public/services');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: { id: string; name: string }[] };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]!.name).toBe('Pub');
    // minimal DTO — no baseUrl leaked
    expect(JSON.stringify(body)).not.toContain('p.com');
  });
});
```

- [ ] **Step 2: Run it (RED)**

Run: `npm run --workspace @beacon/server test -- router.public`
Expected: FAIL.

- [ ] **Step 3: Add the guard + routes to `router.ts`**

Imports: `import { publicModeEnabled } from './lib/public-mode';`, add `listPublicServices` + `listPublicIncidents` + `listPublicDomains` + `setDomainPublic` to the relevant repo imports (`isServicePublic` is used by the WS layer, not the router).

A secret guard for `/internal/public/*` (add near the other guards):
```ts
  app.use('/internal/public/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
```

Handlers (before `return app;`):
```ts
  app.get('/internal/public/services', async (c) => {
    if (!publicModeEnabled()) return c.json({ error: 'not found' }, 404);
    const rows = await listPublicServices();
    return c.json({ services: rows.map((s) => ({ id: s.id, name: s.name, currentStatus: s.currentStatus, lastCheckAt: s.lastCheckAt?.toISOString() ?? null })) });
  });

  app.get('/internal/public/incidents', async (c) => {
    if (!publicModeEnabled()) return c.json({ error: 'not found' }, 404);
    return c.json({ incidents: await listPublicIncidents() });
  });

  app.get('/internal/public/domains', async (c) => {
    if (!publicModeEnabled()) return c.json({ error: 'not found' }, 404);
    const rows = await listPublicDomains();
    return c.json({ domains: rows.map((d) => ({ id: d.id, domain: d.domain, currentStatus: d.currentStatus, sslExpiresAt: d.sslExpiresAt?.toISOString() ?? null, domainExpiresAt: d.domainExpiresAt?.toISOString() ?? null })) });
  });
```

Domain visibility (under the existing `/internal/domains/*` secret guard from 5c):
```ts
  app.post('/internal/domains/:id/visibility', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const body = (await c.req.json().catch(() => null)) as { isPublic?: unknown } | null;
    if (typeof body?.isPublic !== 'boolean') return c.json({ error: 'invalid body' }, 400);
    const domain = await setDomainPublic(userId, c.req.param('id'), body.isPublic);
    return domain ? c.json(domain) : c.json({ error: 'not found' }, 404);
  });
```

- [ ] **Step 4: Run (GREEN) + typecheck + commit**

Run: `npm run --workspace @beacon/server test -- router.public` (PASS), `npm run typecheck` (PASS).
```bash
git add apps/server/src/router.ts apps/server/src/router.public.test.ts
git commit -m "feat(server): public read endpoints (404 when disabled) + domain visibility"
```

---

## Task 5: Anonymous read-only WebSocket

**Files:**
- Modify: `apps/server/src/ws/auth.ts` (+ `.test.ts`)
- Modify: `apps/server/src/ws/connections.ts` (+ `.test.ts`)
- Modify: `apps/server/src/ws/server.ts`

**Interfaces:**
- Consumes: `publicModeEnabled`, `publicOwnerClerkId` (Task 2); `isServicePublic` (Task 3).
- Produces: `authenticateConnection(token, opts?, deps?)` now returns `{ userId; public: boolean } | null`; `ConnectionHub.add(ws, userId, isPublic?)`; `subscribe(connId, topic, { canAccessService?, isServicePublic? })` scopes public conns.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/ws/auth.test.ts`:
```ts
it('public connection resolves to the owner when enabled', async () => {
  vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'owner_clerk');
  const auth = await authenticateConnection(undefined, { public: true }, { resolveOwner: async () => ({ userId: 'owner-uuid' }) });
  expect(auth).toEqual({ userId: 'owner-uuid', public: true });
});
it('public connection rejected when disabled', async () => {
  vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
  expect(await authenticateConnection(undefined, { public: true })).toBeNull();
});
it('token connection still resolves with public:false', async () => {
  const auth = await authenticateConnection('tok', {}, { verify: async () => ({ sub: 'clerk_x' }), resolveByClerk: async () => ({ userId: 'u1' }) });
  expect(auth).toEqual({ userId: 'u1', public: false });
});
```
(Add `import { vi } from 'vitest'` + `afterEach(() => vi.unstubAllEnvs())` if not present. The `deps` shape — `verify`, `resolveByClerk`, `resolveOwner` — is defined in Step 3.)

Append to `apps/server/src/ws/connections.test.ts`:
```ts
it('public conn: rejects global and private, allows public service topic', async () => {
  const hub = new ConnectionHub();
  const id = hub.add({ send() {} }, 'owner-uuid', true); // public conn
  const deps = { isServicePublic: async (sid: string) => sid === 'pub-svc' };
  expect(await hub.subscribe(id, 'global', deps)).toBe(false);
  expect(await hub.subscribe(id, 'service:priv-svc', deps)).toBe(false);
  expect(await hub.subscribe(id, 'service:pub-svc', deps)).toBe(true);
});
it('authed conn unchanged (ownership check)', async () => {
  const hub = new ConnectionHub();
  const id = hub.add({ send() {} }, 'u1'); // non-public
  expect(await hub.subscribe(id, 'global')).toBe(true);
  expect(await hub.subscribe(id, 'service:x', { canAccessService: async () => true })).toBe(true);
  expect(await hub.subscribe(id, 'service:y', { canAccessService: async () => false })).toBe(false);
});
```

- [ ] **Step 2: Run them (RED)**

Run: `npm run --workspace @beacon/server test -- ws/auth ws/connections`
Expected: FAIL.

- [ ] **Step 3: Rewrite `authenticateConnection` (`ws/auth.ts`)**

```ts
import { verifyToken } from '@clerk/backend';
import { env } from '../lib/env';
import { getByClerkId } from '../db/repositories/users';
import { publicModeEnabled, publicOwnerClerkId } from '../lib/public-mode';

type VerifyFn = (token: string) => Promise<{ sub: string }>;
type ResolveFn = (clerkId: string) => Promise<{ userId: string } | null>;

const defaultVerify: VerifyFn = async (token) => {
  const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return { sub: String(claims.sub) };
};
const defaultResolveByClerk: ResolveFn = async (clerkId) => {
  const user = await getByClerkId(clerkId);
  return user ? { userId: user.id } : null;
};

export async function authenticateConnection(
  token: string | undefined,
  opts: { public?: boolean } = {},
  deps: { verify?: VerifyFn; resolveByClerk?: ResolveFn; resolveOwner?: () => Promise<{ userId: string } | null> } = {},
): Promise<{ userId: string; public: boolean } | null> {
  const resolveByClerk = deps.resolveByClerk ?? defaultResolveByClerk;

  if (opts.public) {
    if (!publicModeEnabled()) return null;
    const resolveOwner = deps.resolveOwner ?? (() => resolveByClerk(publicOwnerClerkId()!));
    const owner = await resolveOwner();
    return owner ? { userId: owner.userId, public: true } : null;
  }

  if (!token) return null;
  const verify = deps.verify ?? defaultVerify;
  try {
    const { sub } = await verify(token);
    const resolved = await resolveByClerk(sub);
    return resolved ? { userId: resolved.userId, public: false } : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update `ConnectionHub` (`connections.ts`)**

Change `Conn` + `add` + `subscribe`:
```ts
import { isServicePublic as repoIsServicePublic } from '../db/repositories/services';
// ...
type Conn = { ws: WsLike; userId: string; topics: Set<string>; public: boolean };

  add(ws: WsLike, userId: string, isPublic = false): string {
    const id = randomUUID();
    this.conns.set(id, { ws, userId, topics: new Set(), public: isPublic });
    return id;
  }

  async subscribe(
    connId: string,
    topic: string,
    deps: {
      canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
      isServicePublic?: (serviceId: string) => Promise<boolean>;
    } = {},
  ): Promise<boolean> {
    const conn = this.conns.get(connId);
    if (!conn) return false;

    if (conn.public) {
      if (topic === 'global') return false;
      const m = /^service:(.+)$/.exec(topic);
      if (!m) return false;
      const isPublic = deps.isServicePublic ?? repoIsServicePublic;
      if (!(await isPublic(m[1]!))) return false;
      conn.topics.add(topic);
      return true;
    }

    if (topic !== 'global') {
      const m = /^service:(.+)$/.exec(topic);
      if (!m) return false;
      const canAccess = deps.canAccessService ?? (async (uid, sid) => (await getService(uid, sid)) !== null);
      if (!(await canAccess(conn.userId, m[1]!))) return false;
    }
    conn.topics.add(topic);
    return true;
  }
```

- [ ] **Step 5: Update the upgrade path (`ws/server.ts`)**

Change the `Deps.authenticate` signature and thread `public` + `isServicePublic`:
```ts
import { isServicePublic } from '../db/repositories/services';

type Deps = {
  authenticate?: (token: string | undefined, opts: { public: boolean }) => Promise<{ userId: string; public: boolean } | null>;
  canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
  isServicePublic?: (serviceId: string) => Promise<boolean>;
  heartbeatMs?: number;
};
```
In `attachWebSocketServer`:
```ts
  const authenticate = deps.authenticate ?? ((t, o) => authenticateConnection(t, o));
```
`authMap` value type → `{ userId: string; public: boolean }`. In the upgrade handler:
```ts
    const token = url.searchParams.get('token') ?? undefined;
    const isPublic = url.searchParams.get('public') === '1';
    void authenticate(token, { public: isPublic }).then((auth) => {
      if (!auth) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { authMap.set(ws, auth); wss.emit('connection', ws, req); });
    });
```
In the `connection` handler: `const connId = hub.add(ws, auth.userId, auth.public);` and pass both subscribe deps:
```ts
      if (parsed.data.type === 'subscribe') await hub.subscribe(connId, parsed.data.topic, { canAccessService: deps.canAccessService, isServicePublic: deps.isServicePublic ?? isServicePublic });
```

- [ ] **Step 6: Run tests + full server suite + typecheck**

Run: `npm run --workspace @beacon/server test` (all PASS — the existing ws/server + ws/auth tests still pass; if a ws/server test called the old 1-arg `authenticate` mock, update it to `(token, opts)`).
Run: `npm run typecheck` (PASS).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ws/auth.ts apps/server/src/ws/auth.test.ts apps/server/src/ws/connections.ts apps/server/src/ws/connections.test.ts apps/server/src/ws/server.ts
git commit -m "feat(server): anonymous read-only WS scoped to public service topics"
```

---

## Task 6: WS client public mode + event routing fix

**Files:**
- Modify: `apps/web/lib/ws-client.ts` (+ `.test.ts`)

**Interfaces:**
- Produces: `new BeaconSocket({ url, getToken?, public? })`; the message handler routes **every** event (incl. `incident.*`) to its `service:<serviceId>` topic handlers.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/ws-client.test.ts` (match the file's existing socket-mock style; sketch):
```ts
it('routes incident events to the service topic handler', () => {
  const sock = new BeaconSocket({ url: 'ws://x', public: true });
  const got: unknown[] = [];
  sock.subscribe('service:s1', (e) => got.push(e));
  // simulate an open socket + inbound incident.opened for s1
  // (use the file's existing harness to drive a message; assert `got` received it)
  // Expected: the service:s1 handler receives incident.opened (not only 'global').
});
it('public mode connects with ?public=1 and no token', async () => {
  // assert the constructed WebSocket URL ends with ?public=1 and getToken is not required
});
```
(Implement against whatever mock/harness `ws-client.test.ts` already uses; the two assertions are: incident events reach the `service:<id>` handler, and public mode connects without a token to `?public=1`.)

- [ ] **Step 2: Run it (RED)**

Run: `npm run --workspace @beacon/web test -- ws-client`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ws-client.ts`, make `getToken` optional + add `public`:
```ts
  constructor(private opts: { url: string; getToken?: () => Promise<string | null>; public?: boolean }) {}
```
Rewrite `connect()`'s URL selection:
```ts
  async connect(): Promise<void> {
    let wsUrl: string;
    if (this.opts.public) {
      wsUrl = `${this.opts.url}?public=1`;
    } else {
      const token = await this.opts.getToken?.();
      if (!token) { this.setState('disconnected'); return; }
      wsUrl = `${this.opts.url}?token=${encodeURIComponent(token)}`;
    }
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    // ... open handler unchanged ...
```
Fix the message handler to route **all** events (all `WsEvent` types carry `serviceId`) to the service topic, not just `status_changed`:
```ts
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WsEvent;
        for (const h of this.topics.get('global') ?? []) h(data);
        for (const h of this.topics.get(`service:${data.serviceId}`) ?? []) h(data);
      } catch { /* ignore malformed */ }
    });
```
(Rest of `connect`/`subscribe` unchanged.)

- [ ] **Step 4: Run (GREEN) + typecheck + commit**

Run: `npm run --workspace @beacon/web test -- ws-client` (PASS), `npm run typecheck` (PASS).
```bash
git add apps/web/lib/ws-client.ts apps/web/lib/ws-client.test.ts
git commit -m "feat(web): WS client public mode + route incident events to service topics"
```

---

## Task 7: Public /demo page + read-only components

**Files:**
- Create: `apps/web/lib/public-api.ts`
- Modify: `apps/web/lib/use-ws.tsx` (add `PublicWsProvider`)
- Create: `apps/web/components/public/public-services-list.tsx`, `public-incidents-list.tsx`, `public-domains-list.tsx`
- Create: `apps/web/app/demo/page.tsx`

**Interfaces:**
- Consumes: the public endpoints (Task 4); `BeaconSocket` public mode (Task 6); `STATUS_STYLE`, `DOMAIN_STATUS_STYLE`, `formatDaysUntil`, `formatDuration`, `relativeTime` (existing).

- [ ] **Step 1: Read the Next 16 conventions** — `apps/web/app/(app)/services/page.tsx`, `apps/web/lib/use-ws.tsx`, `apps/web/components/services/services-live-list.tsx`.

- [ ] **Step 2: Public API client**

`apps/web/lib/public-api.ts`:
```ts
import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type PublicServiceDto = { id: string; name: string; currentStatus: string; lastCheckAt: string | null };
export type PublicIncidentDto = { id: string; serviceId: string; serviceName: string; severity: 'down'; startedAt: string; resolvedAt: string | null; durationSeconds: number | null };
export type PublicDomainDto = { id: string; domain: string; currentStatus: string; sslExpiresAt: string | null; domainExpiresAt: string | null };

function headers(): HeadersInit { return { 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '' }; }

async function get<T>(path: string, key: string): Promise<T[] | null> {
  const res = await fetch(`${serverApiBaseUrl()}${path}`, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return null; // public mode disabled
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json())[key] as T[];
}

export const fetchPublicServices = () => get<PublicServiceDto>('/internal/public/services', 'services');
export const fetchPublicIncidents = () => get<PublicIncidentDto>('/internal/public/incidents', 'incidents');
export const fetchPublicDomains = () => get<PublicDomainDto>('/internal/public/domains', 'domains');
```

- [ ] **Step 3: `PublicWsProvider`**

In `apps/web/lib/use-ws.tsx`, add a public provider AND a plural-subscription hook (a single component needs to subscribe to many service topics — doing that with a `for` loop over `useServiceStatusSubscription` violates rules-of-hooks, so add one hook that subscribes to an array in a single effect):
```tsx
export function PublicWsProvider({ children }: { children: React.ReactNode }) {
  const socket = useMemo(() => new BeaconSocket({ url: clientEnv.NEXT_PUBLIC_WS_URL, public: true }), []);
  useEffect(() => { void socket.connect(); }, [socket]);
  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

// Subscribe to many topics in one effect (lint-safe: one hook call, not a loop of hooks).
export function useServiceStatusSubscriptions(topics: string[], handler: (e: WsEvent) => void) {
  const socket = useContext(Ctx);
  const key = topics.join('|');
  useEffect(() => {
    if (!socket) return;
    const unsubs = topics.map((t) => socket.subscribe(t, handler));
    return () => { for (const u of unsubs) u(); };
    // topics is derived from `key`; handler is memoized by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, key, handler]);
}
```
(`Ctx`, `useContext`, `useMemo`, `useEffect`, and `WsEvent` are already imported/defined in this file.)

- [ ] **Step 4: Read-only list components**

`apps/web/components/public/public-services-list.tsx` (client) — render the DTOs with `STATUS_STYLE`, subscribe each row to `service:<id>` for live status; **no** action components:
```tsx
'use client';
import { useCallback, useState } from 'react';
import type { WsEvent } from '@beacon/shared';
import type { PublicServiceDto } from '@/lib/public-api';
import { STATUS_STYLE } from '@/lib/status-style';
import { relativeTime } from '@/lib/relative-time';
import { useServiceStatusSubscriptions } from '@/lib/use-ws';

export function PublicServicesList({ initial }: { initial: PublicServiceDto[] }) {
  const [services, setServices] = useState(initial);
  const onEvent = useCallback((e: WsEvent) => {
    if (e.type !== 'service.status_changed') return;
    setServices((prev) => prev.map((s) => (s.id === e.serviceId ? { ...s, currentStatus: e.status } : s)));
  }, []);
  // one hook call subscribing to every public service's topic (fixed for the component's life)
  useServiceStatusSubscriptions(initial.map((s) => `service:${s.id}`), onEvent);
  return (
    <ul className="divide-y divide-zinc-200/40">
      {services.map((s) => {
        const style = STATUS_STYLE[s.currentStatus] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300', pulse: false };
        return (
          <li key={s.id} className="flex items-center gap-4 px-5 py-3">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-900">{s.name}</span>
            <div className="flex w-24 items-center gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden="true" />
              <span className={`text-[12px] font-medium capitalize ${style.text}`}>{s.currentStatus}</span>
            </div>
            <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-400">{relativeTime(s.lastCheckAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
```
Note: subscribing per-row inside a loop violates the hooks rule. Instead subscribe once to a stable set — implement the subscription by iterating a **fixed** `initial` list at the top level via a single effect. Concretely, replace the loop with one `useEffect` that calls `socket.subscribe` for each id and returns a combined cleanup (use `useContext(Ctx)` to get the socket directly, mirroring `useServiceStatusSubscription`'s internals). Do the same shape for incidents.

`public-incidents-list.tsx` (client) — render `PublicIncidentDto` with severity dot + `formatDuration`; use the same `useServiceStatusSubscriptions(initial.map((i) => \`service:${i.serviceId}\`), onEvent)` hook, and in `onEvent` narrow on `incident.resolved` to update the row's `resolvedAt`/`durationSeconds` live (and `incident.opened` could prepend, but the initial fetch already covers open incidents — keep it to updating existing rows). Renders fine with an empty list.

`public-domains-list.tsx` (client or server) — render `PublicDomainDto` with `DOMAIN_STATUS_STYLE` + `formatDaysUntil`; **no WS** (domains aren't live).

- [ ] **Step 5: `/demo` page (Server Component)**

`apps/web/app/demo/page.tsx`:
```tsx
import { fetchPublicServices, fetchPublicIncidents, fetchPublicDomains } from '@/lib/public-api';
import { PublicWsProvider } from '@/lib/use-ws';
import { PublicServicesList } from '@/components/public/public-services-list';
import { PublicIncidentsList } from '@/components/public/public-incidents-list';
import { PublicDomainsList } from '@/components/public/public-domains-list';

export default async function DemoPage() {
  const [services, incidents, domains] = await Promise.all([fetchPublicServices(), fetchPublicIncidents(), fetchPublicDomains()]);

  if (services === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50">
        <p className="text-[13px] text-zinc-500">The public demo isn’t enabled right now.</p>
      </main>
    );
  }

  return (
    <PublicWsProvider>
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-zinc-50">
        <div className="border-b border-zinc-200/60 px-5 py-3.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">read-only · live public dashboard</span>
          <h1 className="mt-1 text-sm font-semibold text-zinc-900">Beacon</h1>
        </div>
        <section className="border-b border-zinc-200/40">
          <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Services</h2>
          <PublicServicesList initial={services} />
        </section>
        <section className="border-b border-zinc-200/40">
          <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Incidents</h2>
          <PublicIncidentsList initial={incidents ?? []} />
        </section>
        <section>
          <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Domains</h2>
          <PublicDomainsList initial={domains ?? []} />
        </section>
      </main>
    </PublicWsProvider>
  );
}
```

- [ ] **Step 6: Design pass (frontend-design skill)**

`/demo` is recruiter-facing — the live public surface. Make it read as a polished status page consistent with the app (mono eyebrows, hairlines, zinc, live pulse). Document decisions in `docs/DESIGN.md`.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` (PASS). Manually load `/demo`.
```bash
git add apps/web/lib/public-api.ts apps/web/lib/use-ws.tsx apps/web/components/public "apps/web/app/demo" docs/DESIGN.md
git commit -m "feat(web): /demo public read-only dashboard with anonymous live WS"
```

---

## Task 8: Settings "Public dashboard" toggles + middleware fix

**Files:**
- Modify: `apps/web/middleware.ts`
- Modify: `apps/web/lib/services-api.ts` (`isPublic` on `ServiceDto`), `apps/web/lib/domains-api.ts` (`isPublic` on `DomainDto` + `setDomainPublicOnServer`)
- Modify: `apps/web/app/(app)/settings/actions.ts` (toggle actions)
- Create: `apps/web/components/settings/public-toggles.tsx`
- Modify: `apps/web/app/(app)/settings/page.tsx` (add the section)

**Interfaces:**
- Consumes: `updateServiceOnServer` (existing, now carries `isPublic`); the domain visibility endpoint (Task 4).

- [ ] **Step 1: Middleware fix**

In `apps/web/middleware.ts`, add `'/domains(.*)'` to `createRouteMatcher([...])`. `/demo` is not listed → stays public. (Confirm the matcher config still excludes `_next`/static.)

- [ ] **Step 2: DTO + client additions**

`services-api.ts`: add `isPublic: boolean;` to `ServiceDto` (the server already returns it in the row JSON).
`domains-api.ts`: add `isPublic: boolean;` to `DomainDto`; add:
```ts
export async function setDomainPublicOnServer(clerkUserId: string, id: string, isPublic: boolean): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}/visibility`, { method: 'POST', headers: headers(clerkUserId), body: JSON.stringify({ isPublic }), cache: 'no-store' });
  if (!res.ok) throw new Error(`setDomainPublic failed: ${res.status}`);
}
```

- [ ] **Step 3: Toggle actions**

In `apps/web/app/(app)/settings/actions.ts`, add:
```ts
import { updateServiceOnServer } from '@/lib/services-api';
import { setDomainPublicOnServer } from '@/lib/domains-api';

export async function toggleServicePublicAction(id: string, isPublic: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await updateServiceOnServer(clerkId, id, { isPublic });
    revalidatePath('/settings'); revalidatePath('/demo');
    return { ok: true };
  } catch (err) { console.error('[beacon-web] toggleServicePublicAction failed', err); return { ok: false, error: 'Could not update visibility.' }; }
}

export async function toggleDomainPublicAction(id: string, isPublic: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await setDomainPublicOnServer(clerkId, id, isPublic);
    revalidatePath('/settings'); revalidatePath('/demo');
    return { ok: true };
  } catch (err) { console.error('[beacon-web] toggleDomainPublicAction failed', err); return { ok: false, error: 'Could not update visibility.' }; }
}
```
(`ServiceUpdateInput` from `@beacon/shared` already accepts `isPublic` after Task 2 — `updateServiceOnServer`'s `patch` type covers it.)

- [ ] **Step 4: Toggle components + settings section**

`apps/web/components/settings/public-toggles.tsx` (client) — two small toggle components (`ServicePublicToggle`, `DomainPublicToggle`) mirroring `ServiceAlertToggle` (a checkbox + `useTransition` calling the action). Then in `settings/page.tsx`, add a "Public dashboard" section: fetch services + domains (already fetched for the alerts section — reuse), list each with its public toggle, and a `<Link href="/demo">View public dashboard →</Link>`.

- [ ] **Step 5: Design pass + verify + commit**

Quick frontend-design check that the section fits the settings rhythm. Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add apps/web/middleware.ts apps/web/lib/services-api.ts apps/web/lib/domains-api.ts "apps/web/app/(app)/settings/actions.ts" apps/web/components/settings/public-toggles.tsx "apps/web/app/(app)/settings/page.tsx"
git commit -m "feat(web): settings public-visibility toggles + /domains middleware fix"
```

---

## Task 9: Docs + full verification

**Files:**
- Modify: `docs/INFRASTRUCTURE.md`

- [ ] **Step 1: Document public mode in `INFRASTRUCTURE.md`**

Add a "Public demo mode (Phase 6a)" note: `PUBLIC_OWNER_CLERK_ID` (set to the owner's Clerk id to enable `/demo` + the anonymous read-only WS; unset = off). Note the read-only guarantee (no session/secret in the anon lane; anon WS receive-only + public-topic-scoped) and that only `is_public` entities are exposed.

- [ ] **Step 2: Full typecheck + lint + server suite**

Run: `npm run typecheck && npm run lint && npm run --workspace @beacon/server test`
Expected: all PASS.

- [ ] **Step 3: Manual enforcement verification (the phase doc's emphasis — do this carefully)**

With `PUBLIC_OWNER_CLERK_ID` set and one service + one domain marked public in `/settings`:
- Logged **out**, load `/demo` → the public service/domain appear; a private one does not; **no** add/edit/delete/pause/recheck controls exist.
- Force the public service down → its dot flips **live** with no login (anon WS).
- In devtools, try to open a WS and `subscribe` to `global` and to a **private** service's topic → both refused (no events arrive).
- Hit a mutation Server Action with no session → fails; `curl /internal/public/services` without the secret → 401.
- Unset `PUBLIC_OWNER_CLERK_ID`, restart → `/demo` shows "not enabled"; the anon WS is rejected.

- [ ] **Step 4: Commit + finish the branch**

```bash
git add docs/INFRASTRUCTURE.md
git commit -m "docs(infra): public demo mode + PUBLIC_OWNER_CLERK_ID"
```
Then invoke `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** schema (T1), gate + shared schema (T2), public repo reads (T3), public endpoints + domain visibility (T4), anon WS (T5), WS client public mode + routing fix (T6), `/demo` + read-only components (T7), settings toggles + middleware fix (T8), docs + enforcement verification (T9). Non-goals (public writes, multi-tenant, live public domains, config exposure, uptime %, rate limiting) not built.
- **Interface consistency:** `publicModeEnabled`/`publicOwnerClerkId` (T2) consumed by endpoints (T4) + auth (T5); `isServicePublic` (T3) consumed by `connections.subscribe` (T5) + `ws/server` (T5); `listPublic*`/`setDomainPublic` (T3) consumed by endpoints (T4); `authenticateConnection` new signature (T5) matched in `ws/server` (T5); `BeaconSocket` public mode (T6) consumed by `PublicWsProvider` (T7); the public DTOs (T7 `public-api.ts`) match the endpoint JSON (T4); `ServiceUpdateSchema.isPublic` (T2) used by the toggle action (T8); the domain visibility endpoint (T4) used by `setDomainPublicOnServer` (T8).
- **Enforcement invariants:** anon conn refuses `global` + private topics (T5 tests); public endpoints 404 when disabled + secret-gated (T4 tests); public DTOs carry no URLs/config (T4 test asserts no base URL leaks); mutation path untouched.
