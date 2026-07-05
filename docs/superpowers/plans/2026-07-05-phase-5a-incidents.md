# Phase 5a — Incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a debounced incident with a timeline whenever a monitored service goes down, browsable at `/incidents` and `/incidents/[id]`, with open/resolve pushed live over the existing WebSocket fan-out.

**Architecture:** A pure `decideTransition()` implements 2-strike lockstep debounce and is wired into the existing single `applyCheckResult` transaction; incident open/close/observe run through a new `incidents` repository inside that same transaction; two new WS event types route through the untouched hub; two read endpoints and a new web area surface the data.

**Tech Stack:** Node + Hono, Drizzle (Postgres), `ws`, Next.js 16 (App Router, Server Components), Tailwind, Zod, Vitest.

## Global Constraints

- TypeScript `strict`, **no `any`** — use `unknown` + narrow. (from CLAUDE.md)
- Zod schemas are the source of truth; DB types via Drizzle `$inferSelect`/`$inferInsert`. (from CLAUDE.md)
- **All DB access through `db/repositories/`** — no raw Drizzle in routes/workers/components. (from CLAUDE.md)
- Dates are `timestamptz`; server clocks UTC; never store dates as strings. (from CLAUDE.md)
- WS message shapes live in `packages/shared/src/schemas/ws-event.ts` and are Zod-validated. (from CLAUDE.md)
- A single check/apply failure must never crash the worker loop. (from CLAUDE.md)
- Default to Server Components; `"use client"` only for state/effects/WS. (from CLAUDE.md)
- `CONFIRM_THRESHOLD = 2`; incident `severity` is always `'down'` in 5a; `degraded` reserved-unused; `notification_sent` created-but-unused (5b). (from spec)
- **Next 16 is not the Next.js in training data** — read `apps/web/node_modules/next/dist/docs/` before web code. (from apps/web/AGENTS.md)
- Conventional commits. **Pause for user approval before every `git add`/`git commit`** (CLAUDE.md approval workflow) — the commit steps below are gated on that approval.
- Branch: `phase-5a-incidents` (already created).
- "Done" per task: `npm run typecheck` + `npm run lint` clean.

---

## File map

**Server**
- `apps/server/src/db/schema.ts` — Modify: incident enums, `incidents` + `incident_events` tables, two `services` counter columns.
- `apps/server/src/workers/transition.ts` — Create: pure `decideTransition`.
- `apps/server/src/workers/transition.test.ts` — Create.
- `apps/server/src/db/repositories/incidents.ts` — Create: mutators (tx) + reads + `describeFailure`.
- `apps/server/src/db/repositories/incidents.test.ts` — Create.
- `apps/server/src/db/repositories/services.ts` — Modify: `applyCheckResult` (rawStatus + counters + incidents), `setPaused` (auto-resolve).
- `apps/server/src/db/repositories/services.test.ts` — Modify: sequence + pause tests.
- `apps/server/src/workers/check-worker.ts` — Modify: one line (`newStatus` → `rawStatus`).
- `apps/server/src/router.ts` — Modify: `/internal/incidents` auth + two routes.
- `apps/server/src/router.incidents.test.ts` — Create.

**Shared**
- `packages/shared/src/schemas/ws-event.ts` — Modify: two new event schemas + union.
- `packages/shared/src/schemas/ws-event.test.ts` — Modify.

**Web**
- `apps/web/lib/incidents-api.ts` — Create: DTOs + `fetchIncidents`/`fetchIncident`.
- `apps/web/lib/incident-style.ts` — Create: severity/event style tokens.
- `apps/web/app/(app)/incidents/page.tsx` — Create: list (Server Component).
- `apps/web/components/incidents/incidents-live-list.tsx` — Create: live list (client).
- `apps/web/app/(app)/incidents/[id]/page.tsx` — Create: timeline (Server Component).
- `apps/web/components/incidents/incident-timeline-live.tsx` — Create: live duration/resolve (client).
- `apps/web/app/(app)/layout.tsx` — Modify: nav links.
- `apps/web/app/(app)/services/[serviceId]/page.tsx` — Modify: incidents section + active badge.

**Docs**
- `docs/DATA_MODEL.md` — Modify (Task 1): counter columns + open-incident index.
- `docs/ARCHITECTURE.md` — Modify (Task 4): two new WS event types.

---

## Task 1: Schema — incidents, incident_events, strike counters, migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `docs/DATA_MODEL.md`
- Create (generated): `apps/server/drizzle/<n>_*.sql`

**Interfaces:**
- Produces: `incidents`, `incidentEvents` tables + `Incident`, `NewIncident`, `IncidentEvent`, `NewIncidentEvent` types; `incidentSeverity`, `incidentEventType` enums; `services.consecutiveFailures`, `services.consecutiveSuccesses` columns.

- [ ] **Step 1: Add enums, counter columns, and tables to `schema.ts`**

Add after the existing `checkStatus` enum:

```ts
export const incidentSeverity = pgEnum('incident_severity', ['degraded', 'down']);
export const incidentEventType = pgEnum('incident_event_type', ['opened', 'observed', 'resolved', 'note']);
```

Add these two columns inside the `services` table definition (after `alertsEnabled`):

```ts
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
```

Add these tables after `serviceChecks` (import `sql` from `drizzle-orm` at the top — it is not yet imported in this file):

```ts
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    severity: incidentSeverity('severity').notNull(),
    triggerCheckId: uuid('trigger_check_id').references(() => serviceChecks.id, { onDelete: 'set null' }),
    resolutionCheckId: uuid('resolution_check_id').references(() => serviceChecks.id, { onDelete: 'set null' }),
    notificationSent: boolean('notification_sent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incidents_service_started_idx').on(t.serviceId, t.startedAt.desc()),
    uniqueIndex('incidents_one_open_per_service_idx').on(t.serviceId).where(sql`resolved_at IS NULL`),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    eventType: incidentEventType('event_type').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('incident_events_incident_occurred_idx').on(t.incidentId, t.occurredAt)],
);

export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
export type IncidentEvent = typeof incidentEvents.$inferSelect;
export type NewIncidentEvent = typeof incidentEvents.$inferInsert;
```

Note: `trigger_check_id` / `resolution_check_id` use `on delete set null` (not cascade) so the 30-day check-pruning job can delete referenced checks without destroying incident history.

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file under `apps/server/drizzle/` containing `CREATE TYPE "incident_severity"`, `CREATE TYPE "incident_event_type"`, `CREATE TABLE "incidents"`, `CREATE TABLE "incident_events"`, `ALTER TABLE "services" ADD COLUMN "consecutive_failures"`, and a partial `CREATE UNIQUE INDEX ... WHERE "resolved_at" IS NULL`.

