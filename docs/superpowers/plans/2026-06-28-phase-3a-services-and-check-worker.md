# Phase 3 Slice A — Services & Check Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add a service in the dashboard and have a background worker run scheduled HTTP health checks that flip the service's `up`/`down` status in the database (visible on refresh).

**Architecture:** The browser talks only to the Next.js web app; web Server Components (reads) and Server Actions (writes) call new `/internal/services*` endpoints on the Hono server over `INTERNAL_API_URL`, guarded by the `x-internal-secret` header. The Hono server owns Postgres via Drizzle repositories. A separate `check-worker` process (same server image, different command) reads/writes the DB directly: it polls for due services, runs HTTP checks with a hard timeout, records results, and updates status.

**Tech Stack:** Drizzle ORM + Postgres, Hono, Zod, Next.js 16 (App Router, Server Actions), TypeScript strict, Vitest, native `fetch` + `AbortController`, Docker Compose.

**Design spec:** `docs/superpowers/specs/2026-06-28-phase-3a-services-and-check-worker-design.md`

## Global Constraints

- TypeScript `strict`, no `any`; use `unknown` + narrow. Prefer `type` over `interface`.
- Zod schemas are the source of truth; DB types derive from Drizzle via `$inferSelect`/`$inferInsert`.
- All DB access goes through `apps/server/src/db/repositories/`. No raw Drizzle in routes or the worker entry.
- Timestamps are `timestamptz`; server clocks UTC.
- Internal endpoints are guarded by header `x-internal-secret === env.INTERNAL_API_SECRET` and identify the user via header `x-clerk-user-id` (resolved through `getByClerkId`). The web sets both server-side.
- **Next.js 16 has breaking changes** (see `apps/web/AGENTS.md`). Before writing web code, check `node_modules/next/dist/docs/` for current App Router / Server Action APIs. Do not assume training-data Next.js.
- Use Context7 to confirm current Drizzle APIs (`pgEnum`, `.array()` columns, `index()` signature) for the installed `drizzle-orm` version before writing the schema.
- No new runtime dependencies. Bounded concurrency and HTTP checks use only Node built-ins (`fetch`, `AbortController`).
- No new env vars (the worker needs only the existing `DATABASE_URL`).
- Conventional commits; pause for human approval before every `git add`/`git commit`.

## File structure

```
packages/shared/src/
  schemas/service.ts          (new) Zod enums + Create/Update schemas + types
  index.ts                    (modify) re-export service schemas
apps/server/src/
  db/schema.ts                (modify) services + service_checks tables + enums + indexes
  db/repositories/services.ts (new) CRUD + worker queries
  db/repositories/service-checks.ts (new) recordCheck
  lib/concurrency.ts          (new) runBounded helper
  workers/check-classify.ts   (new) pure classification function
  workers/check-worker.ts     (new) checkOne + the poll loop
  router.ts                   (modify) /internal/services* endpoints
  package.json                (modify) "worker" script
apps/web/
  lib/services-api.ts         (new) server-side internal-API client
  app/(app)/services/actions.ts (new) Server Actions
  app/(app)/services/page.tsx (modify) live list + dashboard
  components/services/*        (new) ServiceCard, AddServiceDialog, ServiceRowActions
package.json                  (modify) run worker in dev
infrastructure/docker-compose.yml (modify) worker service
docs/INFRASTRUCTURE.md        (modify) document the worker service
```

---

### Task 1: Shared service schemas

**Files:**
- Create: `packages/shared/src/schemas/service.ts`
- Create: `packages/shared/src/schemas/service.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `ServiceStatusSchema`, `CheckStatusSchema` (Zod enums); `ServiceCreateSchema`, `ServiceUpdateSchema`; types `ServiceStatus`, `CheckStatus`, `ServiceCreateInput`, `ServiceUpdateInput`. `ServiceCreateSchema` parses to an object with all optional fields defaulted (`healthCheckPath='/'`, `expectedStatusCodes=[200]`, `checkIntervalSeconds=60`, `timeoutSeconds=10`).

- [ ] **Step 1: Write the failing test** — `packages/shared/src/schemas/service.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ServiceCreateSchema, ServiceUpdateSchema } from './service';

