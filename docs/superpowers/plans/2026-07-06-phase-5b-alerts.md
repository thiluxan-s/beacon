# Phase 5b — Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email me when an incident opens and when it recovers on its own, durably and de-duplicated, with a settings page to toggle alerts (global + per-service) and set the destination address.

**Architecture:** A polling reconciler worker scans incident/table state for alerts due, sends via Resend's REST API over `fetch`, and records into an `alerts_sent` ledger; dedup reuses 5a's `notification_sent` flag and `resolution_check_id` (recovery-vs-pause) discriminators. Global settings live in a new `notification_settings` table surfaced by a `/settings` page.

**Tech Stack:** Node + Hono, Drizzle (Postgres), Resend (via `fetch`, no SDK), Next.js 16 (App Router), Zod, Vitest.

## Global Constraints

- TypeScript `strict`, **no `any`** — `unknown` + narrow. (CLAUDE.md)
- Zod is source of truth; DB types via Drizzle `$inferSelect`/`$inferInsert`. (CLAUDE.md)
- **All DB access through `db/repositories/`** — no raw Drizzle in routes/workers/components. (CLAUDE.md)
- Dates `timestamptz`, UTC; never store dates as strings. (CLAUDE.md)
- Background workers must never crash the loop on one failure — catch, log, continue. (CLAUDE.md)
- Default to Server Components; `"use client"` only for state/effects. (CLAUDE.md)
- **No new npm dependencies** — Resend is called via `fetch`, not its SDK. (spec)
- `alerts_sent.channel` enum is `['email']` only; `kind` is `['opened','resolved']`; `status` is `['sent','failed']`. (spec)
- `RESEND_API_KEY` and `ALERT_FROM_EMAIL` are **both optional**; `alertsConfigured()` = both present. Unset → worker idles, `sendEmail` no-ops, nothing crashes. (spec)
- Resolve email fires only when `notification_sent = true` AND `resolution_check_id IS NOT NULL` (self-recovery); pause-resolves stay silent. Open email requires global `alerts_enabled` AND `services.alerts_enabled`. (spec)
- **Next 16 is not training-data Next** — read `apps/web/node_modules/next/dist/docs/` before web code. (apps/web/AGENTS.md)
- Conventional commits. **Per-task commits on the `phase-5b-alerts` branch are authorized** (the human's approval gate is at PR/merge-to-main). Branch already created.
- "Done" per task: `npm run typecheck` + `npm run lint` clean.

---

## File map

**Server**
- `apps/server/src/db/schema.ts` — Modify: alert enums, `alerts_sent` + `notification_settings` tables.
- `apps/server/src/lib/env.ts` — Modify: two optional env vars.
- `apps/server/.env.example` — Modify: document them.
- `apps/server/src/lib/email.ts` (+ `.test.ts`) — Create: `alertsConfigured`, `sendEmail`, `openEmail`/`resolveEmail` builders, `formatDowntime`, `AlertTarget`.
- `apps/server/src/db/repositories/notification-settings.ts` (+ `.test.ts`) — Create: `getResolvedSettings`, `upsertSettings`.
- `apps/server/src/db/repositories/alerts.ts` (+ `.test.ts`) — Create: find-needing queries + record/mark.
- `apps/server/src/router.ts` (+ `router.notification-settings.test.ts`) — Modify: settings endpoints + guards.
- `apps/server/src/workers/alert-worker.ts` (+ `.test.ts`) — Create: reconciler loop.
- `apps/server/src/workers/index.ts` — Modify: register the 3rd loop.

**Shared**
- `packages/shared/src/schemas/notification-settings.ts` (+ `.test.ts`) — Create: `NotificationSettingsUpdateSchema`.
- `packages/shared/src/index.ts` — Modify: export it.

**Web**
- `apps/web/lib/notification-settings-api.ts` — Create.
- `apps/web/app/(app)/settings/actions.ts` — Create.
- `apps/web/app/(app)/settings/page.tsx` — Create.
- `apps/web/components/settings/alerts-settings-form.tsx` — Create (client).
- `apps/web/components/settings/service-alert-toggle.tsx` — Create (client).
- `apps/web/app/(app)/layout.tsx` — Modify: SETTINGS nav link.

**Docs**
- `docs/DATA_MODEL.md` — Modify (Task 1).
- `docs/INFRASTRUCTURE.md` — Modify (Task 9).

---

## Task 1: Schema — alerts_sent + notification_settings + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `docs/DATA_MODEL.md`
- Create (generated): `apps/server/drizzle/<n>_*.sql`

**Interfaces:**
- Produces: `alertsSent`, `notificationSettings` tables; `alertChannel`/`alertKind`/`alertStatus` enums; types `AlertSent`, `NewAlertSent`, `NotificationSetting`, `NewNotificationSetting`.

- [ ] **Step 1: Add enums + tables to `schema.ts`**

`sql` is already imported (added in 5a). Add after the incident enums:

```ts
export const alertChannel = pgEnum('alert_channel', ['email']);
export const alertKind = pgEnum('alert_kind', ['opened', 'resolved']);
export const alertStatus = pgEnum('alert_status', ['sent', 'failed']);
```

Add after the `incidentEvents` table:

```ts
export const alertsSent = pgTable(
  'alerts_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    channel: alertChannel('channel').notNull(),
    kind: alertKind('kind').notNull(),
    status: alertStatus('status').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('alerts_sent_incident_idx').on(t.incidentId),
    uniqueIndex('alerts_sent_one_per_kind_idx').on(t.incidentId, t.channel, t.kind).where(sql`status = 'sent'`),
  ],
);

export const notificationSettings = pgTable('notification_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  alertsEnabled: boolean('alerts_enabled').notNull().default(true),
  alertEmail: text('alert_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AlertSent = typeof alertsSent.$inferSelect;
export type NewAlertSent = typeof alertsSent.$inferInsert;
export type NotificationSetting = typeof notificationSettings.$inferSelect;
export type NewNotificationSetting = typeof notificationSettings.$inferInsert;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `apps/server/drizzle/*.sql` with `CREATE TYPE`s for the three enums, `CREATE TABLE "alerts_sent"` + `"notification_settings"`, and a partial `CREATE UNIQUE INDEX ... WHERE status = 'sent'`.

- [ ] **Step 3: Verify the partial-unique WHERE clause survived**

Open the generated `.sql`. Confirm `alerts_sent_one_per_kind_idx` includes `WHERE status = 'sent'`. If Drizzle dropped the `.where()`, hand-edit the SQL to add it — we rely on it as a dedup backstop.

- [ ] **Step 4: Apply + typecheck**

Run: `npm run db:migrate` (expect clean apply), then `npm run typecheck` (expect PASS).

- [ ] **Step 5: Update `DATA_MODEL.md`**

Add `alerts_sent` (ledger + partial-unique dedup on `(incident_id, channel, kind) WHERE status='sent'`) and `notification_settings` (one row/user, `alerts_enabled` default true, nullable `alert_email` → falls back to `users.email`). Note 5b reuses `incidents.notification_sent` (= "open alert sent") and `resolution_check_id` (recovery-vs-pause).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle docs/DATA_MODEL.md
git commit -m "feat(server): alerts_sent ledger + notification_settings schema"
```

---

## Task 2: Email library + env

**Files:**
- Modify: `apps/server/src/lib/env.ts`
- Modify: `apps/server/.env.example`
- Create: `apps/server/src/lib/email.ts`, `apps/server/src/lib/email.test.ts`

**Interfaces:**
- Consumes: `env` (`./env`).
- Produces:
  ```ts
  export type AlertTarget = { incidentId: string; serviceName: string; failureDetail: string; startedAt: Date; resolvedAt: Date | null; durationSeconds: number | null; toEmail: string };
  export type SendResult = { ok: true } | { ok: false; error: string };
  export function alertsConfigured(): boolean;
  export function formatDowntime(seconds: number): string;
  export function openEmail(t: AlertTarget): { subject: string; text: string };
  export function resolveEmail(t: AlertTarget): { subject: string; text: string };
  export function sendEmail(input: { to: string; subject: string; text: string }, deps?: { fetchFn?: typeof fetch }): Promise<SendResult>;
  ```

- [ ] **Step 1: Add the env vars**

In `env.ts`, inside `EnvSchema` (after `INTEGRATIONS_ENCRYPTION_KEY`):

```ts
  // Email alerts (Phase 5b). Both optional — unset disables alerting entirely
  // (worker idles, sendEmail no-ops), so dev without Resend boots cleanly.
  RESEND_API_KEY: z.string().optional(),
  ALERT_FROM_EMAIL: z.string().email().optional(),
```

In `apps/server/.env.example` add:

```
# Email alerts (optional). Unset → alerting disabled, worker idles cleanly.
# ALERT_FROM_EMAIL's domain must be a verified sending domain in Resend.
RESEND_API_KEY=
ALERT_FROM_EMAIL=alerts@thiluxan.com
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/lib/email.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertsConfigured, formatDowntime, openEmail, resolveEmail, sendEmail, type AlertTarget } from './email';
import { env } from './env';

const target: AlertTarget = {
  incidentId: 'inc-1', serviceName: 'Wayfare', failureDetail: 'HTTP 500',
  startedAt: new Date('2026-07-06T00:00:00.000Z'), resolvedAt: new Date('2026-07-06T00:05:00.000Z'),
  durationSeconds: 305, toEmail: 'me@e.com',
};

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('email builders', () => {
  it('formatDowntime renders s/m/h', () => {
    expect(formatDowntime(45)).toBe('45s');
    expect(formatDowntime(305)).toBe('5m 5s');
    expect(formatDowntime(3720)).toBe('1h 2m');
  });
  it('openEmail includes service, detail, and the incident link', () => {
    const { subject, text } = openEmail(target);
    expect(subject).toContain('Wayfare');
    expect(text).toContain('HTTP 500');
    expect(text).toContain(`${env.WEB_ORIGIN}/incidents/inc-1`);
  });
  it('resolveEmail includes recovery + downtime + link', () => {
    const { subject, text } = resolveEmail(target);
    expect(subject).toContain('Wayfare');
    expect(text).toContain('5m 5s');
    expect(text).toContain(`${env.WEB_ORIGIN}/incidents/inc-1`);
  });
});

describe('sendEmail', () => {
  it('no-ops when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn: (() => { throw new Error('should not call'); }) as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, error: 'alerts disabled: email not configured' });
  });
  it('maps a non-2xx Resend response to failure', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test'); vi.stubEnv('ALERT_FROM_EMAIL', 'from@e.com');
    const fetchFn = vi.fn(async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn });
    expect(res.ok).toBe(false);
  });
  it('returns ok on 2xx', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test'); vi.stubEnv('ALERT_FROM_EMAIL', 'from@e.com');
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn });
    expect(res).toEqual({ ok: true });
  });
});
```

Note: `sendEmail` reads the key via `process.env` (not the frozen `env` object) so `vi.stubEnv` can toggle it per-test — see Step 4's `alertsConfigured`/`sendEmail` reading `process.env.RESEND_API_KEY`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run --workspace @beacon/server test -- email`
Expected: FAIL — module `./email` not found.

- [ ] **Step 4: Implement `email.ts`**

```ts
import { env } from './env';

export type AlertTarget = {
  incidentId: string;
  serviceName: string;
  failureDetail: string;
  startedAt: Date;
  resolvedAt: Date | null;
  durationSeconds: number | null;
  toEmail: string;
};

export type SendResult = { ok: true } | { ok: false; error: string };

// Read live from process.env (not the frozen `env`) so tests can toggle with vi.stubEnv.
function resendKey(): string | undefined { return process.env.RESEND_API_KEY || undefined; }
function fromEmail(): string | undefined { return process.env.ALERT_FROM_EMAIL || undefined; }

export function alertsConfigured(): boolean {
  return Boolean(resendKey() && fromEmail());
}

export function formatDowntime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function incidentLink(incidentId: string): string {
  return `${env.WEB_ORIGIN}/incidents/${incidentId}`;
}

export function openEmail(t: AlertTarget): { subject: string; text: string } {
  return {
    subject: `🔴 ${t.serviceName} is DOWN`,
    text:
      `${t.serviceName} is down.\n\n` +
      `Detail: ${t.failureDetail}\n` +
      `Since: ${t.startedAt.toISOString()}\n\n` +
      `Incident: ${incidentLink(t.incidentId)}\n`,
  };
}

export function resolveEmail(t: AlertTarget): { subject: string; text: string } {
  const downtime = t.durationSeconds != null ? formatDowntime(t.durationSeconds) : 'unknown';
  return {
    subject: `✅ ${t.serviceName} has recovered`,
    text:
      `${t.serviceName} is back up.\n\n` +
      `Downtime: ${downtime}\n\n` +
      `Incident: ${incidentLink(t.incidentId)}\n`,
  };
}

export async function sendEmail(
  input: { to: string; subject: string; text: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<SendResult> {
  if (!alertsConfigured()) return { ok: false, error: 'alerts disabled: email not configured' };
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resendKey()}` },
      body: JSON.stringify({ from: fromEmail(), to: input.to, subject: input.subject, text: input.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[beacon-alert] resend non-2xx', res.status, body);
      return { ok: false, error: `resend ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[beacon-alert] resend request failed', err);
    return { ok: false, error: 'resend request failed' };
  }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run --workspace @beacon/server test -- email` (PASS), then confirm `npm run --workspace @beacon/server test -- env` still passes (optional vars are backward-compatible).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/email.ts apps/server/src/lib/email.test.ts apps/server/src/lib/env.ts apps/server/.env.example
git commit -m "feat(server): Resend email lib (fetch, no SDK) + optional alert env"
```

---

## Task 3: notification-settings repository + shared schema

**Files:**
- Create: `packages/shared/src/schemas/notification-settings.ts`, `packages/shared/src/schemas/notification-settings.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/db/repositories/notification-settings.ts`, `apps/server/src/db/repositories/notification-settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared
  export const NotificationSettingsUpdateSchema: z.ZodObject<...>;
  export type NotificationSettingsUpdate = { alertsEnabled?: boolean; alertEmail?: string | null };
  // server repo
  export function getResolvedSettings(userId: string): Promise<{ alertsEnabled: boolean; alertEmail: string }>;
  export function upsertSettings(userId: string, patch: NotificationSettingsUpdate): Promise<void>;
  ```

- [ ] **Step 1: Write the shared schema test**

`packages/shared/src/schemas/notification-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NotificationSettingsUpdateSchema } from './notification-settings';

describe('NotificationSettingsUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(NotificationSettingsUpdateSchema.safeParse({ alertsEnabled: false }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: 'x@y.com' }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: null }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({}).success).toBe(true);
  });
  it('rejects a bad email', () => {
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: 'nope' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/shared test -- notification-settings`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shared schema + export**

`packages/shared/src/schemas/notification-settings.ts`:

```ts
import { z } from 'zod';

export const NotificationSettingsUpdateSchema = z.object({
  alertsEnabled: z.boolean().optional(),
  alertEmail: z.string().email().nullable().optional(),
});
export type NotificationSettingsUpdate = z.infer<typeof NotificationSettingsUpdateSchema>;
```

In `packages/shared/src/index.ts`, add (matching the existing named-export style):

```ts
export { NotificationSettingsUpdateSchema, type NotificationSettingsUpdate } from './schemas/notification-settings';
```

Run: `npm run --workspace @beacon/shared test -- notification-settings` (PASS).

- [ ] **Step 4: Write the repo test**

`apps/server/src/db/repositories/notification-settings.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { getResolvedSettings, upsertSettings } from './notification-settings';

async function makeUser(clerkId = 'ns_user', email = 'clerk@e.com') {
  return (await upsertFromClerk({ clerkUserId: clerkId, email })).id;
}

describe('notification-settings repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('defaults to enabled + the clerk email when no row exists', async () => {
    const userId = await makeUser('ns1', 'clerk1@e.com');
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: true, alertEmail: 'clerk1@e.com' });
  });

  it('upsert sets and updates fields; null alertEmail falls back', async () => {
    const userId = await makeUser('ns2', 'clerk2@e.com');
    await upsertSettings(userId, { alertsEnabled: false, alertEmail: 'override@e.com' });
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: false, alertEmail: 'override@e.com' });
    await upsertSettings(userId, { alertEmail: null });
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: false, alertEmail: 'clerk2@e.com' });
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- notification-settings`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the repo**

`apps/server/src/db/repositories/notification-settings.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { NotificationSettingsUpdate } from '@beacon/shared';
import { db } from '../index';
import { notificationSettings, users } from '../schema';

export async function getResolvedSettings(userId: string): Promise<{ alertsEnabled: boolean; alertEmail: string }> {
  const rows = await db
    .select({
      alertsEnabled: notificationSettings.alertsEnabled,
      alertEmail: notificationSettings.alertEmail,
      userEmail: users.email,
    })
    .from(users)
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const r = rows[0];
  if (!r) return { alertsEnabled: true, alertEmail: '' };
  return { alertsEnabled: r.alertsEnabled ?? true, alertEmail: r.alertEmail ?? r.userEmail };
}

export async function upsertSettings(userId: string, patch: NotificationSettingsUpdate): Promise<void> {
  await db
    .insert(notificationSettings)
    .values({
      userId,
      alertsEnabled: patch.alertsEnabled ?? true,
      alertEmail: patch.alertEmail ?? null,
    })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        ...(patch.alertsEnabled !== undefined ? { alertsEnabled: patch.alertsEnabled } : {}),
        ...(patch.alertEmail !== undefined ? { alertEmail: patch.alertEmail } : {}),
        updatedAt: new Date(),
      },
    });
}
```

- [ ] **Step 7: Run tests + typecheck, commit**

Run: `npm run --workspace @beacon/server test -- notification-settings` (PASS), `npm run typecheck` (PASS).

```bash
git add packages/shared/src/schemas/notification-settings.ts packages/shared/src/schemas/notification-settings.test.ts packages/shared/src/index.ts apps/server/src/db/repositories/notification-settings.ts apps/server/src/db/repositories/notification-settings.test.ts
git commit -m "feat: notification settings schema + repository"
```

---

## Task 4: alerts repository (the gating queries)

**Files:**
- Create: `apps/server/src/db/repositories/alerts.ts`, `apps/server/src/db/repositories/alerts.test.ts`

**Interfaces:**
- Consumes: `alertsSent`, `incidents`, `incidentEvents`, `services`, `users`, `notificationSettings` (schema); `AlertTarget` (`../../lib/email`).
- Produces:
  ```ts
  export function findIncidentsNeedingOpenAlert(limit: number): Promise<AlertTarget[]>;
  export function findIncidentsNeedingResolveAlert(limit: number): Promise<AlertTarget[]>;
  export function markOpenNotifiedAndRecord(incidentId: string): Promise<void>; // tx: set notification_sent + insert alerts_sent(opened,sent)
  export function recordAlertSent(incidentId: string, kind: 'opened' | 'resolved'): Promise<void>;
  export function recordAlertFailed(incidentId: string, kind: 'opened' | 'resolved'): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/server/src/db/repositories/alerts.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { incidentEvents, incidents, serviceChecks, services } from '../schema';
import { upsertFromClerk } from './users';
import { upsertSettings } from './notification-settings';
import {
  findIncidentsNeedingOpenAlert, findIncidentsNeedingResolveAlert,
  markOpenNotifiedAndRecord, recordAlertSent, recordAlertFailed,
} from './alerts';

async function seed(opts: { alertsEnabled?: boolean; svcAlerts?: boolean } = {}) {
  const u = await upsertFromClerk({ clerkUserId: 'a_user', email: 'me@e.com' });
  if (opts.alertsEnabled === false) await upsertSettings(u.id, { alertsEnabled: false });
  const [svc] = await db.insert(services).values({
    userId: u.id, name: 'Demo', baseUrl: 'https://x.com', healthCheckPath: '/',
    currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date(),
    alertsEnabled: opts.svcAlerts ?? true,
  }).returning();
  const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
  return { userId: u.id, service: svc!, checkId: chk!.id };
}
// Open incident with its 'opened' event, mimicking 5a's openIncident.
async function openInc(serviceId: string, checkId: string) {
  const [inc] = await db.insert(incidents).values({ serviceId, startedAt: new Date(), severity: 'down', triggerCheckId: checkId }).returning();
  await db.insert(incidentEvents).values({ incidentId: inc!.id, occurredAt: new Date(), eventType: 'opened', message: 'HTTP 500', metadata: { status: 'failure', statusCode: 500, errorMessage: null } });
  return inc!;
}

describe('alerts repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('open-needed picks an open, un-alerted incident with alerts on', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    const t = await findIncidentsNeedingOpenAlert(10);
    expect(t).toHaveLength(1);
    expect(t[0]!.incidentId).toBe(inc.id);
    expect(t[0]!.serviceName).toBe('Demo');
    expect(t[0]!.failureDetail).toBe('HTTP 500');
    expect(t[0]!.toEmail).toBe('me@e.com');
  });

  it('open-needed excludes when global alerts off or service alerts off', async () => {
    const off = await seed({ alertsEnabled: false });
    await openInc(off.service.id, off.checkId);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
    const svcOff = await seed({ svcAlerts: false });
    await openInc(svcOff.service.id, svcOff.checkId);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
  });

  it('markOpenNotifiedAndRecord marks the incident and removes it from open-needed', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await markOpenNotifiedAndRecord(inc.id);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
    // second call would violate the partial-unique on (incident,email,opened,sent)
    await expect(markOpenNotifiedAndRecord(inc.id)).rejects.toThrow();
  });

  it('resolve-needed requires open-alerted + self-recovery, excludes pause-resolves', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await markOpenNotifiedAndRecord(inc.id);
    // pause-style resolve: resolution_check_id null
    await db.update(incidents).set({ resolvedAt: new Date(), durationSeconds: 10, resolutionCheckId: null }).where(eq(incidents.id, inc.id));
    expect(await findIncidentsNeedingResolveAlert(10)).toHaveLength(0);
    // real recovery: resolution_check_id set
    await db.update(incidents).set({ resolutionCheckId: checkId }).where(eq(incidents.id, inc.id));
    const t = await findIncidentsNeedingResolveAlert(10);
    expect(t).toHaveLength(1);
    expect(t[0]!.durationSeconds).toBe(10);
    // once resolved-sent recorded, it drops out
    await recordAlertSent(inc.id, 'resolved');
    expect(await findIncidentsNeedingResolveAlert(10)).toHaveLength(0);
  });

  it('recordAlertFailed does not satisfy dedup (still needs the alert)', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await recordAlertFailed(inc.id, 'opened');
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(1); // notification_sent still false
  });
});
```

Add `import { eq } from 'drizzle-orm';` at the top of the test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- alerts.test`
Expected: FAIL — module `./alerts` not found.

- [ ] **Step 3: Implement `alerts.ts`**

```ts
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../index';
import { alertsSent, incidentEvents, incidents, notificationSettings, services, users } from '../schema';
import type { AlertTarget } from '../../lib/email';

type Kind = 'opened' | 'resolved';

export async function findIncidentsNeedingOpenAlert(limit: number): Promise<AlertTarget[]> {
  const rows = await db
    .select({
      incidentId: incidents.id,
      serviceName: services.name,
      startedAt: incidents.startedAt,
      failureDetail: incidentEvents.message,
      userEmail: users.email,
      alertEmail: notificationSettings.alertEmail,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .innerJoin(users, eq(services.userId, users.id))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .innerJoin(
      incidentEvents,
      and(eq(incidentEvents.incidentId, incidents.id), eq(incidentEvents.eventType, 'opened')),
    )
    .where(
      and(
        isNull(incidents.resolvedAt),
        eq(incidents.notificationSent, false),
        eq(services.alertsEnabled, true),
        sql`COALESCE(${notificationSettings.alertsEnabled}, true) = true`,
      ),
    )
    .orderBy(incidents.startedAt)
    .limit(limit);

  return rows.map((r) => ({
    incidentId: r.incidentId,
    serviceName: r.serviceName,
    failureDetail: r.failureDetail,
    startedAt: r.startedAt,
    resolvedAt: null,
    durationSeconds: null,
    toEmail: r.alertEmail ?? r.userEmail,
  }));
}

export async function findIncidentsNeedingResolveAlert(limit: number): Promise<AlertTarget[]> {
  const rows = await db
    .select({
      incidentId: incidents.id,
      serviceName: services.name,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      durationSeconds: incidents.durationSeconds,
      userEmail: users.email,
      alertEmail: notificationSettings.alertEmail,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .innerJoin(users, eq(services.userId, users.id))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(
      and(
        isNotNull(incidents.resolvedAt),
        eq(incidents.notificationSent, true),
        isNotNull(incidents.resolutionCheckId),
        sql`NOT EXISTS (SELECT 1 FROM alerts_sent a WHERE a.incident_id = ${incidents.id} AND a.channel = 'email' AND a.kind = 'resolved' AND a.status = 'sent')`,
      ),
    )
    .orderBy(incidents.resolvedAt)
    .limit(limit);

  return rows.map((r) => ({
    incidentId: r.incidentId,
    serviceName: r.serviceName,
    failureDetail: '',
    startedAt: r.startedAt,
    resolvedAt: r.resolvedAt,
    durationSeconds: r.durationSeconds,
    toEmail: r.alertEmail ?? r.userEmail,
  }));
}

export async function markOpenNotifiedAndRecord(incidentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(incidents).set({ notificationSent: true, updatedAt: new Date() }).where(eq(incidents.id, incidentId));
    await tx.insert(alertsSent).values({ incidentId, channel: 'email', kind: 'opened', status: 'sent' });
  });
}

export async function recordAlertSent(incidentId: string, kind: Kind): Promise<void> {
  await db.insert(alertsSent).values({ incidentId, channel: 'email', kind, status: 'sent' });
}

export async function recordAlertFailed(incidentId: string, kind: Kind): Promise<void> {
  await db.insert(alertsSent).values({ incidentId, channel: 'email', kind, status: 'failed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace @beacon/server test -- alerts.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/alerts.ts apps/server/src/db/repositories/alerts.test.ts
git commit -m "feat(server): alerts repository — open/resolve gating queries + ledger writes"
```

---

## Task 5: Notification-settings HTTP endpoints

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.notification-settings.test.ts`

**Interfaces:**
- Consumes: `getResolvedSettings`, `upsertSettings` (Task 3); `NotificationSettingsUpdateSchema` (shared).
- Produces: `GET /internal/notification-settings`, `PUT /internal/notification-settings`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/router.notification-settings.test.ts` (mirror `router.incidents.test.ts`):

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, init: RequestInit & { clerkId?: string } = {}) {
  const { clerkId, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, ...(clerkId ? { 'x-clerk-user-id': clerkId } : {}), 'content-type': 'application/json' },
  });
}

describe('notification-settings routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without the secret', async () => {
    const res = await app.request('/internal/notification-settings');
    expect(res.status).toBe(401);
  });

  it('GET returns defaults; PUT updates', async () => {
    await upsertFromClerk({ clerkUserId: 'ns_r', email: 'clerk@e.com' });
    const get1 = await req('/internal/notification-settings', { clerkId: 'ns_r' });
    expect(await get1.json()).toEqual({ alertsEnabled: true, alertEmail: 'clerk@e.com' });
    const put = await req('/internal/notification-settings', { method: 'PUT', clerkId: 'ns_r', body: JSON.stringify({ alertsEnabled: false, alertEmail: 'x@y.com' }) });
    expect(put.status).toBe(200);
    const get2 = await req('/internal/notification-settings', { clerkId: 'ns_r' });
    expect(await get2.json()).toEqual({ alertsEnabled: false, alertEmail: 'x@y.com' });
  });

  it('PUT rejects a bad email', async () => {
    await upsertFromClerk({ clerkUserId: 'ns_bad', email: 'clerk@e.com' });
    const put = await req('/internal/notification-settings', { method: 'PUT', clerkId: 'ns_bad', body: JSON.stringify({ alertEmail: 'nope' }) });
    expect(put.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- router.notification-settings`
Expected: FAIL — routes 404 / return nothing.

- [ ] **Step 3: Add guards + routes to `router.ts`**

Imports at top: `import { getResolvedSettings, upsertSettings } from './db/repositories/notification-settings';` and add `NotificationSettingsUpdateSchema` to the `@beacon/shared` import.

After the `/internal/incidents` guards, add:

```ts
  app.use('/internal/notification-settings', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
```

Handlers (before `return app;`):

```ts
  app.get('/internal/notification-settings', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json(await getResolvedSettings(userId));
  });

  app.put('/internal/notification-settings', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = NotificationSettingsUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    await upsertSettings(userId, parsed.data);
    return c.json(await getResolvedSettings(userId));
  });
```

Note: `/internal/notification-settings` has no path segments after it, so the single exact-path `app.use` guard above covers both GET and PUT (no `/*` variant needed).

- [ ] **Step 4: Run tests + typecheck, commit**

Run: `npm run --workspace @beacon/server test -- router.notification-settings` (PASS), `npm run typecheck` (PASS).

```bash
git add apps/server/src/router.ts apps/server/src/router.notification-settings.test.ts
git commit -m "feat(server): GET/PUT /internal/notification-settings"
```

---

## Task 6: Alert reconciler worker

**Files:**
- Create: `apps/server/src/workers/alert-worker.ts`, `apps/server/src/workers/alert-worker.test.ts`
- Modify: `apps/server/src/workers/index.ts`

**Interfaces:**
- Consumes: `alertsConfigured`, `sendEmail`, `openEmail`, `resolveEmail`, `type SendResult` (`../lib/email`); `findIncidentsNeedingOpenAlert`, `findIncidentsNeedingResolveAlert`, `markOpenNotifiedAndRecord`, `recordAlertSent`, `recordAlertFailed` (`../db/repositories/alerts`).
- Produces: `export function processAlertsOnce(send): Promise<void>`, `export function runAlertWorker(deps?): Promise<never>`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/workers/alert-worker.test.ts` — drive one reconcile pass with an injected mock send, against real Postgres:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pool } from '../db/index';
import { alertsSent, incidentEvents, incidents, serviceChecks, services } from '../db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from '../db/repositories/users';
import { processAlertsOnce } from './alert-worker';

async function seedOpen() {
  const u = await upsertFromClerk({ clerkUserId: 'w_user', email: 'me@e.com' });
  const [svc] = await db.insert(services).values({ userId: u.id, name: 'Demo', baseUrl: 'https://x.com', healthCheckPath: '/', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
  const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
  const [inc] = await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id }).returning();
  await db.insert(incidentEvents).values({ incidentId: inc!.id, occurredAt: new Date(), eventType: 'opened', message: 'HTTP 500', metadata: null });
  return { inc: inc!, checkId: chk!.id };
}

describe('alert reconciler (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('sends one open email and marks it; a second pass sends nothing', async () => {
    const { inc } = await seedOpen();
    const send = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(send);
    expect(send).toHaveBeenCalledTimes(1);
    const marked = (await db.select().from(incidents).where(eq(incidents.id, inc.id)))[0]!;
    expect(marked.notificationSent).toBe(true);
    await processAlertsOnce(send);
    expect(send).toHaveBeenCalledTimes(1); // dedup: no second send
  });

  it('a failed send records failed and retries next pass', async () => {
    await seedOpen();
    const send = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
    await processAlertsOnce(send);
    const rows = await db.select().from(alertsSent);
    expect(rows.some((r) => r.status === 'failed' && r.kind === 'opened')).toBe(true);
    // still needs it: a subsequent OK send delivers
    const ok = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('sends a resolve email only for a self-recovered, open-alerted incident', async () => {
    const { inc, checkId } = await seedOpen();
    const send = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(send); // open alert
    await db.update(incidents).set({ resolvedAt: new Date(), durationSeconds: 12, resolutionCheckId: checkId }).where(eq(incidents.id, inc.id));
    await processAlertsOnce(send); // resolve alert
    expect(send).toHaveBeenCalledTimes(2);
    const resolved = await db.select().from(alertsSent).where(eq(alertsSent.kind, 'resolved'));
    expect(resolved).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run --workspace @beacon/server test -- alert-worker`
Expected: FAIL — module `./alert-worker` not found.

- [ ] **Step 3: Implement `alert-worker.ts`**

```ts
import {
  findIncidentsNeedingOpenAlert, findIncidentsNeedingResolveAlert,
  markOpenNotifiedAndRecord, recordAlertFailed, recordAlertSent,
} from '../db/repositories/alerts';
import { alertsConfigured, openEmail, resolveEmail, sendEmail, type SendResult } from '../lib/email';

const POLL_INTERVAL_MS = 12_000;
const BATCH_LIMIT = 50;

type Send = (input: { to: string; subject: string; text: string }) => Promise<SendResult>;

// One reconcile pass. Exported for tests. Never throws per-target: one bad send
// or DB error is logged and the batch continues.
export async function processAlertsOnce(send: Send): Promise<void> {
  for (const t of await findIncidentsNeedingOpenAlert(BATCH_LIMIT)) {
    try {
      const res = await send({ to: t.toEmail, ...openEmail(t) });
      if (res.ok) await markOpenNotifiedAndRecord(t.incidentId);
      else await recordAlertFailed(t.incidentId, 'opened');
    } catch (err) {
      console.error('[beacon-alert] open alert failed', t.incidentId, err);
    }
  }
  for (const t of await findIncidentsNeedingResolveAlert(BATCH_LIMIT)) {
    try {
      const res = await send({ to: t.toEmail, ...resolveEmail(t) });
      if (res.ok) await recordAlertSent(t.incidentId, 'resolved');
      else await recordAlertFailed(t.incidentId, 'resolved');
    } catch (err) {
      console.error('[beacon-alert] resolve alert failed', t.incidentId, err);
    }
  }
}

export async function runAlertWorker(deps: { send?: Send } = {}): Promise<never> {
  const send = deps.send ?? sendEmail;
  let warnedDisabled = false;
  while (true) {
    try {
      if (!alertsConfigured()) {
        if (!warnedDisabled) {
          console.log('[beacon-alert] alerts disabled: email not configured (RESEND_API_KEY / ALERT_FROM_EMAIL)');
          warnedDisabled = true;
        }
      } else {
        warnedDisabled = false;
        await processAlertsOnce(send);
      }
    } catch (err) {
      // A whole-pass failure must never crash the loop.
      console.error('[beacon-alert] reconcile pass failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
```

- [ ] **Step 4: Register the loop in `workers/index.ts`**

Add:

```ts
import { runAlertWorker } from './alert-worker';
```
and after the integration loop:
```ts
console.log('[beacon-worker] starting alert loop');
void runAlertWorker().catch((err) => console.error('[beacon-worker] alert loop crashed', err));
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run --workspace @beacon/server test -- alert-worker` (PASS), `npm run typecheck` (PASS).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workers/alert-worker.ts apps/server/src/workers/alert-worker.test.ts apps/server/src/workers/index.ts
git commit -m "feat(server): alert reconciler worker (open + self-recovery emails, dedup, retry)"
```

---

## Task 7: Web — settings API client + server actions

**Files:**
- Create: `apps/web/lib/notification-settings-api.ts`
- Create: `apps/web/app/(app)/settings/actions.ts`

**Interfaces:**
- Consumes: the endpoints from Task 5; `updateServiceOnServer` (`@/lib/services-api`) for per-service toggles.
- Produces: `fetchNotificationSettings`, `updateNotificationSettings`; server actions `updateAlertSettingsAction`, `toggleServiceAlertsAction`.

- [ ] **Step 1: Implement the API client (mirrors `services-api.ts`)**

`apps/web/lib/notification-settings-api.ts`:

```ts
import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type NotificationSettingsDto = { alertsEnabled: boolean; alertEmail: string };

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchNotificationSettings(clerkUserId: string): Promise<NotificationSettingsDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/notification-settings`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchNotificationSettings failed: ${res.status}`);
  return (await res.json()) as NotificationSettingsDto;
}

export async function updateNotificationSettings(
  clerkUserId: string,
  patch: { alertsEnabled?: boolean; alertEmail?: string | null },
): Promise<NotificationSettingsDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/notification-settings`, {
    method: 'PUT', headers: headers(clerkUserId), body: JSON.stringify(patch), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`updateNotificationSettings failed: ${res.status}`);
  return (await res.json()) as NotificationSettingsDto;
}
```

- [ ] **Step 2: Implement the server actions (mirrors `services/actions.ts`)**

`apps/web/app/(app)/settings/actions.ts`:

```ts
'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { NotificationSettingsUpdateSchema } from '@beacon/shared';

import { updateNotificationSettings } from '@/lib/notification-settings-api';
import { updateServiceOnServer } from '@/lib/services-api';

type Result = { ok: true } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function updateAlertSettingsAction(patch: unknown): Promise<Result> {
  const parsed = NotificationSettingsUpdateSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    await updateNotificationSettings(clerkId, parsed.data);
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] updateAlertSettingsAction failed', err);
    return { ok: false, error: 'Could not save settings.' };
  }
}

export async function toggleServiceAlertsAction(serviceId: string, alertsEnabled: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await updateServiceOnServer(clerkId, serviceId, { alertsEnabled });
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] toggleServiceAlertsAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` (PASS).

```bash
git add apps/web/lib/notification-settings-api.ts "apps/web/app/(app)/settings/actions.ts"
git commit -m "feat(web): notification-settings API client + settings server actions"
```

---

## Task 8: Web — /settings page + toggles + nav

**Files:**
- Create: `apps/web/components/settings/alerts-settings-form.tsx`, `apps/web/components/settings/service-alert-toggle.tsx`
- Create: `apps/web/app/(app)/settings/page.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `fetchNotificationSettings` (Task 7), `fetchServices`/`ServiceDto` (`@/lib/services-api`); `updateAlertSettingsAction`, `toggleServiceAlertsAction` (Task 7).

- [ ] **Step 1: Read the Next 16 docs**

Read the App Router page/layout guides under `apps/web/node_modules/next/dist/docs/` and mirror the existing `app/(app)/services/page.tsx` + `layout.tsx` conventions.

- [ ] **Step 2: Global-alerts form (client)**

`apps/web/components/settings/alerts-settings-form.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { NotificationSettingsDto } from '@/lib/notification-settings-api';
import { updateAlertSettingsAction } from '@/app/(app)/settings/actions';

export function AlertsSettingsForm({ initial }: { initial: NotificationSettingsDto }) {
  const [enabled, setEnabled] = useState(initial.alertsEnabled);
  const [email, setEmail] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(next: { alertsEnabled?: boolean; alertEmail?: string | null }) {
    setError(null);
    start(async () => {
      const res = await updateAlertSettingsAction(next);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => { setEnabled(e.target.checked); save({ alertsEnabled: e.target.checked }); }}
          className="h-3.5 w-3.5 accent-status-up"
        />
        <span className="text-[13px] font-medium text-zinc-800">Email me when a service goes down</span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Destination email</span>
        <div className="flex items-center gap-2">
          <Input
            type="email"
            value={email}
            placeholder={initial.alertEmail}
            disabled={pending}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-[280px]"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || email.trim() === ''}
            onClick={() => save({ alertEmail: email.trim() })}
          >
            Save
          </Button>
        </div>
        <span className="text-[11px] text-zinc-400">Leave blank to use your account email ({initial.alertEmail}).</span>
      </div>

      {error && <p className="text-[12px] text-status-down">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Per-service toggle (client)**

`apps/web/components/settings/service-alert-toggle.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';

import type { ServiceDto } from '@/lib/services-api';
import { toggleServiceAlertsAction } from '@/app/(app)/settings/actions';

export function ServiceAlertToggle({ service }: { service: ServiceDto }) {
  const [enabled, setEnabled] = useState(service.alertsEnabled);
  const [pending, start] = useTransition();

  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setEnabled(next);
          start(async () => { await toggleServiceAlertsAction(service.id, next); });
        }}
        className="h-3.5 w-3.5 accent-status-up"
      />
      <span className="text-[11px] text-zinc-500">alerts</span>
    </label>
  );
}
```

Note: `ServiceDto` must expose `alertsEnabled`. It currently does **not** (see `apps/web/lib/services-api.ts`). Add `alertsEnabled: boolean;` to the `ServiceDto` type and confirm the server's `/internal/services` list returns it (the Drizzle `Service` row includes `alertsEnabled`, so the JSON already carries it — this is a type-only addition on the web side).

- [ ] **Step 4: Settings page (Server Component)**

`apps/web/app/(app)/settings/page.tsx`:

```tsx
import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchNotificationSettings } from '@/lib/notification-settings-api';
import { fetchServices } from '@/lib/services-api';
import { AlertsSettingsForm } from '@/components/settings/alerts-settings-form';
import { ServiceAlertToggle } from '@/components/settings/service-alert-toggle';

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) notFound();
  const [settings, services] = await Promise.all([
    fetchNotificationSettings(user.id),
    fetchServices(user.id),
  ]);

  return (
    <main className="flex flex-1 flex-col">
      <div className="border-b border-zinc-200/60 px-5 py-3.5">
        <h1 className="text-sm font-semibold text-zinc-900">Settings</h1>
        <p className="mt-0.5 text-[12px] text-zinc-500">Email alerts for service incidents.</p>
      </div>

      <section className="border-b border-zinc-200/40">
        <h2 className="px-5 pt-4 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Email alerts</h2>
        <AlertsSettingsForm initial={settings} />
      </section>

      <section className="flex flex-1 flex-col">
        <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Per-service</h2>
        {services.length === 0 ? (
          <p className="px-5 pb-4 text-[12px] text-zinc-400">No services yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200/40">
            {services.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <span className="truncate text-[13px] font-medium text-zinc-900">{s.name}</span>
                <ServiceAlertToggle service={s} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Add the SETTINGS nav link**

In `apps/web/app/(app)/layout.tsx`, add a `SETTINGS` link to the nav cluster alongside `SERVICES` / `INCIDENTS` (added in 5a), matching that style.

- [ ] **Step 6: Design pass (frontend-design skill)**

Invoke the frontend-design skill for a quick pass: settings is a plain form, so keep it consistent with the existing surfaces (mono eyebrows, hairlines, zinc palette, whitespace grouping) — not a headline redesign. A basic checkbox is acceptable; polish the toggle affordance only if it's cheap and on-brand.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` (PASS). Manually load `/settings`.

```bash
git add apps/web/components/settings "apps/web/app/(app)/settings/page.tsx" apps/web/app/\(app\)/layout.tsx apps/web/lib/services-api.ts
git commit -m "feat(web): /settings page — global + per-service alert toggles"
```

---

## Task 9: Infra docs + full verification

**Files:**
- Modify: `docs/INFRASTRUCTURE.md`

- [ ] **Step 1: Document Resend in `INFRASTRUCTURE.md`**

Add an "Email alerts (Resend)" section: create a Resend account; add + verify a sending domain (or subdomain) for `thiluxan.com` via the DNS records Resend provides; set `RESEND_API_KEY` and `ALERT_FROM_EMAIL` in the production server/worker environment (the worker process reads them). Note that with either unset, alerting is disabled and the worker idles — safe default.

- [ ] **Step 2: Full typecheck + lint + server suite**

Run: `npm run typecheck && npm run lint && npm run --workspace @beacon/server test`
Expected: all PASS.

- [ ] **Step 3: Manual happy-path (use the `run`/`verify` skill; requires Resend configured)**

With `RESEND_API_KEY` + `ALERT_FROM_EMAIL` set and the app running: break a service (two failing checks) → receive a "🔴 DOWN" email with the incident link. Recover it → receive a "✅ recovered" email with the downtime. Toggle global alerts off in `/settings` → no email on the next incident. Pause a down service → no email.

- [ ] **Step 4: Manual failure/edge checks**

- Unset `RESEND_API_KEY` → worker logs "alerts disabled" once and idles; app runs; no crash.
- A resolve-by-pause produces no email (already asserted in tests; confirm once live).

- [ ] **Step 5: Commit + finish the branch**

```bash
git add docs/INFRASTRUCTURE.md
git commit -m "docs(infra): Resend email-alerts setup + prod env vars"
```

Then invoke `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** schema (T1), email lib + optional env (T2), settings repo + shared schema (T3), alerts gating repo (T4), settings endpoints (T5), reconciler worker (T6), web client + actions (T7), settings page + toggles + nav (T8), infra docs + verification (T9). Non-goals (channels beyond email, per-service destinations, throttling, domains) are not built.
- **Interface consistency:** `AlertTarget` defined in `email.ts` (T2), produced by `alerts.ts` (T4), consumed by `alert-worker.ts` (T6). `SendResult` from `email.ts` used by the worker's `Send` type. `NotificationSettingsUpdateSchema` (T3) used by the endpoint (T5) and actions (T7). `getResolvedSettings`/`upsertSettings` names match across T3/T5. The `ServiceDto.alertsEnabled` addition (T8 Step 3) is the one web-type change consumed by the per-service toggle.
- **Dedup/gating invariants:** open needs `resolved_at IS NULL AND notification_sent=false` + both toggles; `markOpenNotifiedAndRecord` flips the flag and writes the `(opened,sent)` ledger row (partial-unique guards double-send). Resolve needs `notification_sent=true AND resolution_check_id IS NOT NULL` + no prior `(resolved,sent)` — pause-resolves (`resolution_check_id null`) are excluded.