- [ ] **Step 3: Inspect the generated SQL**

Open the new `apps/server/drizzle/*.sql`. Confirm the partial unique index has the `WHERE "resolved_at" IS NULL` clause (Drizzle sometimes drops `.where()` on indexes — if missing, hand-edit the migration SQL to add it, since we rely on it as an invariant).

- [ ] **Step 4: Apply the migration locally**

Run: `npm run db:migrate`
Expected: applies cleanly; no error.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (both apps).

- [ ] **Step 6: Update `DATA_MODEL.md`**

In the `services` table block, add the two counter columns with a one-line note: `consecutive_failures` / `consecutive_successes` — strike counters powering 2-check debounce (Phase 5a). In the `incidents` section, note the partial unique index `(service_id) WHERE resolved_at IS NULL` enforcing at most one open incident per service.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle docs/DATA_MODEL.md
git commit -m "feat(server): incidents + incident_events schema, service strike counters"
```

---

## Task 2: Pure transition decision

**Files:**
- Create: `apps/server/src/workers/transition.ts`
- Create: `apps/server/src/workers/transition.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function decideTransition(input: {
    currentStatus: 'pending' | 'up' | 'down' | 'degraded' | 'paused';
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    rawStatus: 'up' | 'down';
  }): { nextStatus: 'up' | 'down'; incidentAction: 'open' | 'resolve' | 'none' };
  export const CONFIRM_THRESHOLD = 2;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/workers/transition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideTransition } from './transition';

const base = { consecutiveFailures: 0, consecutiveSuccesses: 0 } as const;

describe('decideTransition', () => {
  it('first failure from up: no change, no incident (invisible strike)', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveFailures: 1, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('second consecutive failure from up: flip down + open', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveFailures: 2, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'open' });
  });

  it('pending goes up immediately on first success', () => {
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveSuccesses: 1, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('pending needs two failures to go down + open', () => {
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveFailures: 1, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'pending', incidentAction: 'none' } as never);
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveFailures: 2, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'open' });
  });

  it('down: first success does not resolve', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveSuccesses: 1, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'none' });
  });

  it('down: two consecutive successes resolve', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveSuccesses: 2, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'resolve' });
  });

  it('stays up when already up and passing', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveSuccesses: 5, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('stays down when already down and failing', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveFailures: 5, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'none' });
  });
});
```

The `as never` on the pending-single-failure case: `nextStatus` is typed `'up' | 'down'` but the "no change" result echoes `currentStatus`. Resolve this in Step 3 by having the caller compare `nextStatus !== currentStatus` — the function returns the *current* status string when there is no change. Update the return type to `'up' | 'down' | 'pending' | 'degraded' | 'paused'` (the same union as `currentStatus`) and drop the `as never`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- transition`
Expected: FAIL — `decideTransition` not defined.

- [ ] **Step 3: Implement `transition.ts`**

```ts
type ServiceStatus = 'pending' | 'up' | 'down' | 'degraded' | 'paused';

export const CONFIRM_THRESHOLD = 2;

export type TransitionInput = {
  currentStatus: ServiceStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  rawStatus: 'up' | 'down';
};

export type TransitionResult = {
  nextStatus: ServiceStatus; // echoes currentStatus when unchanged; caller writes only if != currentStatus
  incidentAction: 'open' | 'resolve' | 'none';
};

export function decideTransition(input: TransitionInput): TransitionResult {
  const { currentStatus, consecutiveFailures, consecutiveSuccesses, rawStatus } = input;

  if (rawStatus === 'down') {
    const isConfirmedDown = currentStatus === 'down';
    if (!isConfirmedDown && consecutiveFailures >= CONFIRM_THRESHOLD) {
      return { nextStatus: 'down', incidentAction: 'open' };
    }
    return { nextStatus: currentStatus, incidentAction: 'none' };
  }

  // rawStatus === 'up'
  if (currentStatus === 'pending') {
    return { nextStatus: 'up', incidentAction: 'none' };
  }
  if (currentStatus === 'down' && consecutiveSuccesses >= CONFIRM_THRESHOLD) {
    return { nextStatus: 'up', incidentAction: 'resolve' };
  }
  return { nextStatus: currentStatus, incidentAction: 'none' };
}
```

Now remove the `as never` from the pending test (the return type accepts `'pending'`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace @beacon/server test -- transition`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workers/transition.ts apps/server/src/workers/transition.test.ts
git commit -m "feat(server): pure decideTransition — 2-strike lockstep debounce"
```

---

## Task 3: Incidents repository

**Files:**
- Create: `apps/server/src/db/repositories/incidents.ts`
- Create: `apps/server/src/db/repositories/incidents.test.ts`

**Interfaces:**
- Consumes: `incidents`, `incidentEvents`, `services`, `serviceChecks`, `Incident`, `IncidentEvent` (Task 1); `db` from `../index`.
- Produces:
  ```ts
  export type IncidentDetail = { status: 'success'|'failure'|'timeout'|'error'; statusCode: number|null; errorMessage: string|null };
  export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  export function describeFailure(d: IncidentDetail): string;
  export function findOpenIncident(tx: Tx, serviceId: string): Promise<Incident | null>;
  export function openIncident(tx: Tx, a: { serviceId: string; startedAt: Date; triggerCheckId: string; detail: IncidentDetail }): Promise<Incident>;
  export function recordObservationIfChanged(tx: Tx, a: { incidentId: string; detail: IncidentDetail; occurredAt: Date }): Promise<boolean>;
  export function resolveIncident(tx: Tx, a: { incidentId: string; startedAt: Date; resolvedAt: Date; resolutionCheckId: string | null; closeEvent: { type: 'resolved' | 'note'; message: string } }): Promise<{ durationSeconds: number }>;
  export type IncidentListRow = { id: string; serviceId: string; serviceName: string; severity: 'down'; startedAt: string; resolvedAt: string | null; durationSeconds: number | null };
  export function listIncidents(userId: string, opts: { serviceId?: string; open?: boolean }): Promise<IncidentListRow[]>;
  export function getIncidentWithEvents(userId: string, incidentId: string): Promise<{ incident: IncidentListRow; events: { id: string; occurredAt: string; eventType: string; message: string; metadata: Record<string, unknown> | null }[] } | null>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/incidents.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { serviceChecks, services } from '../schema';
import { upsertFromClerk } from './users';
import {
  describeFailure, findOpenIncident, openIncident, recordObservationIfChanged,
  resolveIncident, listIncidents, getIncidentWithEvents, type IncidentDetail,
} from './incidents';

async function seedService(clerkId = 'inc_user') {
  const u = await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` });
  const [svc] = await db.insert(services).values({
    userId: u.id, name: 'Svc', baseUrl: 'https://x.com', healthCheckPath: '/',
    currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date(),
  }).returning();
  return { userId: u.id, service: svc! };
}
async function seedCheck(serviceId: string) {
  const [c] = await db.insert(serviceChecks).values({ serviceId, status: 'failure', statusCode: 500 }).returning();
  return c!.id;
}
const detail500: IncidentDetail = { status: 'failure', statusCode: 500, errorMessage: null };
const detail503: IncidentDetail = { status: 'failure', statusCode: 503, errorMessage: null };