describe('ServiceCreateSchema', () => {
  it('applies defaults when optional fields are omitted', () => {
    const parsed = ServiceCreateSchema.parse({ name: 'Wayfare', baseUrl: 'https://wayfare.thiluxan.com' });
    expect(parsed).toMatchObject({
      name: 'Wayfare',
      baseUrl: 'https://wayfare.thiluxan.com',
      healthCheckPath: '/',
      expectedStatusCodes: [200],
      checkIntervalSeconds: 60,
      timeoutSeconds: 10,
    });
  });

  it('rejects a non-URL baseUrl', () => {
    expect(ServiceCreateSchema.safeParse({ name: 'x', baseUrl: 'not-a-url' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(ServiceCreateSchema.safeParse({ name: '', baseUrl: 'https://a.com' }).success).toBe(false);
  });

  it('rejects an out-of-range status code', () => {
    expect(
      ServiceCreateSchema.safeParse({ name: 'x', baseUrl: 'https://a.com', expectedStatusCodes: [99] }).success,
    ).toBe(false);
  });
});

describe('ServiceUpdateSchema', () => {
  it('allows a partial patch', () => {
    expect(ServiceUpdateSchema.parse({ paused: true })).toEqual({ paused: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/shared`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 3: Implement** — `packages/shared/src/schemas/service.ts`

```ts
import { z } from 'zod';

export const ServiceStatusSchema = z.enum(['pending', 'up', 'degraded', 'down', 'paused']);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const CheckStatusSchema = z.enum(['success', 'failure', 'timeout', 'error']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

const statusCode = z.number().int().min(100).max(599);

export const ServiceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  baseUrl: z.string().url(),
  healthCheckPath: z.string().min(1).default('/'),
  expectedStatusCodes: z.array(statusCode).min(1).default([200]),
  checkIntervalSeconds: z.number().int().min(10).max(86_400).default(60),
  timeoutSeconds: z.number().int().min(1).max(120).default(10),
});
export type ServiceCreateInput = z.infer<typeof ServiceCreateSchema>;

export const ServiceUpdateSchema = ServiceCreateSchema.partial().extend({
  paused: z.boolean().optional(),
  alertsEnabled: z.boolean().optional(),
});
export type ServiceUpdateInput = z.infer<typeof ServiceUpdateSchema>;
```

- [ ] **Step 4: Re-export** — append to `packages/shared/src/index.ts`

```ts
export {
  ServiceStatusSchema,
  CheckStatusSchema,
  ServiceCreateSchema,
  ServiceUpdateSchema,
  type ServiceStatus,
  type CheckStatus,
  type ServiceCreateInput,
  type ServiceUpdateInput,
} from './schemas/service';
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -w @beacon/shared && npm run typecheck -w @beacon/shared`
Expected: PASS (service 5/5 + existing health 3/3); typecheck clean.

- [ ] **Step 6: Commit (request approval first)**

```bash
git add packages/shared/src/schemas/service.ts packages/shared/src/schemas/service.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): service create/update zod schemas and status enums"
```

---

### Task 2: Database schema + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create (generated): `apps/server/drizzle/<timestamp>_*.sql`

**Interfaces:**
- Produces: Drizzle tables `services`, `serviceChecks`; enums `serviceStatus`, `checkStatus`; types `Service`, `NewService`, `ServiceCheck`, `NewServiceCheck`.

**Precondition:** Local Postgres up (`docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`). Verify the installed Drizzle `pgEnum` / `.array()` / `index()` signatures via Context7 first.

- [ ] **Step 1: Add tables** — append to `apps/server/src/db/schema.ts`

```ts
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const serviceStatus = pgEnum('service_status', ['pending', 'up', 'degraded', 'down', 'paused']);
export const checkStatus = pgEnum('check_status', ['success', 'failure', 'timeout', 'error']);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    baseUrl: text('base_url').notNull(),
    healthCheckPath: text('health_check_path').notNull().default('/'),
    expectedStatusCodes: integer('expected_status_codes').array().notNull().default([200]),
    checkIntervalSeconds: integer('check_interval_seconds').notNull().default(60),
    timeoutSeconds: integer('timeout_seconds').notNull().default(10),
    currentStatus: serviceStatus('current_status').notNull().default('pending'),
    currentStatusSince: timestamp('current_status_since', { withTimezone: true }).notNull().defaultNow(),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    paused: boolean('paused').notNull().default(false),
    alertsEnabled: boolean('alerts_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('services_user_status_idx').on(t.userId, t.currentStatus),
    index('services_next_check_idx').on(t.nextCheckAt),
  ],
);

export const serviceChecks = pgTable(
  'service_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    status: checkStatus('status').notNull(),
    statusCode: integer('status_code'),
    responseTimeMs: integer('response_time_ms'),
    errorMessage: text('error_message'),
  },
  (t) => [index('service_checks_service_checked_idx').on(t.serviceId, t.checkedAt)],
);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type ServiceCheck = typeof serviceChecks.$inferSelect;
export type NewServiceCheck = typeof serviceChecks.$inferInsert;
```

> Note: keep the existing `users` table and its imports; merge the import line above with the existing one rather than duplicating. The `(t) => [ ... ]` index form is for the array-return signature; if the installed Drizzle expects the object-return form, adapt per Context7.

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate -w @beacon/server`
Expected: a new file under `apps/server/drizzle/` creating both enums, both tables, and the three indexes.

- [ ] **Step 3: Apply locally and verify**

```bash
npm run db:migrate -w @beacon/server
docker compose -f infrastructure/docker-compose.dev.yml exec -T postgres \
  psql -U beacon -d beacon -c "\d services" -c "\d service_checks"
```
Expected: migration applies; both tables exist with the expected columns/indexes.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @beacon/server`
Expected: clean.

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle
git commit -m "feat(server): services and service_checks schema + migration"
```

---

### Task 3: Services repository — CRUD

**Files:**
- Create: `apps/server/src/db/repositories/services.ts`
- Create: `apps/server/src/db/repositories/services.test.ts`

**Interfaces:**
- Consumes: `db`, `pool` from `../index`; `services`, `type Service` from `../schema`; `ServiceCreateInput`, `ServiceUpdateInput` from `@beacon/shared`.
- Produces:
  - `createService(userId: string, input: ServiceCreateInput): Promise<Service>` — inserts with `currentStatus='pending'`, `nextCheckAt=now`.
  - `listServicesByUser(userId: string): Promise<Service[]>` — newest first.
  - `getService(userId: string, id: string): Promise<Service | null>` — ownership-scoped.
  - `updateService(userId: string, id: string, patch: ServiceUpdateInput): Promise<Service | null>`.
  - `deleteService(userId: string, id: string): Promise<boolean>`.
  - `setPaused(userId: string, id: string, paused: boolean): Promise<Service | null>`.

- [ ] **Step 1: Write the failing test** — `apps/server/src/db/repositories/services.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import {
  createService,
  deleteService,
  getService,
  listServicesByUser,
  setPaused,
  updateService,
} from './services';

async function makeUser(clerkId = 'user_svc') {
  const u = await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` });
  return u.id;
}

describe('services repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('creates a service as pending and due now', async () => {
    const userId = await makeUser();
    const svc = await createService(userId, {
      name: 'Wayfare',
      baseUrl: 'https://wayfare.thiluxan.com',
      healthCheckPath: '/',
      expectedStatusCodes: [200],
      checkIntervalSeconds: 60,
      timeoutSeconds: 10,
    });
    expect(svc.currentStatus).toBe('pending');
    expect(svc.nextCheckAt).not.toBeNull();
    expect(svc.userId).toBe(userId);
  });

  it('lists only the owner-visible services', async () => {
    const a = await makeUser('user_a');
    const b = await makeUser('user_b');
    await createService(a, { name: 'A1', baseUrl: 'https://a1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await createService(b, { name: 'B1', baseUrl: 'https://b1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    expect((await listServicesByUser(a)).map((s) => s.name)).toEqual(['A1']);
  });

  it('does not return another user\'s service by id', async () => {
    const a = await makeUser('user_a');
    const b = await makeUser('user_b');
    const svc = await createService(a, { name: 'A1', baseUrl: 'https://a1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    expect(await getService(b, svc.id)).toBeNull();
    expect(await getService(a, svc.id)).not.toBeNull();
  });

  it('updates, pauses, and deletes (ownership-scoped)', async () => {
    const userId = await makeUser();
    const svc = await createService(userId, { name: 'X', baseUrl: 'https://x.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    const updated = await updateService(userId, svc.id, { name: 'X2' });
    expect(updated?.name).toBe('X2');
    const paused = await setPaused(userId, svc.id, true);
    expect(paused?.paused).toBe(true);
    expect(await deleteService('other-user', svc.id)).toBe(false);
    expect(await deleteService(userId, svc.id)).toBe(true);
    expect(await getService(userId, svc.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- services`
Expected: FAIL — cannot resolve `./services`.

- [ ] **Step 3: Implement** — `apps/server/src/db/repositories/services.ts`

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { ServiceCreateInput, ServiceUpdateInput } from '@beacon/shared';
import { db } from '../index';
import { services, type Service } from '../schema';

export async function createService(userId: string, input: ServiceCreateInput): Promise<Service> {
  const rows = await db
    .insert(services)
    .values({
      userId,
      name: input.name,
      description: input.description,
      baseUrl: input.baseUrl,
      healthCheckPath: input.healthCheckPath,
      expectedStatusCodes: input.expectedStatusCodes,
      checkIntervalSeconds: input.checkIntervalSeconds,
      timeoutSeconds: input.timeoutSeconds,
      currentStatus: 'pending',
      currentStatusSince: new Date(),
      nextCheckAt: new Date(),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createService: no row returned');
  return row;
}

export async function listServicesByUser(userId: string): Promise<Service[]> {
  return db.select().from(services).where(eq(services.userId, userId)).orderBy(desc(services.createdAt));
}

export async function getService(userId: string, id: string): Promise<Service | null> {
  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateService(
  userId: string,
  id: string,
  patch: ServiceUpdateInput,
): Promise<Service | null> {
  const rows = await db
    .update(services)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteService(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(services)
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning({ id: services.id });
  return rows.length > 0;
}

export async function setPaused(userId: string, id: string, paused: boolean): Promise<Service | null> {
  const rows = await db
    .update(services)
    .set({ paused, currentStatus: paused ? 'paused' : 'pending', updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning();
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- services`
Expected: PASS (4/4).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/services.test.ts
git commit -m "feat(server): services repository CRUD with ownership scoping"
```

---

### Task 4: Worker-facing repository functions

**Files:**
- Create: `apps/server/src/db/repositories/service-checks.ts`
- Modify: `apps/server/src/db/repositories/services.ts`
- Create: `apps/server/src/db/repositories/worker-queries.test.ts`

**Interfaces:**
- Consumes: `db`, `services`, `serviceChecks`, `type Service`, `type NewServiceCheck`; `CheckStatus`, `ServiceStatus`.
- Produces:
  - `recordCheck(input: NewServiceCheck): Promise<void>` (in `service-checks.ts`).
  - `findDueServices(limit: number): Promise<Service[]>` — `nextCheckAt <= now AND paused = false`, oldest-due first (added to `services.ts`).
  - `applyCheckResult(args: { service: Service; check: { status: CheckStatus; statusCode: number | null; responseTimeMs: number | null; errorMessage: string | null }; newStatus: ServiceStatus }): Promise<void>` — in one transaction: insert the check row, set `lastCheckAt=now`, `nextCheckAt=now+interval`, and (only if changed) `currentStatus`/`currentStatusSince` (added to `services.ts`).

- [ ] **Step 1: Write the failing test** — `apps/server/src/db/repositories/worker-queries.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService, findDueServices, getService, setPaused } from './services';

async function makeService() {
  const u = await upsertFromClerk({ clerkUserId: 'user_w', email: 'w@e.com' });
  return createService(u.id, {
    name: 'W', baseUrl: 'https://w.com', healthCheckPath: '/',
    expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10,
  });
}

describe('worker queries (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('findDueServices returns a freshly-created (due-now) service', async () => {
    const svc = await makeService();
    const due = await findDueServices(10);
    expect(due.map((s) => s.id)).toContain(svc.id);
  });

  it('findDueServices skips paused services', async () => {
    const svc = await makeService();
    await setPaused(svc.userId, svc.id, true);
    const due = await findDueServices(10);
    expect(due.map((s) => s.id)).not.toContain(svc.id);
  });

  it('applyCheckResult records a check, advances next_check_at, and flips status on change', async () => {
    const svc = await makeService();
    await applyCheckResult({
      service: svc,
      check: { status: 'success', statusCode: 200, responseTimeMs: 42, errorMessage: null },
      newStatus: 'up',
    });
    const after = await getService(svc.userId, svc.id);
    expect(after?.currentStatus).toBe('up');
    expect(after?.lastCheckAt).not.toBeNull();
    expect(after?.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM service_checks WHERE service_id=$1', [svc.id]);
    expect(rows[0].n).toBe(1);
  });

  it('applyCheckResult is no longer due immediately after a check', async () => {
    const svc = await makeService();
    await applyCheckResult({
      service: svc,
      check: { status: 'failure', statusCode: 500, responseTimeMs: 10, errorMessage: null },
      newStatus: 'down',
    });
    expect((await findDueServices(10)).map((s) => s.id)).not.toContain(svc.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- worker-queries`
Expected: FAIL — `findDueServices`/`applyCheckResult` not exported.

- [ ] **Step 3: Implement `recordCheck`** — `apps/server/src/db/repositories/service-checks.ts`

```ts
import { db } from '../index';
import { serviceChecks, type NewServiceCheck } from '../schema';

export async function recordCheck(input: NewServiceCheck): Promise<void> {
  await db.insert(serviceChecks).values(input);
}
```

- [ ] **Step 4: Implement worker queries** — append to `apps/server/src/db/repositories/services.ts`

Add imports at the top (merge with existing): `import { and, desc, eq, lte, sql } from 'drizzle-orm';` and `import { serviceChecks, type ServiceCheck } from '../schema';` and `import type { CheckStatus, ServiceStatus } from '@beacon/shared';`. Then append:

```ts
export async function findDueServices(limit: number): Promise<Service[]> {
  return db
    .select()
    .from(services)
    .where(and(eq(services.paused, false), lte(services.nextCheckAt, new Date())))
    .orderBy(services.nextCheckAt)
    .limit(limit);
}

export async function applyCheckResult(args: {
  service: Service;
  check: { status: CheckStatus; statusCode: number | null; responseTimeMs: number | null; errorMessage: string | null };
  newStatus: ServiceStatus;
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.service.checkIntervalSeconds * 1000);
  const statusChanged = args.newStatus !== args.service.currentStatus;
  await db.transaction(async (tx) => {
    await tx.insert(serviceChecks).values({
      serviceId: args.service.id,
      status: args.check.status,
      statusCode: args.check.statusCode,
      responseTimeMs: args.check.responseTimeMs,
      errorMessage: args.check.errorMessage,
      checkedAt: now,
    });
    await tx
      .update(services)
      .set({
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
        ...(statusChanged ? { currentStatus: args.newStatus, currentStatusSince: now } : {}),
      })
      .where(eq(services.id, args.service.id));
  });
}
```

> `ServiceCheck` import is used by later tasks reading history; keep it exported-friendly. `sql` import may be unused — remove it if eslint flags it.

- [ ] **Step 5: Run it to verify it passes**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- worker-queries`
Expected: PASS (4/4).

- [ ] **Step 6: Commit (request approval first)**

```bash
git add apps/server/src/db/repositories/service-checks.ts apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/worker-queries.test.ts
git commit -m "feat(server): worker repository queries (find-due, apply-check-result)"
```

---

### Task 5: Check classification (pure function)

**Files:**
- Create: `apps/server/src/workers/check-classify.ts`
- Create: `apps/server/src/workers/check-classify.test.ts`

**Interfaces:**
- Produces: `classifyCheck(input: ClassifyInput): ClassifyResult` where
  - `ClassifyInput = { outcome: 'response'; statusCode: number; responseTimeMs: number; expectedStatusCodes: number[] } | { outcome: 'timeout'; responseTimeMs: number } | { outcome: 'error'; errorMessage: string }`
  - `ClassifyResult = { status: CheckStatus; statusCode: number | null; responseTimeMs: number | null; errorMessage: string | null; serviceStatus: 'up' | 'down' }`

- [ ] **Step 1: Write the failing test** — `apps/server/src/workers/check-classify.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { classifyCheck } from './check-classify';

describe('classifyCheck', () => {
  it('success when status code is expected', () => {
    expect(classifyCheck({ outcome: 'response', statusCode: 200, responseTimeMs: 30, expectedStatusCodes: [200] }))
      .toEqual({ status: 'success', statusCode: 200, responseTimeMs: 30, errorMessage: null, serviceStatus: 'up' });
  });

  it('success when status code is one of several expected', () => {
    expect(classifyCheck({ outcome: 'response', statusCode: 401, responseTimeMs: 12, expectedStatusCodes: [200, 401] }).status)
      .toBe('success');
  });

  it('failure when status code is not expected', () => {
    const r = classifyCheck({ outcome: 'response', statusCode: 500, responseTimeMs: 12, expectedStatusCodes: [200] });
    expect(r.status).toBe('failure');
    expect(r.serviceStatus).toBe('down');
  });

  it('timeout maps to down with null status code', () => {
    const r = classifyCheck({ outcome: 'timeout', responseTimeMs: 10_000 });
    expect(r).toEqual({ status: 'timeout', statusCode: null, responseTimeMs: 10_000, errorMessage: null, serviceStatus: 'down' });
  });

  it('error carries the message and maps to down', () => {
    const r = classifyCheck({ outcome: 'error', errorMessage: 'ENOTFOUND' });
    expect(r).toEqual({ status: 'error', statusCode: null, responseTimeMs: null, errorMessage: 'ENOTFOUND', serviceStatus: 'down' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/server -- check-classify`
Expected: FAIL — cannot resolve `./check-classify`.

- [ ] **Step 3: Implement** — `apps/server/src/workers/check-classify.ts`

```ts
import type { CheckStatus } from '@beacon/shared';

export type ClassifyInput =
  | { outcome: 'response'; statusCode: number; responseTimeMs: number; expectedStatusCodes: number[] }
  | { outcome: 'timeout'; responseTimeMs: number }
  | { outcome: 'error'; errorMessage: string };

export type ClassifyResult = {
  status: CheckStatus;
  statusCode: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
  serviceStatus: 'up' | 'down';
};

export function classifyCheck(input: ClassifyInput): ClassifyResult {
  if (input.outcome === 'timeout') {
    return { status: 'timeout', statusCode: null, responseTimeMs: input.responseTimeMs, errorMessage: null, serviceStatus: 'down' };
  }
  if (input.outcome === 'error') {
    return { status: 'error', statusCode: null, responseTimeMs: null, errorMessage: input.errorMessage, serviceStatus: 'down' };
  }
  const ok = input.expectedStatusCodes.includes(input.statusCode);
  return {
    status: ok ? 'success' : 'failure',
    statusCode: input.statusCode,
    responseTimeMs: input.responseTimeMs,
    errorMessage: null,
    serviceStatus: ok ? 'up' : 'down',
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @beacon/server -- check-classify`
Expected: PASS (5/5).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/workers/check-classify.ts apps/server/src/workers/check-classify.test.ts
git commit -m "feat(server): pure check-result classification"
```

---

### Task 6: Bounded concurrency helper

**Files:**
- Create: `apps/server/src/lib/concurrency.ts`
- Create: `apps/server/src/lib/concurrency.test.ts`

**Interfaces:**
- Produces: `runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>` — runs `fn` over all items, at most `limit` in flight at once.

- [ ] **Step 1: Write the failing test** — `apps/server/src/lib/concurrency.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { runBounded } from './concurrency';

describe('runBounded', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let max = 0;
    await runBounded([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(max).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/server -- concurrency`
Expected: FAIL — cannot resolve `./concurrency`.

- [ ] **Step 3: Implement** — `apps/server/src/lib/concurrency.ts`

```ts
export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @beacon/server -- concurrency`
Expected: PASS (2/2).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/lib/concurrency.ts apps/server/src/lib/concurrency.test.ts
git commit -m "feat(server): bounded-concurrency helper (no dependency)"
```

---

### Task 7: The check worker

**Files:**
- Create: `apps/server/src/workers/check-worker.ts`
- Create: `apps/server/src/workers/check-worker.test.ts`

**Interfaces:**
- Consumes: `classifyCheck`; `applyCheckResult`, `findDueServices`; `runBounded`; `type Service`.
- Produces:
  - `checkOne(service: Service, deps?: CheckDeps): Promise<void>` — runs one HTTP check and applies the result. `CheckDeps = { fetchFn?: typeof fetch; apply?: typeof applyCheckResult }` (defaults injected for testing).
  - `runWorker(): Promise<never>` — the poll loop (started by the entry below).

- [ ] **Step 1: Write the failing test** — `apps/server/src/workers/check-worker.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../db/schema';
import { checkOne } from './check-worker';

function fakeService(over: Partial<Service> = {}): Service {
  return {
    id: 's1', userId: 'u1', name: 'W', description: null,
    baseUrl: 'https://w.com', healthCheckPath: '/health',
    expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10,
    currentStatus: 'pending', currentStatusSince: new Date(),
    lastCheckAt: null, nextCheckAt: new Date(), paused: false, alertsEnabled: true,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as Service;
}

describe('checkOne', () => {
  it('applies an "up" result for an expected status code', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(fetchFn).toHaveBeenCalledWith('https://w.com/health', expect.objectContaining({ method: 'GET' }));
    expect(apply.mock.calls[0][0].newStatus).toBe('up');
    expect(apply.mock.calls[0][0].check.status).toBe('success');
  });

  it('applies a "down" result when the fetch throws', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(apply.mock.calls[0][0].newStatus).toBe('down');
    expect(apply.mock.calls[0][0].check.status).toBe('error');
  });

  it('applies a "down" result for an unexpected status code', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 503 }));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(apply.mock.calls[0][0].check.status).toBe('failure');
    expect(apply.mock.calls[0][0].newStatus).toBe('down');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/server -- check-worker`
Expected: FAIL — cannot resolve `./check-worker`.

- [ ] **Step 3: Implement** — `apps/server/src/workers/check-worker.ts`

```ts
import { applyCheckResult, findDueServices } from '../db/repositories/services';
import { runBounded } from '../lib/concurrency';
import type { Service } from '../db/schema';
import { classifyCheck, type ClassifyInput } from './check-classify';

const POLL_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 100;
const MAX_CONCURRENCY = 10;

type CheckDeps = { fetchFn?: typeof fetch; apply?: typeof applyCheckResult };

export async function checkOne(service: Service, deps: CheckDeps = {}): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const apply = deps.apply ?? applyCheckResult;
  const url = `${service.baseUrl}${service.healthCheckPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutSeconds * 1000);
  const startedAt = Date.now();

  let input: ClassifyInput;
  try {
    const res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    input = {
      outcome: 'response',
      statusCode: res.status,
      responseTimeMs: Date.now() - startedAt,
      expectedStatusCodes: service.expectedStatusCodes,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      input = { outcome: 'timeout', responseTimeMs: Date.now() - startedAt };
    } else {
      input = { outcome: 'error', errorMessage: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    clearTimeout(timer);
  }

  const r = classifyCheck(input);
  await apply({
    service,
    check: { status: r.status, statusCode: r.statusCode, responseTimeMs: r.responseTimeMs, errorMessage: r.errorMessage },
    newStatus: r.serviceStatus,
  });
}

export async function runWorker(): Promise<never> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const due = await findDueServices(BATCH_LIMIT);
      await runBounded(due, MAX_CONCURRENCY, async (svc) => {
        try {
          await checkOne(svc);
        } catch (err) {
          // A single check must never crash the loop.
          console.error('[beacon-worker] check failed', svc.id, err);
        }
      });
    } catch (err) {
      console.error('[beacon-worker] poll cycle failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
```

- [ ] **Step 4: Create the worker entry** — `apps/server/src/workers/index.ts`

```ts
import 'dotenv/config';
import './../lib/env'; // validate env at startup
import { runWorker } from './check-worker';

console.log('[beacon-worker] starting check loop');
void runWorker();
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -w @beacon/server -- check-worker`
Expected: PASS (3/3).

- [ ] **Step 6: Commit (request approval first)**

```bash
git add apps/server/src/workers/check-worker.ts apps/server/src/workers/check-worker.test.ts apps/server/src/workers/index.ts
git commit -m "feat(server): check worker (one-shot check + poll loop)"
```

---

### Task 8: Internal services API endpoints

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.services.test.ts`

**Interfaces:**
- Consumes: `getByClerkId`; services repository CRUD; `ServiceCreateSchema`, `ServiceUpdateSchema`.
- Produces HTTP endpoints (all require `x-internal-secret` and `x-clerk-user-id`):
  - `GET /internal/services` → `{ services: Service[] }`
  - `POST /internal/services` (body `ServiceCreate`) → `Service` (201)
  - `GET /internal/services/:id` → `Service` | 404
  - `PATCH /internal/services/:id` (body `ServiceUpdate`) → `Service` | 404
  - `DELETE /internal/services/:id` → 204 | 404
  - `POST /internal/services/:id/pause` (body `{ paused: boolean }`) → `Service` | 404

- [ ] **Step 1: Write the failing test** — `apps/server/src/router.services.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();

function req(path: string, init: RequestInit & { clerk?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-internal-secret', SECRET);
  if (init.clerk !== '') headers.set('x-clerk-user-id', init.clerk ?? 'user_api');
  return app.request(path, { ...init, headers });
}

describe('internal services endpoints', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
    await upsertFromClerk({ clerkUserId: 'user_api', email: 'api@e.com' });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('rejects without the internal secret', async () => {
    const res = await app.request('/internal/services', { headers: { 'x-clerk-user-id': 'user_api' } });
    expect(res.status).toBe(401);
  });

  it('creates and lists a service', async () => {
    const create = await req('/internal/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Wayfare', baseUrl: 'https://wayfare.thiluxan.com' }),
    });
    expect(create.status).toBe(201);
    const list = await req('/internal/services');
    const body = await list.json();
    expect(body.services).toHaveLength(1);
    expect(body.services[0].name).toBe('Wayfare');
  });

  it('404s for an unknown id', async () => {
    const res = await req('/internal/services/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- router.services`
Expected: FAIL — endpoints return 404.

- [ ] **Step 3: Implement** — add to `apps/server/src/router.ts`

Add imports (merge): `import { ServiceCreateSchema, ServiceUpdateSchema } from '@beacon/shared';`, `import { getByClerkId } from './db/repositories/users';`, and `import { createService, deleteService, getService, listServicesByUser, setPaused, updateService } from './db/repositories/services';`. Inside `createRouter`, before `return app;`, add:

```ts
  // All /internal/services* routes require the shared secret + a resolvable user.
  app.use('/internal/services/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  app.use('/internal/services', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  async function resolveUserId(c: { req: { header: (k: string) => string | undefined } }): Promise<string | null> {
    const clerkId = c.req.header('x-clerk-user-id');
    if (!clerkId) return null;
    const user = await getByClerkId(clerkId);
    return user?.id ?? null;
  }

  app.get('/internal/services', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json({ services: await listServicesByUser(userId) });
  });

  app.post('/internal/services', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = ServiceCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const svc = await createService(userId, parsed.data);
    return c.json(svc, 201);
  });

  app.get('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const svc = await getService(userId, c.req.param('id'));
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = ServiceUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const svc = await updateService(userId, c.req.param('id'), parsed.data);
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const ok = await deleteService(userId, c.req.param('id'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  app.post('/internal/services/:id/pause', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (typeof body?.paused !== 'boolean') return c.json({ error: 'invalid body' }, 400);
    const svc = await setPaused(userId, c.req.param('id'), body.paused);
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });
```

> Hono note: register the two `app.use` guards before the route handlers. Verify the matching semantics of `/internal/services` vs `/internal/services/*` against the installed Hono version; if one guard suffices for both, simplify.

- [ ] **Step 4: Run it to verify it passes**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters npm test -w @beacon/server -- router.services`
Expected: PASS (3/3).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/router.ts apps/server/src/router.services.test.ts
git commit -m "feat(server): internal services CRUD endpoints"
```

---

### Task 9: Web internal-API client

**Files:**
- Create: `apps/web/lib/services-api.ts`

**Interfaces:**
- Consumes: `serverApiBaseUrl` from `./api-base`; `Service`-shaped JSON.
- Produces (all `server-only`, set `x-internal-secret` + `x-clerk-user-id`):
  - `fetchServices(clerkUserId: string): Promise<ServiceDto[]>`
  - `createServiceOnServer(clerkUserId, input): Promise<ServiceDto>`
  - `updateServiceOnServer(clerkUserId, id, patch): Promise<ServiceDto>`
  - `deleteServiceOnServer(clerkUserId, id): Promise<void>`
  - `pauseServiceOnServer(clerkUserId, id, paused): Promise<ServiceDto>`
  - `ServiceDto` — the JSON shape returned by the server (id, name, baseUrl, currentStatus, lastCheckAt, etc., dates as ISO strings).

- [ ] **Step 1: Implement** — `apps/web/lib/services-api.ts`

```ts
import 'server-only';
import type { ServiceCreateInput, ServiceStatus, ServiceUpdateInput } from '@beacon/shared';

import { serverApiBaseUrl } from './api-base';

export type ServiceDto = {
  id: string;
  name: string;
  description: string | null;
  baseUrl: string;
  healthCheckPath: string;
  currentStatus: ServiceStatus;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  paused: boolean;
  checkIntervalSeconds: number;
  timeoutSeconds: number;
  expectedStatusCodes: number[];
};

function headers(clerkUserId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
    'x-clerk-user-id': clerkUserId,
  };
}

export async function fetchServices(clerkUserId: string): Promise<ServiceDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services`, {
    headers: headers(clerkUserId),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`fetchServices failed: ${res.status}`);
  return (await res.json()).services as ServiceDto[];
}

export async function createServiceOnServer(clerkUserId: string, input: ServiceCreateInput): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services`, {
    method: 'POST',
    headers: headers(clerkUserId),
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`createService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function updateServiceOnServer(clerkUserId: string, id: string, patch: ServiceUpdateInput): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, {
    method: 'PATCH',
    headers: headers(clerkUserId),
    body: JSON.stringify(patch),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`updateService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function deleteServiceOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, {
    method: 'DELETE',
    headers: headers(clerkUserId),
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) throw new Error(`deleteService failed: ${res.status}`);
}

export async function pauseServiceOnServer(clerkUserId: string, id: string, paused: boolean): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}/pause`, {
    method: 'POST',
    headers: headers(clerkUserId),
    body: JSON.stringify({ paused }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`pauseService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: clean.

- [ ] **Step 3: Commit (request approval first)**

```bash
git add apps/web/lib/services-api.ts
git commit -m "feat(web): server-side internal API client for services"
```

---

### Task 10: Web Server Actions

**Files:**
- Create: `apps/web/app/(app)/services/actions.ts`

**Interfaces:**
- Consumes: `currentUser` (Clerk); the `services-api` client; `ServiceCreateSchema`, `ServiceUpdateSchema`.
- Produces Server Actions returning `{ ok: true; data } | { ok: false; error: string }`:
  - `createServiceAction(input: unknown)`, `updateServiceAction(id, patch)`, `deleteServiceAction(id)`, `pauseServiceAction(id, paused)`. Each revalidates `/services`.

**Note:** Confirm Next.js 16's Server Action + `revalidatePath` signatures in `node_modules/next/dist/docs/` before writing.

- [ ] **Step 1: Implement** — `apps/web/app/(app)/services/actions.ts`

```ts
'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { ServiceCreateSchema, ServiceUpdateSchema } from '@beacon/shared';

import {
  createServiceOnServer,
  deleteServiceOnServer,
  pauseServiceOnServer,
  updateServiceOnServer,
} from '@/lib/services-api';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function createServiceAction(input: unknown): Promise<Result<{ id: string }>> {
  const parsed = ServiceCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const svc = await createServiceOnServer(clerkId, parsed.data);
    revalidatePath('/services');
    return { ok: true, data: { id: svc.id } };
  } catch (err) {
    console.error('[beacon-web] createServiceAction failed', err);
    return { ok: false, error: 'Could not create the service.' };
  }
}

export async function updateServiceAction(id: string, patch: unknown): Promise<Result<{ id: string }>> {
  const parsed = ServiceUpdateSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const svc = await updateServiceOnServer(clerkId, id, parsed.data);
    revalidatePath('/services');
    return { ok: true, data: { id: svc.id } };
  } catch (err) {
    console.error('[beacon-web] updateServiceAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}

export async function deleteServiceAction(id: string): Promise<Result<null>> {
  try {
    const clerkId = await requireClerkId();
    await deleteServiceOnServer(clerkId, id);
    revalidatePath('/services');
    return { ok: true, data: null };
  } catch (err) {
    console.error('[beacon-web] deleteServiceAction failed', err);
    return { ok: false, error: 'Could not delete the service.' };
  }
}

export async function pauseServiceAction(id: string, paused: boolean): Promise<Result<null>> {
  try {
    const clerkId = await requireClerkId();
    await pauseServiceOnServer(clerkId, id, paused);
    revalidatePath('/services');
    return { ok: true, data: null };
  } catch (err) {
    console.error('[beacon-web] pauseServiceAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: clean.

- [ ] **Step 3: Commit (request approval first)**

```bash
git add "apps/web/app/(app)/services/actions.ts"
git commit -m "feat(web): server actions for service create/update/delete/pause"
```

---

### Task 11: Web dashboard — live list + Add Service

**Files:**
- Modify: `apps/web/app/(app)/services/page.tsx`
- Create: `apps/web/components/services/service-form-dialog.tsx` (reused for create AND edit)
- Create: `apps/web/components/services/service-row-actions.tsx`

**Interfaces:**
- Consumes: `fetchServices`, `currentUser`; the Server Actions from Task 10.
- Produces: a Server Component services list rendering real rows (name, status, last response time, last-checked) with the existing column layout, an honest empty state when there are none, a working **Add service** dialog, and per-row pause/delete.

**REQUIRED SUB-SKILL:** engage `frontend-design` for the visual pass. Confirm Next.js 16 client-component + `useActionState`/form APIs in `node_modules/next/dist/docs/` before writing.

- [ ] **Step 1: Build the reusable service form dialog (client, create + edit)** — `apps/web/components/services/service-form-dialog.tsx`

```tsx
'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { createServiceAction, updateServiceAction } from '@/app/(app)/services/actions';

type Initial = { id?: string; name?: string; baseUrl?: string; healthCheckPath?: string };

export function ServiceFormDialog({
  service,
  triggerLabel,
  triggerVariant = 'default',
}: {
  service?: Initial;
  triggerLabel: string;
  triggerVariant?: 'default' | 'ghost';
}) {
  const isEdit = Boolean(service?.id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    const input = {
      name: String(formData.get('name') ?? ''),
      baseUrl: String(formData.get('baseUrl') ?? ''),
      healthCheckPath: String(formData.get('healthCheckPath') || '/'),
    };
    start(async () => {
      const res = isEdit
        ? await updateServiceAction(service!.id!, input)
        : await createServiceAction(input);
      if (res.ok) setOpen(false);
      else setError(res.error);
    });
  }

  return (
    <>
      <Button size="sm" variant={triggerVariant} onClick={() => setOpen(true)}>{triggerLabel}</Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true">
          <form action={onSubmit} className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-lg">
            <h2 className="text-sm font-semibold text-zinc-900">{isEdit ? 'Edit service' : 'Add a service'}</h2>
            <label className="mt-3 block text-[12px] font-medium text-zinc-600">Name
              <input name="name" required defaultValue={service?.name ?? ''} className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" placeholder="Wayfare" />
            </label>
            <label className="mt-3 block text-[12px] font-medium text-zinc-600">Base URL
              <input name="baseUrl" required type="url" defaultValue={service?.baseUrl ?? ''} className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" placeholder="https://wayfare.thiluxan.com" />
            </label>
            <label className="mt-3 block text-[12px] font-medium text-zinc-600">Health check path
              <input name="healthCheckPath" defaultValue={service?.healthCheckPath ?? '/'} className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" />
            </label>
            {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : isEdit ? 'Save' : 'Add service'}</Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Build per-row actions (client, edit + pause + delete)** — `apps/web/components/services/service-row-actions.tsx`

```tsx
'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ServiceFormDialog } from '@/components/services/service-form-dialog';
import { deleteServiceAction, pauseServiceAction } from '@/app/(app)/services/actions';
import type { ServiceDto } from '@/lib/services-api';

export function ServiceRowActions({ service }: { service: ServiceDto }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1.5">
      <ServiceFormDialog service={service} triggerLabel="Edit" triggerVariant="ghost" />
      <Button size="sm" variant="ghost" disabled={pending}
        onClick={() => start(async () => { await pauseServiceAction(service.id, !service.paused); })}>
        {service.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button size="sm" variant="ghost" disabled={pending}
        onClick={() => start(async () => { await deleteServiceAction(service.id); })}>
        Delete
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the page as a live Server Component** — `apps/web/app/(app)/services/page.tsx`

```tsx
import { currentUser } from '@clerk/nextjs/server';
import { fetchServices, type ServiceDto } from '@/lib/services-api';
import { ServiceFormDialog } from '@/components/services/service-form-dialog';
import { ServiceRowActions } from '@/components/services/service-row-actions';

const STATUS_STYLE: Record<string, string> = {
  up: 'text-emerald-600',
  down: 'text-red-600',
  degraded: 'text-amber-600',
  paused: 'text-zinc-400',
  pending: 'text-zinc-400',
};

function lastChecked(s: ServiceDto): string {
  if (!s.lastCheckAt) return '—';
  const secs = Math.round((Date.now() - new Date(s.lastCheckAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

export default async function ServicesPage() {
  const user = await currentUser();
  const services = user ? await fetchServices(user.id) : [];

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-sm font-semibold text-zinc-900">Services</h1>
          <span className="font-mono text-[10px] tabular-nums text-zinc-400">{services.length} endpoints</span>
        </div>
        <ServiceFormDialog triggerLabel="Add service" />
      </div>

      {services.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="py-16 text-center">
            <p className="text-[13px] font-medium text-zinc-700">No services yet</p>
            <p className="mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-zinc-400">
              Add a service and the background worker will start checking it within a few seconds.
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200/40">
          {services.map((s) => (
            <li key={s.id} className="flex items-center gap-4 px-5 py-3">
              <div className="flex-1">
                <p className="text-[13px] font-medium text-zinc-900">{s.name}</p>
                <p className="font-mono text-[11px] text-zinc-400">{s.baseUrl}{s.healthCheckPath}</p>
              </div>
              <span className={`w-20 text-[12px] font-medium capitalize ${STATUS_STYLE[s.currentStatus] ?? 'text-zinc-500'}`}>
                {s.currentStatus}
              </span>
              <span className="w-28 text-right font-mono text-[11px] tabular-nums text-zinc-400">{lastChecked(s)}</span>
              <ServiceRowActions service={s} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Verify (typecheck, lint, manual)**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Then manually: with web + server + worker running locally and signed in, add a service pointing at a real URL; within ~5s a refresh shows it flip from `pending` to `up`/`down`. Run a design pass with the frontend-design skill.

- [ ] **Step 5: Commit (request approval first)**

```bash
git add "apps/web/app/(app)/services/page.tsx" apps/web/components/services
git commit -m "feat(web): live services dashboard with add/pause/delete"
```

---

### Task 12: Worker process model + infrastructure

**Files:**
- Modify: `apps/server/package.json` (add `worker` script)
- Modify: `package.json` (run worker in dev)
- Modify: `infrastructure/docker-compose.yml` (worker service)
- Modify: `docs/INFRASTRUCTURE.md` (document it)

**Interfaces:**
- Produces: a `worker` process that runs alongside the stack — locally via `npm run dev`, in production via a 5th Compose service using the `beacon-server` image with command `npm run worker`.

- [ ] **Step 1: Add the worker script** — in `apps/server/package.json` `scripts`

```json
"worker": "tsx src/workers/index.ts",
"worker:dev": "tsx watch src/workers/index.ts"
```

- [ ] **Step 2: Run the worker in local dev** — edit root `package.json` `scripts`

```json
"dev": "concurrently -n web,server,worker -c blue,green,magenta \"npm:dev:web\" \"npm:dev:server\" \"npm:dev:worker\"",
"dev:worker": "npm run worker:dev -w @beacon/server"
```

- [ ] **Step 3: Add the production worker service** — in `infrastructure/docker-compose.yml`, add under `services:` (mirrors the `server` service but overrides the command; no published ports)

```yaml
  worker:
    image: ghcr.io/thiluxan-s/beacon-server:${BEACON_VERSION:-latest}
    restart: unless-stopped
    command: ['npm', 'run', 'worker']
    env_file:
      - path: .env
        required: false
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 4: Validate compose**

Run: `BEACON_VERSION=test POSTGRES_PASSWORD=test docker compose -f infrastructure/docker-compose.yml config >/dev/null && echo OK`
Expected: `OK` (the `worker` service parses; uses the server image + `npm run worker`).

- [ ] **Step 5: Document it** — add to `docs/INFRASTRUCTURE.md` (near the compose/stack description)

```markdown
### Background worker

A `worker` service runs in the Compose stack using the same `beacon-server` image with `command: npm run worker` (entry `apps/server/src/workers/index.ts`). It polls Postgres for due service checks every ~5s, runs HTTP health checks with a per-check timeout, and writes results + status. It publishes no ports and is restarted by Docker if it crashes (stateless — it resumes from the DB). Locally it runs as part of `npm run dev`.
```

- [ ] **Step 6: Full verify**

Run: `npm run typecheck && npm run lint && npm test` (with local Postgres up and the server test env vars set)
Expected: all clean/green.

- [ ] **Step 7: Commit (request approval first)**

```bash
git add apps/server/package.json package.json infrastructure/docker-compose.yml docs/INFRASTRUCTURE.md
git commit -m "feat(infra): run the check worker as a compose service and in local dev"
```

---

## Notes for the executor

- Tasks 1, 3–8 have real test cycles (unit + Postgres integration + Hono route tests). Tasks 9–12 are typecheck/lint/compose-validated plus one manual end-to-end check (add a service → status flips on refresh).
- The status-transition write in `applyCheckResult` (Task 4) is the single seam Slice B hooks into to broadcast over WebSockets — do not scatter status writes elsewhere.
- Production migration runs automatically inside `deploy.sh` on the next deploy; no manual prod step.
- Approval gate: per `CLAUDE.md`, pause for the human's approval before every `git add`/`git commit`.
```