describe('incidents repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('describeFailure renders human strings', () => {
    expect(describeFailure(detail500)).toBe('HTTP 500');
    expect(describeFailure({ status: 'timeout', statusCode: null, errorMessage: null })).toBe('Request timed out');
    expect(describeFailure({ status: 'error', statusCode: null, errorMessage: 'ECONNREFUSED' })).toBe('Connection error: ECONNREFUSED');
  });

  it('opens an incident with an opened event and finds it', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    const startedAt = new Date();
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt, triggerCheckId: checkId, detail: detail500 }));
    expect(inc.severity).toBe('down');
    expect(inc.triggerCheckId).toBe(checkId);
    const open = await db.transaction((tx) => findOpenIncident(tx, service.id));
    expect(open?.id).toBe(inc.id);
  });

  it('records observed only when detail changes', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
    const same = await db.transaction((tx) => recordObservationIfChanged(tx, { incidentId: inc.id, detail: detail500, occurredAt: new Date() }));
    expect(same).toBe(false);
    const changed = await db.transaction((tx) => recordObservationIfChanged(tx, { incidentId: inc.id, detail: detail503, occurredAt: new Date() }));
    expect(changed).toBe(true);
  });

  it('resolves with duration and a resolved event', async () => {
    const { userId, service } = await seedService();
    const checkId = await seedCheck(service.id);
    const startedAt = new Date(Date.now() - 65_000);
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt, triggerCheckId: checkId, detail: detail500 }));
    const res = await db.transaction((tx) => resolveIncident(tx, { incidentId: inc.id, startedAt, resolvedAt: new Date(), resolutionCheckId: checkId, closeEvent: { type: 'resolved', message: 'Service recovered' } }));
    expect(res.durationSeconds).toBeGreaterThanOrEqual(64);
    const detail = await getIncidentWithEvents(userId, inc.id);
    expect(detail?.incident.resolvedAt).not.toBeNull();
    expect(detail?.events.map((e) => e.eventType)).toContain('resolved');
  });

  it('one open incident per service invariant', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
    await expect(
      db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 })),
    ).rejects.toThrow();
  });

  it('listIncidents filters by service and open, scoped to owner', async () => {
    const { userId, service } = await seedService('owner');
    const other = await seedService('intruder');
    const c1 = await seedCheck(service.id);
    await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: c1, detail: detail500 }));
    const all = await listIncidents(userId, {});
    expect(all).toHaveLength(1);
    expect(all[0]!.serviceName).toBe('Svc');
    const open = await listIncidents(userId, { open: true });
    expect(open).toHaveLength(1);
    const foreign = await listIncidents(other.userId, {});
    expect(foreign).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- incidents.test`
Expected: FAIL — module `./incidents` not found.

- [ ] **Step 3: Implement `incidents.ts`**

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../index';
import { incidentEvents, incidents, services, type Incident } from '../schema';

export type IncidentDetail = {
  status: 'success' | 'failure' | 'timeout' | 'error';
  statusCode: number | null;
  errorMessage: string | null;
};

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function describeFailure(d: IncidentDetail): string {
  if (d.status === 'timeout') return 'Request timed out';
  if (d.status === 'error') return d.errorMessage ? `Connection error: ${d.errorMessage}` : 'Connection error';
  if (d.statusCode != null) return `HTTP ${d.statusCode}`;
  return 'Check failed';
}

function detailMeta(d: IncidentDetail): Record<string, unknown> {
  return { status: d.status, statusCode: d.statusCode, errorMessage: d.errorMessage };
}

export async function findOpenIncident(tx: Tx, serviceId: string): Promise<Incident | null> {
  const rows = await tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.serviceId, serviceId), isNull(incidents.resolvedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function openIncident(
  tx: Tx,
  a: { serviceId: string; startedAt: Date; triggerCheckId: string; detail: IncidentDetail },
): Promise<Incident> {
  const rows = await tx
    .insert(incidents)
    .values({ serviceId: a.serviceId, startedAt: a.startedAt, severity: 'down', triggerCheckId: a.triggerCheckId })
    .returning();
  const incident = rows[0];
  if (!incident) throw new Error('openIncident: no row returned');
  await tx.insert(incidentEvents).values({
    incidentId: incident.id,
    occurredAt: a.startedAt,
    eventType: 'opened',
    message: describeFailure(a.detail),
    metadata: detailMeta(a.detail),
  });
  return incident;
}

export async function recordObservationIfChanged(
  tx: Tx,
  a: { incidentId: string; detail: IncidentDetail; occurredAt: Date },
): Promise<boolean> {
  const last = await tx
    .select({ metadata: incidentEvents.metadata })
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, a.incidentId))
    .orderBy(desc(incidentEvents.occurredAt))
    .limit(1);
  const prev = last[0]?.metadata as Record<string, unknown> | null | undefined;
  const next = detailMeta(a.detail);
  if (prev && prev.status === next.status && prev.statusCode === next.statusCode && prev.errorMessage === next.errorMessage) {
    return false;
  }
  await tx.insert(incidentEvents).values({
    incidentId: a.incidentId,
    occurredAt: a.occurredAt,
    eventType: 'observed',
    message: describeFailure(a.detail),
    metadata: next,
  });
  return true;
}

export async function resolveIncident(
  tx: Tx,
  a: { incidentId: string; startedAt: Date; resolvedAt: Date; resolutionCheckId: string | null; closeEvent: { type: 'resolved' | 'note'; message: string } },
): Promise<{ durationSeconds: number }> {
  const durationSeconds = Math.max(0, Math.floor((a.resolvedAt.getTime() - a.startedAt.getTime()) / 1000));
  await tx
    .update(incidents)
    .set({ resolvedAt: a.resolvedAt, durationSeconds, resolutionCheckId: a.resolutionCheckId, updatedAt: a.resolvedAt })
    .where(eq(incidents.id, a.incidentId));
  await tx.insert(incidentEvents).values({
    incidentId: a.incidentId,
    occurredAt: a.resolvedAt,
    eventType: a.closeEvent.type,
    message: a.closeEvent.message,
    metadata: null,
  });
  return { durationSeconds };
}

export type IncidentListRow = {
  id: string;
  serviceId: string;
  serviceName: string;
  severity: 'down';
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
};

export async function listIncidents(userId: string, opts: { serviceId?: string; open?: boolean }): Promise<IncidentListRow[]> {
  const conds = [eq(services.userId, userId)];
  if (opts.serviceId) conds.push(eq(incidents.serviceId, opts.serviceId));
  if (opts.open) conds.push(isNull(incidents.resolvedAt));
  const rows = await db
    .select({
      id: incidents.id, serviceId: incidents.serviceId, serviceName: services.name,
      severity: incidents.severity, startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt, durationSeconds: incidents.durationSeconds,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .where(and(...conds))
    .orderBy(desc(incidents.startedAt));
  return rows.map((r) => ({
    id: r.id, serviceId: r.serviceId, serviceName: r.serviceName, severity: 'down',
    startedAt: r.startedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    durationSeconds: r.durationSeconds,
  }));
}

export async function getIncidentWithEvents(userId: string, incidentId: string) {
  const list = await listIncidents(userId, {});
  const incident = list.find((i) => i.id === incidentId);
  if (!incident) return null;
  const events = await db
    .select({ id: incidentEvents.id, occurredAt: incidentEvents.occurredAt, eventType: incidentEvents.eventType, message: incidentEvents.message, metadata: incidentEvents.metadata })
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, incidentId))
    .orderBy(incidentEvents.occurredAt);
  return {
    incident,
    events: events.map((e) => ({ id: e.id, occurredAt: e.occurredAt.toISOString(), eventType: e.eventType, message: e.message, metadata: (e.metadata as Record<string, unknown> | null) })),
  };
}
```

Note: `getIncidentWithEvents` filters ownership by reusing `listIncidents` (which joins on `services.user_id`). This is O(incidents-for-user) but the single-user dataset is tiny; keeping one ownership path avoids a second hand-written join.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace @beacon/server test -- incidents.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/incidents.ts apps/server/src/db/repositories/incidents.test.ts
git commit -m "feat(server): incidents repository — open/resolve/observe + owner-scoped reads"
```

---

## Task 4: WebSocket event contract

**Files:**
- Modify: `packages/shared/src/schemas/ws-event.ts`
- Modify: `packages/shared/src/schemas/ws-event.test.ts`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Produces: `IncidentOpenedSchema`, `IncidentResolvedSchema`; `WsEventSchema` union widened to 3; `WsEvent` type now includes both.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/schemas/ws-event.test.ts`:

```ts
it('parses incident.opened', () => {
  const e = { type: 'incident.opened', incidentId: 'i1', serviceId: 's1', userId: 'u1', severity: 'down', startedAt: '2026-07-05T00:00:00.000Z', occurredAt: '2026-07-05T00:00:00.000Z' };
  expect(WsEventSchema.safeParse(e).success).toBe(true);
});
it('parses incident.resolved', () => {
  const e = { type: 'incident.resolved', incidentId: 'i1', serviceId: 's1', userId: 'u1', durationSeconds: 120, resolvedAt: '2026-07-05T00:02:00.000Z', occurredAt: '2026-07-05T00:02:00.000Z' };
  expect(WsEventSchema.safeParse(e).success).toBe(true);
});
it('rejects incident.resolved with negative duration', () => {
  const e = { type: 'incident.resolved', incidentId: 'i1', serviceId: 's1', userId: 'u1', durationSeconds: -1, resolvedAt: '2026-07-05T00:02:00.000Z', occurredAt: '2026-07-05T00:02:00.000Z' };
  expect(WsEventSchema.safeParse(e).success).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/shared test -- ws-event`
Expected: FAIL — union does not recognize `incident.*`.

- [ ] **Step 3: Implement the schema additions**

In `packages/shared/src/schemas/ws-event.ts`, add before `WsEventSchema` and widen the union:

```ts
export const IncidentOpenedSchema = z.object({
  type: z.literal('incident.opened'),
  incidentId: z.string().min(1),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  severity: z.literal('down'),
  startedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});

export const IncidentResolvedSchema = z.object({
  type: z.literal('incident.resolved'),
  incidentId: z.string().min(1),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  durationSeconds: z.number().int().nonnegative(),
  resolvedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});

export const WsEventSchema = z.discriminatedUnion('type', [
  ServiceStatusChangedSchema,
  IncidentOpenedSchema,
  IncidentResolvedSchema,
]);
```

Confirm `packages/shared/src/index.ts` re-exports from `./schemas/ws-event` with `export *` (it already does for the existing schemas — no change needed if so; if it names exports explicitly, add the two new schema names).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace @beacon/shared test -- ws-event`
Expected: PASS.

- [ ] **Step 5: Update `ARCHITECTURE.md`**

In the Integration/Realtime (WebSocket) section, document the two new server→client events `incident.opened` / `incident.resolved`, noting they route through the existing hub via `serviceId`/`userId` and require no `connections.ts` change.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/ws-event.ts packages/shared/src/schemas/ws-event.test.ts docs/ARCHITECTURE.md
git commit -m "feat(shared): incident.opened/resolved WS events"
```

---

## Task 5: Wire incidents into applyCheckResult + check-worker

**Files:**
- Modify: `apps/server/src/db/repositories/services.ts` (`applyCheckResult`)
- Modify: `apps/server/src/workers/check-worker.ts` (one line)
- Modify: `apps/server/src/db/repositories/services.test.ts`

**Interfaces:**
- Consumes: `decideTransition` (Task 2); `findOpenIncident`, `openIncident`, `resolveIncident`, `recordObservationIfChanged`, `describeFailure`, `IncidentDetail` (Task 3).
- Produces: `applyCheckResult` args change — `newStatus: ServiceStatus` is **replaced by** `rawStatus: 'up' | 'down'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/db/repositories/services.test.ts`. Add these imports at the top of the file (the existing file already imports `createService`/`setPaused` from `./services` and `pool` from `../index`; add `applyCheckResult` to the `./services` import and add the rest):

```ts
import { applyCheckResult } from './services';
import { db } from '../index';
import { services, incidents, incidentEvents } from '../schema';
import { eq } from 'drizzle-orm';

async function apply(svc, raw: 'up' | 'down', statusCode: number | null) {
  const fresh = (await db.select().from(services).where(eq(services.id, svc.id)))[0]!;
  await applyCheckResult({
    service: fresh,
    check: { status: raw === 'up' ? 'success' : 'failure', statusCode, responseTimeMs: 5, errorMessage: null },
    rawStatus: raw,
  });
  return (await db.select().from(services).where(eq(services.id, svc.id)))[0]!;
}

it('fail/fail opens one incident and flips status to down', async () => {
  const userId = await makeUser('seq');
  const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  let s = await apply(svc, 'up', 200);      // pending -> up
  s = await apply(s, 'down', 500);          // strike 1, still up
  expect(s.currentStatus).toBe('up');
  s = await apply(s, 'down', 500);          // strike 2 -> down + open
  expect(s.currentStatus).toBe('down');
  const open = await db.select().from(incidents).where(eq(incidents.serviceId, svc.id));
  expect(open).toHaveLength(1);
  expect(open[0]!.resolvedAt).toBeNull();
});

it('records observed only when the failure code changes', async () => {
  const userId = await makeUser('obs');
  const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  let s = await apply(svc, 'down', 500);
  s = await apply(s, 'down', 500);          // opens
  s = await apply(s, 'down', 500);          // same code -> no observed
  s = await apply(s, 'down', 503);          // changed -> observed
  const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
  const evs = await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id));
  const observed = evs.filter((e) => e.eventType === 'observed');
  expect(observed).toHaveLength(1);
});

it('ok/ok after down resolves the incident with a duration', async () => {
  const userId = await makeUser('rec');
  const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  let s = await apply(svc, 'down', 500);
  s = await apply(s, 'down', 500);          // open
  s = await apply(s, 'up', 200);            // recovery strike 1
  expect(s.currentStatus).toBe('down');
  s = await apply(s, 'up', 200);            // strike 2 -> resolve + up
  expect(s.currentStatus).toBe('up');
  const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
  expect(inc.resolvedAt).not.toBeNull();
  expect(inc.durationSeconds).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- services.test`
Expected: FAIL — `applyCheckResult` still expects `newStatus`; incidents not created.

- [ ] **Step 3: Rewrite `applyCheckResult`**

Replace the current `applyCheckResult` in `services.ts`. Add imports at top:

```ts
import { decideTransition } from '../../workers/transition';
import { findOpenIncident, openIncident, recordObservationIfChanged, resolveIncident, type IncidentDetail } from './incidents';
```

New body:

```ts
export async function applyCheckResult(args: {
  service: Service;
  check: { status: CheckStatus; statusCode: number | null; responseTimeMs: number | null; errorMessage: string | null };
  rawStatus: 'up' | 'down';
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.service.checkIntervalSeconds * 1000);

  const consecutiveFailures = args.rawStatus === 'down' ? args.service.consecutiveFailures + 1 : 0;
  const consecutiveSuccesses = args.rawStatus === 'up' ? args.service.consecutiveSuccesses + 1 : 0;

  const decision = decideTransition({
    currentStatus: args.service.currentStatus,
    consecutiveFailures,
    consecutiveSuccesses,
    rawStatus: args.rawStatus,
  });
  const statusChanged = decision.nextStatus !== args.service.currentStatus;
  const detail: IncidentDetail = {
    status: args.check.status,
    statusCode: args.check.statusCode,
    errorMessage: args.check.errorMessage,
  };

  const notifies: string[] = [];

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(serviceChecks)
      .values({
        serviceId: args.service.id,
        status: args.check.status,
        statusCode: args.check.statusCode,
        responseTimeMs: args.check.responseTimeMs,
        errorMessage: args.check.errorMessage,
        checkedAt: now,
      })
      .returning({ id: serviceChecks.id });
    const checkId = inserted[0]!.id;

    await tx
      .update(services)
      .set({
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
        consecutiveFailures,
        consecutiveSuccesses,
        ...(statusChanged ? { currentStatus: decision.nextStatus, currentStatusSince: now } : {}),
      })
      .where(eq(services.id, args.service.id));

    if (statusChanged) {
      notifies.push(JSON.stringify({
        type: 'service.status_changed',
        serviceId: args.service.id,
        userId: args.service.userId,
        status: decision.nextStatus,
        previousStatus: args.service.currentStatus,
        occurredAt: now.toISOString(),
      }));
    }

    if (decision.incidentAction === 'open') {
      const inc = await openIncident(tx, { serviceId: args.service.id, startedAt: now, triggerCheckId: checkId, detail });
      notifies.push(JSON.stringify({
        type: 'incident.opened', incidentId: inc.id, serviceId: args.service.id, userId: args.service.userId,
        severity: 'down', startedAt: now.toISOString(), occurredAt: now.toISOString(),
      }));
    } else if (decision.incidentAction === 'resolve') {
      const open = await findOpenIncident(tx, args.service.id);
      if (open) {
        const { durationSeconds } = await resolveIncident(tx, {
          incidentId: open.id, startedAt: open.startedAt, resolvedAt: now, resolutionCheckId: checkId,
          closeEvent: { type: 'resolved', message: 'Service recovered' },
        });
        notifies.push(JSON.stringify({
          type: 'incident.resolved', incidentId: open.id, serviceId: args.service.id, userId: args.service.userId,
          durationSeconds, resolvedAt: now.toISOString(), occurredAt: now.toISOString(),
        }));
      }
    } else if (args.rawStatus === 'down') {
      const open = await findOpenIncident(tx, args.service.id);
      if (open) await recordObservationIfChanged(tx, { incidentId: open.id, detail, occurredAt: now });
    }

    for (const payload of notifies) {
      await tx.execute(sql`select pg_notify('beacon_events', ${payload})`);
    }
  });
}
```

Note: message construction (`describeFailure`) lives inside the incidents repository — `applyCheckResult` only passes the raw `detail`, so it does not import `describeFailure`.

- [ ] **Step 4: Update the caller in `check-worker.ts`**

In `checkOne` (`check-worker.ts`), change the `apply({...})` call: replace `newStatus: r.serviceStatus` with `rawStatus: r.serviceStatus`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run --workspace @beacon/server test -- services.test check-worker`
Expected: PASS. (Existing status-change test still passes: a single `down` from `pending`/`up` no longer flips status — if an existing test asserted immediate flip on one check, update it to apply twice, matching the debounce.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/workers/check-worker.ts apps/server/src/db/repositories/services.test.ts
git commit -m "feat(server): debounced incident open/resolve/observe in applyCheckResult"
```

---

## Task 6: Pause auto-resolves an open incident

**Files:**
- Modify: `apps/server/src/db/repositories/services.ts` (`setPaused`)
- Modify: `apps/server/src/db/repositories/services.test.ts`

**Interfaces:**
- Consumes: `findOpenIncident`, `resolveIncident` (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `services.test.ts`:

```ts
it('pausing a service with an open incident auto-resolves it with a note', async () => {
  const userId = await makeUser('pause');
  const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  let s = await apply(svc, 'down', 500);
  s = await apply(s, 'down', 500);          // opens
  await setPaused(userId, svc.id, true);
  const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
  expect(inc.resolvedAt).not.toBeNull();
  const evs = await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id));
  expect(evs.some((e) => e.eventType === 'note' && /paused/i.test(e.message))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- services.test`
Expected: FAIL — incident stays open after pause.

- [ ] **Step 3: Rewrite `setPaused` to run in a transaction**

Replace `setPaused` in `services.ts`:

```ts
export async function setPaused(userId: string, id: string, paused: boolean): Promise<Service | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(services)
      .set({
        paused,
        currentStatus: paused ? 'paused' : 'pending',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(services.id, id), eq(services.userId, userId)))
      .returning();
    const svc = rows[0];
    if (!svc) return null;

    if (paused) {
      const open = await findOpenIncident(tx, id);
      if (open) {
        const now = new Date();
        const { durationSeconds } = await resolveIncident(tx, {
          incidentId: open.id, startedAt: open.startedAt, resolvedAt: now, resolutionCheckId: null,
          closeEvent: { type: 'note', message: 'Resolved: monitoring paused' },
        });
        await tx.execute(sql`select pg_notify('beacon_events', ${JSON.stringify({
          type: 'incident.resolved', incidentId: open.id, serviceId: id, userId: svc.userId,
          durationSeconds, resolvedAt: now.toISOString(), occurredAt: now.toISOString(),
        })})`);
      }
    }
    return svc;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace @beacon/server test -- services.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/services.test.ts
git commit -m "feat(server): pause auto-resolves an open incident"
```

---

## Task 7: HTTP endpoints for incidents

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.incidents.test.ts`

**Interfaces:**
- Consumes: `listIncidents`, `getIncidentWithEvents` (Task 3).
- Produces: `GET /internal/incidents?serviceId=&open=`, `GET /internal/incidents/:id`.

- [ ] **Step 1: Write the failing test**

Model on `router.services.test.ts` (open it to copy the app bootstrap + header helper). `apps/server/src/router.incidents.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool, db } from './db/index';
import { incidents, serviceChecks, services } from './db/schema';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, clerkId: string) {
  return app.request(path, { headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, 'x-clerk-user-id': clerkId } });
}

describe('incidents routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without secret', async () => {
    const res = await app.request('/internal/incidents');
    expect(res.status).toBe(401);
  });

  it('lists incidents for the owner and filters by service', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'r_owner', email: 'o@e.com' });
    const [svc] = await db.insert(services).values({ userId: u.id, name: 'S', baseUrl: 'https://s.com', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
    const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
    await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id });
    const res = await req('/internal/incidents', 'r_owner');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0].serviceName).toBe('S');
  });

  it('404 for a non-owned incident detail', async () => {
    const owner = await upsertFromClerk({ clerkUserId: 'r_o2', email: 'o2@e.com' });
    await upsertFromClerk({ clerkUserId: 'r_intruder', email: 'i@e.com' });
    const [svc] = await db.insert(services).values({ userId: owner.id, name: 'S', baseUrl: 'https://s.com', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
    const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
    const [inc] = await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id }).returning();
    const res = await req(`/internal/incidents/${inc!.id}`, 'r_intruder');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- router.incidents`
Expected: FAIL — routes 404 / return nothing.

- [ ] **Step 3: Add the routes**

In `router.ts`, add an auth guard + routes. After the existing `/internal/services` `app.use` guards, add:

```ts
  app.use('/internal/incidents', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  app.use('/internal/incidents/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
```

Add the import at the top: `import { listIncidents, getIncidentWithEvents } from './db/repositories/incidents';`

Add the handlers (near the other routes, before `return app;`):

```ts
  app.get('/internal/incidents', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const serviceId = c.req.query('serviceId') || undefined;
    const open = c.req.query('open') === 'true';
    return c.json({ incidents: await listIncidents(userId, { serviceId, open }) });
  });

  app.get('/internal/incidents/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const detail = await getIncidentWithEvents(userId, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace @beacon/server test -- router.incidents`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint, then commit**

```bash
git add apps/server/src/router.ts apps/server/src/router.incidents.test.ts
git commit -m "feat(server): GET /internal/incidents list + detail endpoints"
```

---

## Task 8: Web API client for incidents

**Files:**
- Create: `apps/web/lib/incidents-api.ts`

**Interfaces:**
- Produces: `IncidentDto`, `IncidentEventDto`, `IncidentDetailDto`; `fetchIncidents(clerkUserId, opts?)`, `fetchIncident(clerkUserId, id)`.

- [ ] **Step 1: Implement the client (mirrors `services-api.ts`)**

```ts
import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type IncidentDto = {
  id: string;
  serviceId: string;
  serviceName: string;
  severity: 'down';
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
};

export type IncidentEventDto = {
  id: string;
  occurredAt: string;
  eventType: 'opened' | 'observed' | 'resolved' | 'note';
  message: string;
  metadata: Record<string, unknown> | null;
};

export type IncidentDetailDto = { incident: IncidentDto; events: IncidentEventDto[] };

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchIncidents(clerkUserId: string, opts: { serviceId?: string; open?: boolean } = {}): Promise<IncidentDto[]> {
  const qs = new URLSearchParams();
  if (opts.serviceId) qs.set('serviceId', opts.serviceId);
  if (opts.open) qs.set('open', 'true');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${serverApiBaseUrl()}/internal/incidents${suffix}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchIncidents failed: ${res.status}`);
  return (await res.json()).incidents as IncidentDto[];
}

export async function fetchIncident(clerkUserId: string, id: string): Promise<IncidentDetailDto | null> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/incidents/${id}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchIncident failed: ${res.status}`);
  return (await res.json()) as IncidentDetailDto;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/incidents-api.ts
git commit -m "feat(web): incidents API client"
```

---

## Task 9: `/incidents` list page + live updates + nav

**Files:**
- Create: `apps/web/lib/incident-style.ts`
- Create: `apps/web/components/incidents/incidents-live-list.tsx`
- Create: `apps/web/app/(app)/incidents/page.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `fetchIncidents`, `IncidentDto` (Task 8); `useServiceStatusSubscription` (`lib/use-ws`); `relativeTime` (`lib/relative-time`); `WsEvent` (`@beacon/shared`).

- [ ] **Step 1: Read the Next 16 docs**

Read the App Router page/layout guides under `apps/web/node_modules/next/dist/docs/` before writing pages (per `apps/web/AGENTS.md`).

- [ ] **Step 2: Create `incident-style.ts`**

```ts
// Incident severity → status tokens (globals.css @theme). Ongoing incidents pulse.
export const SEVERITY_STYLE: Record<string, { text: string; dot: string }> = {
  down: { text: 'text-status-down', dot: 'bg-status-down' },
};

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
```

- [ ] **Step 3: Create the live list client component**

`apps/web/components/incidents/incidents-live-list.tsx`:

```tsx
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

import type { WsEvent } from '@beacon/shared';

import type { IncidentDto } from '@/lib/incidents-api';
import { relativeTime } from '@/lib/relative-time';
import { SEVERITY_STYLE, formatDuration } from '@/lib/incident-style';
import { useServiceStatusSubscription } from '@/lib/use-ws';

export function IncidentsLiveList({ initial }: { initial: IncidentDto[] }) {
  const [incidents, setIncidents] = useState(initial);

  // Adopt server-driven changes on revalidation (same pattern as ServicesLiveList).
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setIncidents(initial);
  }

  const onEvent = useCallback((e: WsEvent) => {
    if (e.type === 'incident.opened') {
      setIncidents((prev) =>
        prev.some((i) => i.id === e.incidentId)
          ? prev
          : [{ id: e.incidentId, serviceId: e.serviceId, serviceName: '…', severity: 'down', startedAt: e.startedAt, resolvedAt: null, durationSeconds: null }, ...prev],
      );
    } else if (e.type === 'incident.resolved') {
      setIncidents((prev) => prev.map((i) => (i.id === e.incidentId ? { ...i, resolvedAt: e.resolvedAt, durationSeconds: e.durationSeconds } : i)));
    }
  }, []);

  useServiceStatusSubscription('global', onEvent);

  if (incidents.length === 0) {
    return <p className="px-5 py-6 text-[12px] text-zinc-400">No incidents recorded. When a service fails two checks in a row, it appears here.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200/40">
      {incidents.map((i) => {
        const style = SEVERITY_STYLE[i.severity] ?? { text: 'text-status-down', dot: 'bg-status-down' };
        const ongoing = i.resolvedAt == null;
        return (
          <li key={i.id} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-zinc-50/70">
            <div className="flex w-24 items-center gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot} ${ongoing ? 'animate-pulse' : ''}`} aria-hidden="true" />
              <span className={`text-[12px] font-medium ${ongoing ? style.text : 'text-zinc-400'}`}>{ongoing ? 'ongoing' : 'resolved'}</span>
            </div>
            <div className="min-w-0 flex-1">
              <Link href={`/incidents/${i.id}`} className="block truncate text-[13px] font-medium text-zinc-900 hover:underline">
                {i.serviceName}
              </Link>
            </div>
            <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-500">{formatDuration(i.durationSeconds)}</span>
            <span className="w-28 text-right font-mono text-[11px] tabular-nums text-zinc-400" suppressHydrationWarning>{relativeTime(i.startedAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Create the list page (Server Component)**

`apps/web/app/(app)/incidents/page.tsx`:

```tsx
import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchIncidents } from '@/lib/incidents-api';
import { IncidentsLiveList } from '@/components/incidents/incidents-live-list';

export default async function IncidentsPage() {
  const user = await currentUser();
  if (!user) notFound();
  const incidents = await fetchIncidents(user.id);

  return (
    <main className="flex flex-1 flex-col">
      <div className="border-b border-zinc-200/60 px-5 py-3.5">
        <h1 className="text-sm font-semibold text-zinc-900">Incidents</h1>
        <p className="mt-0.5 text-[12px] text-zinc-500">Downtime recorded across your services.</p>
      </div>
      <IncidentsLiveList initial={incidents} />
    </main>
  );
}
```

- [ ] **Step 5: Add nav links to the app header**

In `apps/web/app/(app)/layout.tsx`, add a nav cluster next to the wordmark linking `/services` and `/incidents` (match the mono-eyebrow style already used for the wordmark; use `next/link`). Keep it minimal — text links, active state optional.

- [ ] **Step 6: Design pass (frontend-design skill)**

Invoke the frontend-design skill and refine the list + nav against the Linear/Vercel bar: density, weight contrast, whitespace grouping, a header row for the columns, and a skeleton loading state. Verify against the DESIGN.md tokens.

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Manually load `/incidents`.

```bash
git add apps/web/lib/incident-style.ts apps/web/components/incidents apps/web/app/(app)/incidents/page.tsx apps/web/app/(app)/layout.tsx
git commit -m "feat(web): /incidents list with live open/resolve + nav"
```

---

## Task 10: `/incidents/[id]` timeline page + live duration/resolve

**Files:**
- Create: `apps/web/app/(app)/incidents/[id]/page.tsx`
- Create: `apps/web/components/incidents/incident-timeline-live.tsx`

**Interfaces:**
- Consumes: `fetchIncident`, `IncidentDetailDto` (Task 8); `useServiceStatusSubscription`; `WsEvent`.

- [ ] **Step 1: Create the live client (duration tick + resolve)**

`apps/web/components/incidents/incident-timeline-live.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { WsEvent } from '@beacon/shared';

import { formatDuration } from '@/lib/incident-style';
import { useServiceStatusSubscription } from '@/lib/use-ws';

export function IncidentLiveHeader({
  incidentId, serviceId, startedAt, resolvedAt: initialResolvedAt, durationSeconds: initialDuration,
}: {
  incidentId: string; serviceId: string; startedAt: string; resolvedAt: string | null; durationSeconds: number | null;
}) {
  const router = useRouter();
  const [resolvedAt, setResolvedAt] = useState(initialResolvedAt);
  const [duration, setDuration] = useState(initialDuration);
  const [liveSeconds, setLiveSeconds] = useState(() => Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));

  // Tick the live duration while ongoing.
  useEffect(() => {
    if (resolvedAt) return;
    const t = setInterval(() => setLiveSeconds(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)), 1000);
    return () => clearInterval(t);
  }, [resolvedAt, startedAt]);

  const onEvent = useCallback((e: WsEvent) => {
    if (e.type === 'incident.resolved' && e.incidentId === incidentId) {
      setResolvedAt(e.resolvedAt);
      setDuration(e.durationSeconds);
      router.refresh(); // pull any interim observed events into the timeline
    }
  }, [incidentId, router]);

  useServiceStatusSubscription(`service:${serviceId}`, onEvent);

  const ongoing = resolvedAt == null;
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-1.5 w-1.5 rounded-full bg-status-down ${ongoing ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span className={`text-[13px] font-semibold ${ongoing ? 'text-status-down' : 'text-zinc-500'}`}>
        {ongoing ? `ongoing · ${formatDuration(liveSeconds)}` : `resolved · ${formatDuration(duration)}`}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Create the detail page (Server Component)**

`apps/web/app/(app)/incidents/[id]/page.tsx`:

```tsx
import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchIncident } from '@/lib/incidents-api';
import { relativeTime } from '@/lib/relative-time';
import { IncidentLiveHeader } from '@/components/incidents/incident-timeline-live';

const EVENT_DOT: Record<string, string> = {
  opened: 'bg-status-down', observed: 'bg-status-degraded', resolved: 'bg-status-up', note: 'bg-zinc-300',
};

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const detail = await fetchIncident(user.id, id);
  if (!detail) notFound();
  const { incident, events } = detail;

  return (
    <main className="flex flex-1 flex-col">
      <div className="px-5 pt-4">
        <Link href="/incidents" className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400 transition-colors hover:text-zinc-600">← incidents</Link>
      </div>
      <div className="flex items-start justify-between gap-6 border-b border-zinc-200/60 px-5 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-zinc-900">{incident.serviceName}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-400">Started {relativeTime(incident.startedAt)}</p>
        </div>
        <div className="shrink-0 pt-0.5">
          <IncidentLiveHeader incidentId={incident.id} serviceId={incident.serviceId} startedAt={incident.startedAt} resolvedAt={incident.resolvedAt} durationSeconds={incident.durationSeconds} />
        </div>
      </div>

      <section className="flex flex-1 flex-col px-5 py-4">
        <h2 className="mb-3 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Timeline</h2>
        <ol className="relative ml-1 border-l border-zinc-200/70">
          {events.map((ev) => (
            <li key={ev.id} className="mb-4 ml-4">
              <span className={`absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full ${EVENT_DOT[ev.eventType] ?? 'bg-zinc-300'}`} aria-hidden="true" />
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[12px] text-zinc-700"><span className="font-medium capitalize">{ev.eventType}</span> — {ev.message}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400" suppressHydrationWarning>{relativeTime(ev.occurredAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Design pass (frontend-design skill)**

Invoke frontend-design and refine the timeline — this is the "wow" screen (PRD). Focus: vertical rhythm, the connecting rule, dot semantics (open=red, observed=amber, resolved=green), typographic weight contrast, and how the ongoing/resolved header reads. Check against DESIGN.md; document decisions there.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Manually open an incident detail page.

```bash
git add apps/web/app/(app)/incidents/[id]/page.tsx apps/web/components/incidents/incident-timeline-live.tsx docs/DESIGN.md
git commit -m "feat(web): incident timeline detail with live duration/resolve"
```

---

## Task 11: Service-detail incidents section + active-incident badge

**Files:**
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx`

**Interfaces:**
- Consumes: `fetchIncidents` (Task 8); `formatDuration` (`lib/incident-style`).

- [ ] **Step 1: Fetch incidents for the service**

In `ServiceDetailPage`, after the existing fetches, add:

```tsx
  const incidents = await fetchIncidents(user.id, { serviceId });
  const activeIncident = incidents.find((i) => i.resolvedAt == null) ?? null;
```

Add imports: `import { fetchIncidents } from '@/lib/incidents-api';` and `import { formatDuration } from '@/lib/incident-style';`.

- [ ] **Step 2: Add an "Incidents" section**

Insert a new `<section>` between the Integrations section and Recent checks (match the section header pattern already in the file — mono eyebrow + count):

```tsx
      <section className="border-b border-zinc-200/40">
        <div className="flex items-baseline gap-2.5 px-5 pt-4 pb-2">
          <h2 className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Incidents</h2>
          {incidents.length > 0 && <span className="font-mono text-[10px] tabular-nums text-zinc-300">{incidents.length}</span>}
        </div>
        {incidents.length === 0 ? (
          <p className="px-5 pb-4 text-[12px] text-zinc-400">No incidents for this service.</p>
        ) : (
          <ul className="divide-y divide-zinc-200/40">
            {incidents.slice(0, 5).map((i) => (
              <li key={i.id} className="px-5 py-2.5">
                <Link href={`/incidents/${i.id}`} className="flex items-center justify-between gap-4 hover:underline">
                  <span className={`text-[12px] font-medium ${i.resolvedAt == null ? 'text-status-down' : 'text-zinc-600'}`}>
                    {i.resolvedAt == null ? 'ongoing' : 'resolved'}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-zinc-400">{formatDuration(i.durationSeconds)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
```

- [ ] **Step 3: Add an active-incident badge in the header block**

In the header block (next to `ServiceStatusLive`), when `activeIncident` is set, render a small link badge:

```tsx
          {activeIncident && (
            <Link href={`/incidents/${activeIncident.id}`} className="mt-1 inline-block font-mono text-[10px] uppercase tracking-[0.1em] text-status-down hover:underline">
              active incident →
            </Link>
          )}
```

- [ ] **Step 4: Design pass + verify**

Quick frontend-design check that the new section sits well with the existing page rhythm. Then:

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/(app)/services/[serviceId]/page.tsx
git commit -m "feat(web): service-detail incidents section + active-incident badge"
```

---

## Task 12: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + lint + tests**

Run: `npm run typecheck && npm run lint && npm run --workspace @beacon/server test`
Expected: all PASS.

- [ ] **Step 2: Manual happy-path (use the `verify` / `run` skill to drive the app)**

With server + web + Postgres running: add a service pointing at a URL you can break (or a local endpoint you can toggle). Force **two consecutive failures**; confirm the dashboard status flips to `down`, an incident appears on `/incidents` **live**, and the detail timeline shows `opened`. Change the failure mode (e.g. different status code) and confirm an `observed` entry appears. Recover the endpoint; after **two successes**, confirm the incident resolves live with a duration and a `resolved` entry.

- [ ] **Step 3: Manual failure/edge checks**

- One-off single failure → no incident, status stays `up`.
- Pause a service mid-incident → incident auto-resolves with the "monitoring paused" note.

- [ ] **Step 4: Capture screenshots** of the dashboard-with-incident and the timeline for the README/DESIGN.md.

- [ ] **Step 5: Confirm docs updated** — `DATA_MODEL.md` (Task 1) and `ARCHITECTURE.md` (Task 4) reflect the schema + WS additions.

- [ ] **Step 6: Finish the branch** — invoke `superpowers:finishing-a-development-branch` to open the PR for review/merge into `main`.

---

## Self-review notes

- **Spec coverage:** schema (T1), debounce logic (T2), incident repo + observed-on-change + one-open invariant + pause resolve (T3, T6), WS contract (T4), applyCheckResult wiring incl. rawStatus interface change (T5), endpoints (T7), web client (T8), list+live+nav (T9), timeline+live (T10), service-detail history + badge (T11), verification incl. first real incident (T12). Degraded/alerts/domains explicitly out of scope per spec.
- **Interface consistency:** `rawStatus` replaces `newStatus` (T5) and the caller updates in the same task (T5 Step 4); `describeFailure`/`IncidentDetail`/`Tx` defined in T3 and consumed in T5/T6; WS event field names in T4 match the `pg_notify` payloads emitted in T5/T6 and the client handlers in T9/T10.
