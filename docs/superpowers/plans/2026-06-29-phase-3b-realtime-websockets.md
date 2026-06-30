# Phase 3 Slice B — Real-Time WebSocket Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the check worker flips a service's status, stream the change to the browser over a WebSocket so the dashboard and the new service detail page update in place — no refresh.

**Architecture:** The worker (separate process) emits `pg_notify('beacon_events', …)` inside `applyCheckResult`'s transaction on a status change. The Hono server holds a dedicated `LISTEN beacon_events` connection and fans each event out, in memory, to Clerk-authenticated WebSocket clients subscribed to the matching topic (`global` and `service:<id>`), scoped to the owning user. The browser keeps one reconnecting WS singleton; thin client components hydrate from server-fetched data and patch status live.

**Tech Stack:** `ws` (native WebSockets), `@clerk/backend` (`verifyToken`), `pg` LISTEN/NOTIFY, Hono via `@hono/node-server`, Drizzle, Zod, Next.js 16, Vitest.

**Design spec:** `docs/superpowers/specs/2026-06-29-phase-3b-realtime-websockets-design.md`

## Global Constraints

- TypeScript strict, no `any`; `type` over `interface`; Zod schemas are the source of truth; DB types via `$inferSelect`.
- All DB access through `apps/server/src/db/repositories/`. The status-write seam stays `applyCheckResult`.
- Native `ws` library only — NOT Socket.io. One persistent WS per browser tab, multiplexed topics.
- Topics: `global` (a user's own status changes) and `service:<id>`. Each `service.status_changed` is broadcast to both. Fan-out is filtered to the event's `userId` (no cross-user leakage even on the shared `global` topic name).
- WS auth: verify the Clerk session JWT on connect via `@clerk/backend` `verifyToken`, resolve `clerkUserId → userId` via `getByClerkId`; reject otherwise. The per-topic ACL: `service:<id>` requires `getService(userId, id) !== null`; `global` is allowed for the connection's own user.
- Heartbeat: server ping every 30s, drop a connection after 2 missed pongs. Client reconnect: exponential backoff 1s→2s→4s→8s capped at 30s, resubscribe all topics on reconnect.
- New deps are the locked-in stack (`ws`) or required for auth (`@clerk/backend`) — no others.
- **Next.js 16** has breaking changes (see `apps/web/AGENTS.md`); confirm App Router / client APIs in `node_modules/next/dist/docs/` before web code.
- **Use Context7** to confirm current APIs before writing against: `ws` (`WebSocketServer`, `noServer`, `handleUpgrade`), `@hono/node-server` (`serve()` return type for the `upgrade` event), `@clerk/backend` (`verifyToken` signature/claims), and `pg` (`Client`, `LISTEN`, the `notification` event).
- Conventional commits; pause for human approval before every `git add`/`git commit`.

## File structure

```
packages/shared/src/
  schemas/ws-event.ts          (new) WsEventSchema (status_changed) + types
  index.ts                     (modify) re-export
apps/server/src/
  lib/env.ts                   (modify) add CLERK_SECRET_KEY
  db/repositories/services.ts  (modify) applyCheckResult emits pg_notify; add listChecks, deleteChecksOlderThan
  ws/auth.ts                   (new) authenticateConnection
  ws/connections.ts            (new) registry, topic ACL, broadcast, heartbeat
  ws/listener.ts               (new) LISTEN beacon_events -> broadcast
  ws/server.ts                 (new) attach WebSocketServer, upgrade /ws, message routing
  index.ts                     (modify) wire WS server + listener
  router.ts                    (modify) GET /internal/services/:id/checks
  workers/check-worker.ts      (modify) daily cleanup tick
  package.json                 (modify) deps: ws, @types/ws, @clerk/backend
apps/web/
  lib/env.client.ts            (modify) NEXT_PUBLIC_WS_URL
  lib/ws-client.ts             (new) reconnecting WS singleton + backoff
  lib/use-ws.tsx               (new) provider/hook: token plumbing + connection state + subscribe
  lib/services-api.ts          (modify) fetchService, fetchServiceChecks, ServiceCheckDto
  components/services/connection-indicator.tsx (new)
  components/services/services-live-list.tsx   (new) client wrapper, useLiveServices
  components/services/service-status-live.tsx  (new) detail header live status
  app/(app)/services/page.tsx                  (modify) render the live list
  app/(app)/services/[serviceId]/page.tsx      (new) detail page
  app/(app)/layout.tsx                         (modify) mount provider + indicator
.env / docs
  apps/server/.env.example, apps/web/.env.example (modify)
  docs/INFRASTRUCTURE.md       (modify) /ws, NEXT_PUBLIC_WS_URL, CLERK_SECRET_KEY on server
```

---

### Task 1: Shared WebSocket event schema

**Files:**
- Create: `packages/shared/src/schemas/ws-event.ts`, `packages/shared/src/schemas/ws-event.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `WsEventSchema` (Zod discriminated union, member `service.status_changed`), `WsEvent` type, and `WsClientMessageSchema` (`subscribe`/`unsubscribe` with a `topic`). `WsEvent` payload for `service.status_changed`: `{ serviceId: string; userId: string; status: ServiceStatus; previousStatus: ServiceStatus; occurredAt: string }`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/schemas/ws-event.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { WsClientMessageSchema, WsEventSchema } from './ws-event';

describe('WsEventSchema', () => {
  it('parses a service.status_changed event', () => {
    const e = {
      type: 'service.status_changed',
      serviceId: 's1',
      userId: 'u1',
      status: 'up',
      previousStatus: 'pending',
      occurredAt: '2026-06-29T00:00:00.000Z',
    };
    expect(WsEventSchema.parse(e)).toEqual(e);
  });

  it('rejects an unknown event type', () => {
    expect(WsEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a bad status', () => {
    expect(
      WsEventSchema.safeParse({ type: 'service.status_changed', serviceId: 's', userId: 'u', status: 'sideways', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('WsClientMessageSchema', () => {
  it('parses subscribe/unsubscribe', () => {
    expect(WsClientMessageSchema.parse({ type: 'subscribe', topic: 'service:s1' })).toEqual({ type: 'subscribe', topic: 'service:s1' });
    expect(WsClientMessageSchema.parse({ type: 'unsubscribe', topic: 'global' })).toEqual({ type: 'unsubscribe', topic: 'global' });
  });

  it('rejects an empty topic', () => {
    expect(WsClientMessageSchema.safeParse({ type: 'subscribe', topic: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @beacon/shared -- ws-event`
Expected: FAIL — cannot resolve `./ws-event`.

- [ ] **Step 3: Implement** — `packages/shared/src/schemas/ws-event.ts`

```ts
import { z } from 'zod';
import { ServiceStatusSchema } from './service';

export const ServiceStatusChangedSchema = z.object({
  type: z.literal('service.status_changed'),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  status: ServiceStatusSchema,
  previousStatus: ServiceStatusSchema,
  occurredAt: z.string().datetime(),
});

export const WsEventSchema = z.discriminatedUnion('type', [ServiceStatusChangedSchema]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export const WsClientMessageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: z.string().min(1),
});
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
```

- [ ] **Step 4: Re-export** — append to `packages/shared/src/index.ts`

```ts
export {
  WsEventSchema,
  WsClientMessageSchema,
  type WsEvent,
  type WsClientMessage,
} from './schemas/ws-event';
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -w @beacon/shared && npm run typecheck -w @beacon/shared`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit (request approval first)**

```bash
git add packages/shared/src/schemas/ws-event.ts packages/shared/src/schemas/ws-event.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): websocket event + client message schemas"
```

---

### Task 2: Server/web setup — dependencies + env vars

**Files:**
- Modify: `apps/server/package.json` (deps), `apps/server/src/lib/env.ts`, `apps/server/.env.example`
- Modify: `apps/web/lib/env.client.ts`, `apps/web/.env.example`, `apps/web/Dockerfile`
- Modify: `.github/workflows/deploy.yml` (checks-job env + web build-arg), `infrastructure/docker-compose.local-prod.yml` (web build-arg)

**Interfaces:**
- Produces: server `env.CLERK_SECRET_KEY: string`; web `clientEnv.NEXT_PUBLIC_WS_URL: string`. Installs `ws`, `@types/ws`, `@clerk/backend` into `@beacon/server`.

- [ ] **Step 1: Install server deps**

Run: `npm install -w @beacon/server ws @clerk/backend && npm install -D -w @beacon/server @types/ws`
Expected: `package.json` gains `ws`, `@clerk/backend` (deps) and `@types/ws` (devDeps); lockfile updated. Confirm with `node -e "console.log(require('ws/package.json').version, require('@clerk/backend/package.json').version)"`.

- [ ] **Step 2: Add `CLERK_SECRET_KEY` to server env** — modify `apps/server/src/lib/env.ts`

In the `EnvSchema` object add (after `INTERNAL_API_SECRET`):

```ts
  CLERK_SECRET_KEY: z.string().min(1),
```

- [ ] **Step 3: Add `NEXT_PUBLIC_WS_URL` to web client env** — modify `apps/web/lib/env.client.ts`

Add to the `ClientEnvSchema` object and the parsed object (NEXT_PUBLIC vars must be referenced literally):

```ts
  NEXT_PUBLIC_WS_URL: z.string().url(),
```
and in the `.parse({...})` call:
```ts
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
```

- [ ] **Step 4: Update `.env.example` files**

`apps/server/.env.example` — add: `CLERK_SECRET_KEY=sk_test_...`
`apps/web/.env.example` — add: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws`

- [ ] **Step 5: Bake `NEXT_PUBLIC_WS_URL` into the web image build** — modify `apps/web/Dockerfile`

`NEXT_PUBLIC_*` are inlined at build time, so the web build will fail (or ship an unset URL) unless the arg is provided. In the `builder` stage, next to the existing `ARG NEXT_PUBLIC_API_URL` / `ENV NEXT_PUBLIC_API_URL=...` lines, add:

```dockerfile
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
```

- [ ] **Step 6: Pass the new vars through CI** — modify `.github/workflows/deploy.yml`

(a) In the `checks` job's `env:` block (which has `DATABASE_URL`, `WEB_ORIGIN`, `INTERNAL_API_SECRET`), add — the server env schema now requires it and `migrate.ts` validates the full schema at import, so without this the CI checks job fails:

```yaml
      CLERK_SECRET_KEY: sk_test_ci_placeholder
```

(b) In the **web** image `build-args` (currently `NEXT_PUBLIC_API_URL` + `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), add:

```yaml
            NEXT_PUBLIC_WS_URL=wss://api.beacon.thiluxan.com/ws
```

- [ ] **Step 7: Pass the var in the local-prod smoke build** — modify `infrastructure/docker-compose.local-prod.yml`

In the `web` service `build.args` (next to `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), add:

```yaml
        NEXT_PUBLIC_WS_URL: ws://localhost:3001/ws
```

- [ ] **Step 8: Verify**

Run:
`DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters CLERK_SECRET_KEY=sk_test_x npm run typecheck -w @beacon/server && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web`
Then validate the workflow + compose still parse: `python3 -c "import yaml;yaml.safe_load(open('.github/workflows/deploy.yml'));print('yaml ok')"` and `BEACON_VERSION=test POSTGRES_PASSWORD=test docker compose -f infrastructure/docker-compose.yml -f infrastructure/docker-compose.local-prod.yml config >/dev/null && echo composeok`.
Expected: typecheck clean; `yaml ok`; `composeok`. (All later server commands must include `CLERK_SECRET_KEY=sk_test_x`; web commands `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws`.)

- [ ] **Step 9: Commit (request approval first)**

```bash
git add apps/server/package.json apps/web/package.json package-lock.json apps/server/src/lib/env.ts apps/web/lib/env.client.ts apps/server/.env.example apps/web/.env.example apps/web/Dockerfile .github/workflows/deploy.yml infrastructure/docker-compose.local-prod.yml
git commit -m "feat(infra): ws + @clerk/backend deps; CLERK_SECRET_KEY + NEXT_PUBLIC_WS_URL env, build-args, and CI"
```

> From here on, every server command in this plan must include `CLERK_SECRET_KEY=sk_test_x` in its env prefix, and every web command `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws`. The env prefix shorthand below is: `SERVER_ENV="DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters CLERK_SECRET_KEY=sk_test_x"`.

---

### Task 3: `applyCheckResult` emits `pg_notify` on status change

**Files:**
- Modify: `apps/server/src/db/repositories/services.ts`
- Create: `apps/server/src/db/repositories/notify.test.ts`

**Interfaces:**
- Consumes: `WsEvent` from `@beacon/shared`; `sql` from `drizzle-orm`.
- Produces: `applyCheckResult` (unchanged signature) now, inside its transaction and only when `newStatus !== service.currentStatus`, executes `select pg_notify('beacon_events', <WsEvent JSON>)` with a `service.status_changed` payload.

- [ ] **Step 1: Write the failing test** — `apps/server/src/db/repositories/notify.test.ts`

```ts
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService } from './services';

async function makeService() {
  const u = await upsertFromClerk({ clerkUserId: 'user_n', email: 'n@e.com' });
  return createService(u.id, { name: 'N', baseUrl: 'https://n.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
}

describe('applyCheckResult pg_notify (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('emits a beacon_events notification when status changes', async () => {
    const svc = await makeService();
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query('LISTEN beacon_events');
    const received = new Promise<string>((resolve) => {
      listener.on('notification', (msg) => resolve(msg.payload ?? ''));
    });
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({ type: 'service.status_changed', serviceId: svc.id, userId: svc.userId, status: 'up', previousStatus: 'pending' });
    await listener.end();
  });

  it('emits NO notification when status is unchanged', async () => {
    const svc = await makeService();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    const after = { ...svc, currentStatus: 'up' as const };
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query('LISTEN beacon_events');
    let got = false;
    listener.on('notification', () => { got = true; });
    await applyCheckResult({ service: after, check: { status: 'success', statusCode: 200, responseTimeMs: 11, errorMessage: null }, newStatus: 'up' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toBe(false);
    await listener.end();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- notify`
Expected: FAIL — no notification received (timeout) / first test hangs then fails.

- [ ] **Step 3: Implement** — in `apps/server/src/db/repositories/services.ts`, inside `applyCheckResult`'s transaction, after the existing `tx.update(services)...`, add (only when status changed):

```ts
    if (statusChanged) {
      const event = {
        type: 'service.status_changed' as const,
        serviceId: args.service.id,
        userId: args.service.userId,
        status: args.newStatus,
        previousStatus: args.service.currentStatus,
        occurredAt: now.toISOString(),
      };
      await tx.execute(sql`select pg_notify('beacon_events', ${JSON.stringify(event)})`);
    }
```

Ensure `import { ... sql } from 'drizzle-orm';` includes `sql` (add it to the existing import).

- [ ] **Step 4: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- notify`
Expected: PASS (2/2).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/notify.test.ts
git commit -m "feat(server): emit beacon_events pg_notify on status change (txn-atomic)"
```

---

### Task 4: Check-history + cleanup repository functions

**Files:**
- Modify: `apps/server/src/db/repositories/services.ts`
- Create: `apps/server/src/db/repositories/checks.test.ts`

**Interfaces:**
- Produces:
  - `listChecks(userId: string, serviceId: string, limit: number): Promise<ServiceCheck[]>` — newest-first; returns `[]` if the service isn't owned by `userId`.
  - `deleteChecksOlderThan(days: number): Promise<number>` — deletes `service_checks` with `checked_at < now() - days`, returns the count.

- [ ] **Step 1: Write the failing test** — `apps/server/src/db/repositories/checks.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService, deleteChecksOlderThan, listChecks } from './services';

async function seed() {
  const u = await upsertFromClerk({ clerkUserId: 'user_c', email: 'c@e.com' });
  const svc = await createService(u.id, { name: 'C', baseUrl: 'https://c.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  return { userId: u.id, svc };
}

describe('checks repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('lists checks newest-first for the owner only', async () => {
    const { userId, svc } = await seed();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    await applyCheckResult({ service: { ...svc, currentStatus: 'up' }, check: { status: 'failure', statusCode: 500, responseTimeMs: 12, errorMessage: null }, newStatus: 'down' });
    const checks = await listChecks(userId, svc.id, 10);
    expect(checks).toHaveLength(2);
    expect(checks[0].checkedAt >= checks[1].checkedAt).toBe(true);
    expect(await listChecks('00000000-0000-0000-0000-000000000000', svc.id, 10)).toEqual([]);
  });

  it('deletes checks older than N days', async () => {
    const { svc } = await seed();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    await pool.query("UPDATE service_checks SET checked_at = now() - interval '40 days' WHERE service_id = $1", [svc.id]);
    expect(await deleteChecksOlderThan(30)).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM service_checks WHERE service_id=$1', [svc.id]);
    expect(rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- checks`
Expected: FAIL — `listChecks`/`deleteChecksOlderThan` not exported.

- [ ] **Step 3: Implement** — append to `apps/server/src/db/repositories/services.ts`

Add imports (merge): `import { serviceChecks, type ServiceCheck } from '../schema';` and `import { lt, sql } from 'drizzle-orm';` (merge with existing). Then:

```ts
export async function listChecks(userId: string, serviceId: string, limit: number): Promise<ServiceCheck[]> {
  const owned = await getService(userId, serviceId);
  if (!owned) return [];
  return db
    .select()
    .from(serviceChecks)
    .where(eq(serviceChecks.serviceId, serviceId))
    .orderBy(desc(serviceChecks.checkedAt))
    .limit(limit);
}

export async function deleteChecksOlderThan(days: number): Promise<number> {
  const rows = await db
    .delete(serviceChecks)
    .where(lt(serviceChecks.checkedAt, sql`now() - make_interval(days => ${days})`))
    .returning({ id: serviceChecks.id });
  return rows.length;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- checks`
Expected: PASS (2/2).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/db/repositories/services.ts apps/server/src/db/repositories/checks.test.ts
git commit -m "feat(server): listChecks + deleteChecksOlderThan repository queries"
```

---

### Task 5: WebSocket connection auth

**Files:**
- Create: `apps/server/src/ws/auth.ts`, `apps/server/src/ws/auth.test.ts`

**Interfaces:**
- Produces: `authenticateConnection(token: string | undefined, deps?: { verify?: (t: string) => Promise<{ sub: string }>; }): Promise<{ userId: string } | null>` — verifies the Clerk JWT (default: `@clerk/backend` `verifyToken` with `env.CLERK_SECRET_KEY`), resolves `sub` (clerkUserId) → internal user via `getByClerkId`, returns `{ userId }` or `null`. Injectable `verify` for testing.

- [ ] **Step 1: Write the failing test** — `apps/server/src/ws/auth.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/index';
import { upsertFromClerk } from '../db/repositories/users';
import { authenticateConnection } from './auth';

describe('authenticateConnection (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('returns userId for a valid token whose user exists', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'clerk_1', email: 'a@e.com' });
    const verify = vi.fn().mockResolvedValue({ sub: 'clerk_1' });
    expect(await authenticateConnection('tok', { verify })).toEqual({ userId: u.id });
  });

  it('returns null when no token', async () => {
    expect(await authenticateConnection(undefined)).toBeNull();
  });

  it('returns null when verify throws', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('bad'));
    expect(await authenticateConnection('tok', { verify })).toBeNull();
  });

  it('returns null when the clerk user is unknown', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'nobody' });
    expect(await authenticateConnection('tok', { verify })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/auth`
Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 3: Implement** — `apps/server/src/ws/auth.ts`

> Verify the `@clerk/backend` `verifyToken` import + options shape via Context7 for the installed version before finalizing the default `verify`.

```ts
import { verifyToken } from '@clerk/backend';
import { env } from '../lib/env';
import { getByClerkId } from '../db/repositories/users';

type VerifyFn = (token: string) => Promise<{ sub: string }>;

const defaultVerify: VerifyFn = async (token) => {
  const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return { sub: String(claims.sub) };
};

export async function authenticateConnection(
  token: string | undefined,
  deps: { verify?: VerifyFn } = {},
): Promise<{ userId: string } | null> {
  if (!token) return null;
  const verify = deps.verify ?? defaultVerify;
  try {
    const { sub } = await verify(token);
    const user = await getByClerkId(sub);
    return user ? { userId: user.id } : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/auth`
Expected: PASS (4/4).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/ws/auth.ts apps/server/src/ws/auth.test.ts
git commit -m "feat(server): websocket connection auth via Clerk verifyToken"
```

---

### Task 6: Connection registry, topic ACL, and fan-out

**Files:**
- Create: `apps/server/src/ws/connections.ts`, `apps/server/src/ws/connections.test.ts`

**Interfaces:**
- Consumes: `getService` (ownership check); `WsEvent` from `@beacon/shared`.
- Produces a `ConnectionHub` with:
  - `add(ws: WsLike, userId: string): string` (returns connId), `remove(connId)`.
  - `subscribe(connId, topic, deps?): Promise<boolean>` — applies the ACL (`global` → ok; `service:<id>` → `getService(userId,id)!==null`), returns whether subscribed. `deps.canAccessService?` injectable.
  - `unsubscribe(connId, topic)`.
  - `broadcast(event: WsEvent): void` — sends the event JSON to every connection of `event.userId` subscribed to `global` or `service:<event.serviceId>`.
  - `WsLike = { send(data: string): void; readyState?: number }` (so tests pass fakes).

- [ ] **Step 1: Write the failing test** — `apps/server/src/ws/connections.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@beacon/shared';
import { ConnectionHub, type WsLike } from './connections';

function fakeWs() {
  return { sent: [] as string[], send(d: string) { this.sent.push(d); } } as WsLike & { sent: string[] };
}

const event: WsEvent = { type: 'service.status_changed', serviceId: 'svc1', userId: 'u1', status: 'down', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' };

describe('ConnectionHub', () => {
  it('broadcasts to a connection subscribed to the service topic of the same user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    await hub.subscribe(id, 'service:svc1', { canAccessService: async () => true });
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'service.status_changed', serviceId: 'svc1' });
  });

  it('broadcasts to global subscribers of the same user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    await hub.subscribe(id, 'global');
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(1);
  });

  it('does NOT broadcast to a different user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u2');
    await hub.subscribe(id, 'global');
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(0);
  });

  it('rejects subscribing to a service the user does not own', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    const ok = await hub.subscribe(id, 'service:other', { canAccessService: async () => false });
    expect(ok).toBe(false);
    hub.broadcast({ ...event, serviceId: 'other' });
    expect(ws.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/connections`
Expected: FAIL — cannot resolve `./connections`.

- [ ] **Step 3: Implement** — `apps/server/src/ws/connections.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { WsEvent } from '@beacon/shared';
import { getService } from '../db/repositories/services';

export type WsLike = { send(data: string): void; readyState?: number };

type Conn = { ws: WsLike; userId: string; topics: Set<string>; alive: boolean };

export class ConnectionHub {
  private conns = new Map<string, Conn>();

  add(ws: WsLike, userId: string): string {
    const id = randomUUID();
    this.conns.set(id, { ws, userId, topics: new Set(), alive: true });
    return id;
  }

  remove(connId: string): void {
    this.conns.delete(connId);
  }

  get(connId: string): Conn | undefined {
    return this.conns.get(connId);
  }

  async subscribe(
    connId: string,
    topic: string,
    deps: { canAccessService?: (userId: string, serviceId: string) => Promise<boolean> } = {},
  ): Promise<boolean> {
    const conn = this.conns.get(connId);
    if (!conn) return false;
    if (topic !== 'global') {
      const m = /^service:(.+)$/.exec(topic);
      if (!m) return false;
      const canAccess = deps.canAccessService ?? (async (uid, sid) => (await getService(uid, sid)) !== null);
      if (!(await canAccess(conn.userId, m[1]))) return false;
    }
    conn.topics.add(topic);
    return true;
  }

  unsubscribe(connId: string, topic: string): void {
    this.conns.get(connId)?.topics.delete(topic);
  }

  broadcast(event: WsEvent): void {
    const data = JSON.stringify(event);
    const serviceTopic = `service:${event.serviceId}`;
    for (const conn of this.conns.values()) {
      if (conn.userId !== event.userId) continue;
      if (conn.topics.has('global') || conn.topics.has(serviceTopic)) {
        try {
          conn.ws.send(data);
        } catch {
          // a dead socket is cleaned up by the heartbeat / close handler; never let it break the loop
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/connections`
Expected: PASS (4/4).

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/server/src/ws/connections.ts apps/server/src/ws/connections.test.ts
git commit -m "feat(server): websocket connection hub with topic ACL and user-scoped fan-out"
```

---

### Task 7: Postgres LISTEN relay

**Files:**
- Create: `apps/server/src/ws/listener.ts`, `apps/server/src/ws/listener.test.ts`

**Interfaces:**
- Consumes: `WsEventSchema` from `@beacon/shared`; a `ConnectionHub`.
- Produces: `startEventListener(hub: { broadcast(e: WsEvent): void }, deps?: { connectionString?: string }): Promise<{ stop(): Promise<void> }>` — opens a dedicated `pg` `Client`, `LISTEN beacon_events`, validates each payload with `WsEventSchema`, calls `hub.broadcast`. Reconnects on error.

- [ ] **Step 1: Write the failing test** — `apps/server/src/ws/listener.test.ts`

```ts
import { Client } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startEventListener } from './listener';

describe('startEventListener (integration)', () => {
  it('broadcasts a valid beacon_events payload', async () => {
    const broadcast = vi.fn();
    const sub = await startEventListener({ broadcast }, { connectionString: process.env.DATABASE_URL });
    const event = { type: 'service.status_changed', serviceId: 's1', userId: 'u1', status: 'up', previousStatus: 'pending', occurredAt: '2026-06-29T00:00:00.000Z' };
    const notifier = new Client({ connectionString: process.env.DATABASE_URL });
    await notifier.connect();
    await notifier.query(`select pg_notify('beacon_events', $1)`, [JSON.stringify(event)]);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'service.status_changed', serviceId: 's1' })), { timeout: 2000 });
    await notifier.end();
    await sub.stop();
  });

  it('ignores an invalid payload', async () => {
    const broadcast = vi.fn();
    const sub = await startEventListener({ broadcast }, { connectionString: process.env.DATABASE_URL });
    const notifier = new Client({ connectionString: process.env.DATABASE_URL });
    await notifier.connect();
    await notifier.query(`select pg_notify('beacon_events', $1)`, ['not json']);
    await new Promise((r) => setTimeout(r, 300));
    expect(broadcast).not.toHaveBeenCalled();
    await notifier.end();
    await sub.stop();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/listener`
Expected: FAIL — cannot resolve `./listener`.

- [ ] **Step 3: Implement** — `apps/server/src/ws/listener.ts`

> Confirm the `pg` `Client` `notification` event + `LISTEN` usage via Context7.

```ts
import { Client } from 'pg';
import { WsEventSchema, type WsEvent } from '@beacon/shared';
import { env } from '../lib/env';

export async function startEventListener(
  hub: { broadcast(e: WsEvent): void },
  deps: { connectionString?: string } = {},
): Promise<{ stop(): Promise<void> }> {
  const connectionString = deps.connectionString ?? env.DATABASE_URL;
  let stopped = false;
  let client: Client;

  async function connect(): Promise<void> {
    client = new Client({ connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== 'beacon_events' || !msg.payload) return;
      const parsed = WsEventSchema.safeParse(JSON.parse(msg.payload));
      if (parsed.success) hub.broadcast(parsed.data);
      else console.error('[beacon-ws] dropped invalid beacon_events payload');
    });
    client.on('error', (err) => {
      console.error('[beacon-ws] LISTEN client error', err);
    });
    client.on('end', () => {
      if (!stopped) setTimeout(() => void connect(), 1000); // reconnect with a small backoff
    });
    await client.connect();
    await client.query('LISTEN beacon_events');
  }

  await connect();
  return {
    async stop() {
      stopped = true;
      await client.end();
    },
  };
}
```

> `JSON.parse` may throw on non-JSON payloads — wrap it so the handler never throws: replace the `safeParse(JSON.parse(...))` line with a try/catch that logs and returns on parse failure.

- [ ] **Step 4: Make the parse safe** — adjust the `notification` handler so a non-JSON payload is caught:

```ts
    client.on('notification', (msg) => {
      if (msg.channel !== 'beacon_events' || !msg.payload) return;
      let json: unknown;
      try {
        json = JSON.parse(msg.payload);
      } catch {
        console.error('[beacon-ws] non-JSON beacon_events payload');
        return;
      }
      const parsed = WsEventSchema.safeParse(json);
      if (parsed.success) hub.broadcast(parsed.data);
      else console.error('[beacon-ws] dropped invalid beacon_events payload');
    });
```

- [ ] **Step 5: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/listener`
Expected: PASS (2/2).

- [ ] **Step 6: Commit (request approval first)**

```bash
git add apps/server/src/ws/listener.ts apps/server/src/ws/listener.test.ts
git commit -m "feat(server): postgres LISTEN relay for beacon_events -> hub broadcast"
```

---

### Task 8: WebSocket server wiring

**Files:**
- Create: `apps/server/src/ws/server.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/src/ws/server.test.ts`

**Interfaces:**
- Consumes: `ConnectionHub`, `authenticateConnection`, `startEventListener`, `WsClientMessageSchema`.
- Produces: `attachWebSocketServer(httpServer, hub, deps?)` — on `upgrade` for path `/ws`, authenticate via the `?token=` query param; on success register the connection in the hub and route incoming `subscribe`/`unsubscribe` messages; 30s heartbeat ping with pong tracking, terminate after 2 missed; clean up on close.

- [ ] **Step 1: Write the failing test (real ws round-trip)** — `apps/server/src/ws/server.test.ts`

```ts
import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ConnectionHub } from './connections';
import { attachWebSocketServer } from './server';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
}

describe('attachWebSocketServer (integration)', () => {
  it('authenticates, subscribes, and receives a broadcast', async () => {
    const hub = new ConnectionHub();
    const httpServer = createServer();
    attachWebSocketServer(httpServer, hub, {
      authenticate: async (token) => (token === 'good' ? { userId: 'u1' } : null),
      canAccessService: async () => true,
      heartbeatMs: 10_000,
    });
    const port = await listen(httpServer);

    const ws = new WebSocket(`ws://localhost:${port}/ws?token=good`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'service:s1' }));
    await new Promise((r) => setTimeout(r, 50));
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())));
    hub.broadcast({ type: 'service.status_changed', serviceId: 's1', userId: 'u1', status: 'down', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' });
    const msg = JSON.parse(await got);
    expect(msg).toMatchObject({ type: 'service.status_changed', serviceId: 's1' });
    ws.close();
    httpServer.close();
  });

  it('rejects a bad token', async () => {
    const hub = new ConnectionHub();
    const httpServer = createServer();
    attachWebSocketServer(httpServer, hub, { authenticate: async () => null, heartbeatMs: 10_000 });
    const port = await listen(httpServer);
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('close', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    expect(closed).toBe(true);
    httpServer.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/server`
Expected: FAIL — cannot resolve `./server`.

- [ ] **Step 3: Implement** — `apps/server/src/ws/server.ts`

> Confirm the `ws` `WebSocketServer({ noServer: true })` + `handleUpgrade` pattern via Context7. `attachWebSocketServer` takes the Node `http.Server`.

```ts
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsClientMessageSchema } from '@beacon/shared';
import { authenticateConnection } from './auth';
import type { ConnectionHub } from './connections';

type Deps = {
  authenticate?: (token: string | undefined) => Promise<{ userId: string } | null>;
  canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
  heartbeatMs?: number;
};

export function attachWebSocketServer(httpServer: Server, hub: ConnectionHub, deps: Deps = {}): void {
  const authenticate = deps.authenticate ?? ((t) => authenticateConnection(t));
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token') ?? undefined;
    const auth = await authenticate(token);
    if (!auth) {
      ws.close(1008, 'unauthorized');
      return;
    }
    const connId = hub.add(ws, auth.userId);
    let missed = 0;
    ws.on('pong', () => { missed = 0; });
    const timer = setInterval(() => {
      if (missed >= 2) { ws.terminate(); return; }
      missed += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, heartbeatMs);

    ws.on('message', async (raw) => {
      const parsed = WsClientMessageSchema.safeParse(JSON.parse(raw.toString() || 'null'));
      if (!parsed.success) return;
      if (parsed.data.type === 'subscribe') {
        await hub.subscribe(connId, parsed.data.topic, { canAccessService: deps.canAccessService });
      } else {
        hub.unsubscribe(connId, parsed.data.topic);
      }
    });

    ws.on('close', () => { clearInterval(timer); hub.remove(connId); });
    ws.on('error', () => { clearInterval(timer); hub.remove(connId); });
  });
}
```

> The `JSON.parse(raw.toString() || 'null')` can throw on malformed input — wrap it in try/catch and `return` on failure so a bad client message never crashes the handler.

- [ ] **Step 4: Harden message parse** — wrap the parse:

```ts
    ws.on('message', async (raw) => {
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return; }
      const parsed = WsClientMessageSchema.safeParse(json);
      if (!parsed.success) return;
      if (parsed.data.type === 'subscribe') await hub.subscribe(connId, parsed.data.topic, { canAccessService: deps.canAccessService });
      else hub.unsubscribe(connId, parsed.data.topic);
    });
```

- [ ] **Step 5: Wire into `index.ts`** — modify `apps/server/src/index.ts`

```ts
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { createRouter } from './router';
import { ConnectionHub } from './ws/connections';
import { attachWebSocketServer } from './ws/server';
import { startEventListener } from './ws/listener';

const app = new Hono();
app.use('*', cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.route('/', createRouter());

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[beacon-server] listening on http://localhost:${info.port}`);
});

const hub = new ConnectionHub();
attachWebSocketServer(server as unknown as import('node:http').Server, hub);
void startEventListener(hub).then(() => console.log('[beacon-server] LISTEN beacon_events started'));
```

> Confirm the type/shape of `serve()`'s return via Context7 for the installed `@hono/node-server`; it is the Node `http.Server` that emits `upgrade`. Adjust the cast if the installed version returns it differently.

- [ ] **Step 6: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- ws/server` then `$SERVER_ENV npm run typecheck -w @beacon/server && npm run lint -w @beacon/server`
Expected: PASS (2/2); typecheck + lint clean.

- [ ] **Step 7: Commit (request approval first)**

```bash
git add apps/server/src/ws/server.ts apps/server/src/index.ts apps/server/src/ws/server.test.ts
git commit -m "feat(server): websocket server (auth, subscribe routing, heartbeat) wired into index"
```

---

### Task 9: Check-history endpoint + web client

**Files:**
- Modify: `apps/server/src/router.ts`, `apps/web/lib/services-api.ts`
- Create: `apps/server/src/router.checks.test.ts`

**Interfaces:**
- Produces: `GET /internal/services/:id/checks?limit=N` (guarded; ownership-scoped) → `{ checks: ServiceCheck[] }`. Web: `fetchService(clerkUserId, id): Promise<ServiceDto | null>`, `fetchServiceChecks(clerkUserId, id, limit): Promise<ServiceCheckDto[]>`, and `ServiceCheckDto` type.

- [ ] **Step 1: Write the failing test** — `apps/server/src/router.checks.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { applyCheckResult, createService } from './db/repositories/services';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();

describe('GET /internal/services/:id/checks', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('returns recent checks for the owner', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'user_rc', email: 'rc@e.com' });
    const svc = await createService(u.id, { name: 'R', baseUrl: 'https://r.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 9, errorMessage: null }, newStatus: 'up' });
    const res = await app.request(`/internal/services/${svc.id}/checks`, { headers: { 'x-internal-secret': SECRET, 'x-clerk-user-id': 'user_rc' } });
    expect(res.status).toBe(200);
    expect((await res.json()).checks).toHaveLength(1);
  });

  it('401 without the secret', async () => {
    const res = await app.request('/internal/services/x/checks', { headers: { 'x-clerk-user-id': 'user_rc' } });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$SERVER_ENV npm test -w @beacon/server -- router.checks`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement endpoint** — in `apps/server/src/router.ts`, add `listChecks` to the services-repo import, and add this route alongside the other `/internal/services/:id` routes:

```ts
  app.get('/internal/services/:id/checks', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const checks = await listChecks(userId, c.req.param('id'), limit);
    return c.json({ checks });
  });
```

> Ensure the `/internal/services/*` `app.use` guard already covers this path (it does — `:id/checks` matches `/internal/services/*`).

- [ ] **Step 4: Implement web client additions** — append to `apps/web/lib/services-api.ts`

```ts
export type ServiceCheckDto = {
  id: string;
  serviceId: string;
  checkedAt: string;
  status: 'success' | 'failure' | 'timeout' | 'error';
  statusCode: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
};

export async function fetchService(clerkUserId: string, id: string): Promise<ServiceDto | null> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function fetchServiceChecks(clerkUserId: string, id: string, limit = 50): Promise<ServiceCheckDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}/checks?limit=${limit}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchServiceChecks failed: ${res.status}`);
  return (await res.json()).checks as ServiceCheckDto[];
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `$SERVER_ENV npm test -w @beacon/server -- router.checks` then `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web`
Expected: PASS (2/2); web typecheck clean.

- [ ] **Step 6: Commit (request approval first)**

```bash
git add apps/server/src/router.ts apps/server/src/router.checks.test.ts apps/web/lib/services-api.ts
git commit -m "feat: service check-history endpoint + web client (fetchService, fetchServiceChecks)"
```

---

### Task 10: Browser WebSocket singleton

**Files:**
- Create: `apps/web/lib/ws-client.ts`, `apps/web/lib/ws-client.test.ts`

**Interfaces:**
- Produces: `nextBackoffMs(attempt: number): number` (1000·2^attempt, capped 30000) and a `BeaconSocket` class with `constructor(opts: { url: string; getToken: () => Promise<string | null> })`, `connect()`, `subscribe(topic, handler): () => void`, a `state: ConnectionState` field + `onStateChange(cb)`, and internal reconnect/resubscribe using the global browser `WebSocket`. Only `nextBackoffMs` is unit-tested (pure); the socket connect is exercised manually.

- [ ] **Step 1: Write the failing test** — `apps/web/lib/ws-client.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { nextBackoffMs } from './ws-client';

describe('nextBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(3)).toBe(8000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm test -w @beacon/web -- ws-client`
Expected: FAIL — cannot resolve `./ws-client`.

- [ ] **Step 3: Implement** — `apps/web/lib/ws-client.ts`

```ts
import type { WsEvent } from '@beacon/shared';

export function nextBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';
type Handler = (event: WsEvent) => void;

export class BeaconSocket {
  private ws: WebSocket | null = null;
  private topics = new Map<string, Set<Handler>>();
  private attempt = 0;
  private stateCbs = new Set<(s: ConnectionState) => void>();
  state: ConnectionState = 'disconnected';

  constructor(private opts: { url: string; getToken: () => Promise<string | null> }) {}

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  async connect(): Promise<void> {
    const token = await this.opts.getToken();
    if (!token) { this.setState('disconnected'); return; }
    const ws = new WebSocket(`${this.opts.url}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.setState('connected');
      for (const topic of this.topics.keys()) ws.send(JSON.stringify({ type: 'subscribe', topic }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WsEvent;
        const handlers = data.type === 'service.status_changed' ? this.topics.get(`service:${data.serviceId}`) : undefined;
        for (const h of this.topics.get('global') ?? []) h(data);
        for (const h of handlers ?? []) h(data);
      } catch { /* ignore malformed */ }
    });
    ws.addEventListener('close', () => this.scheduleReconnect());
    ws.addEventListener('error', () => ws.close());
  }

  private scheduleReconnect() {
    this.setState('reconnecting');
    const delay = nextBackoffMs(this.attempt++);
    setTimeout(() => void this.connect(), delay);
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.topics.get(topic);
    if (!set) { set = new Set(); this.topics.set(topic, set); }
    set.add(handler);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', topic }));
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.topics.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', topic }));
      }
    };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm test -w @beacon/web -- ws-client && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/web/lib/ws-client.ts apps/web/lib/ws-client.test.ts
git commit -m "feat(web): reconnecting websocket singleton with backoff and resubscribe"
```

---

### Task 11: WS provider, hook, and connection indicator

**Files:**
- Create: `apps/web/lib/use-ws.tsx`, `apps/web/components/services/connection-indicator.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `BeaconSocket`, `ConnectionState`; Clerk `useAuth`.
- Produces: `WsProvider` (mounts one `BeaconSocket` using `useAuth().getToken` and `clientEnv.NEXT_PUBLIC_WS_URL`), `useWsConnectionState(): ConnectionState`, `useServiceStatusSubscription(topic, handler)`, and a `ConnectionIndicator` dot.

- [ ] **Step 1: Implement the provider/hook** — `apps/web/lib/use-ws.tsx`

> Confirm Next.js 16 client-component + context APIs in `node_modules/next/dist/docs/` first.

```tsx
'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { clientEnv } from '@/lib/env.client';
import { BeaconSocket, type ConnectionState } from '@/lib/ws-client';
import type { WsEvent } from '@beacon/shared';

const Ctx = createContext<BeaconSocket | null>(null);

export function WsProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  const socket = useMemo(
    () => new BeaconSocket({ url: clientEnv.NEXT_PUBLIC_WS_URL, getToken: () => getToken() }),
    [getToken],
  );
  useEffect(() => {
    void socket.connect();
    // BeaconSocket has no public disconnect in v1; one socket per app session is intended.
  }, [socket]);
  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

export function useWsConnectionState(): ConnectionState {
  const socket = useContext(Ctx);
  const [state, setState] = useState<ConnectionState>(socket?.state ?? 'disconnected');
  useEffect(() => socket?.onStateChange(setState), [socket]);
  return state;
}

export function useServiceStatusSubscription(topic: string, handler: (e: WsEvent) => void) {
  const socket = useContext(Ctx);
  useEffect(() => socket?.subscribe(topic, handler), [socket, topic, handler]);
}
```

- [ ] **Step 2: Implement the indicator** — `apps/web/components/services/connection-indicator.tsx`

```tsx
'use client';

import { useWsConnectionState } from '@/lib/use-ws';

const DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  disconnected: 'bg-zinc-400',
};

export function ConnectionIndicator() {
  const state = useWsConnectionState();
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500" title={`Realtime: ${state}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[state] ?? 'bg-zinc-400'}`} />
      {state}
    </span>
  );
}
```

- [ ] **Step 3: Mount provider + indicator in the app shell** — modify `apps/web/app/(app)/layout.tsx` to wrap children in `<WsProvider>` and render `<ConnectionIndicator />` in the shell header. (Read the current layout first; preserve existing structure, only add the wrapper + indicator.)

- [ ] **Step 4: Verify**

Run: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run lint -w @beacon/web`
Expected: clean.

- [ ] **Step 5: Commit (request approval first)**

```bash
git add apps/web/lib/use-ws.tsx apps/web/components/services/connection-indicator.tsx "apps/web/app/(app)/layout.tsx"
git commit -m "feat(web): ws provider, connection-state hook, and connection indicator"
```

---

### Task 12: Live dashboard

**Files:**
- Create: `apps/web/components/services/services-live-list.tsx`
- Modify: `apps/web/app/(app)/services/page.tsx`

**Interfaces:**
- Consumes: `ServiceDto`, `useServiceStatusSubscription`; the existing row markup from `page.tsx`.
- Produces: `ServicesLiveList({ initial }: { initial: ServiceDto[] })` — a client component holding services in state, subscribed to `global`, patching the matching service's `currentStatus` on `service.status_changed`. The page passes its server-fetched services in as `initial`.

- [ ] **Step 1: Implement the live list** — `apps/web/components/services/services-live-list.tsx`

Move the per-row card markup from `page.tsx` into this client component; subscribe to `global` and patch state. (Keep the same visual markup the Slice A page rendered for a row — name, status, last-checked, `ServiceRowActions`, link to detail.)

```tsx
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import type { ServiceDto } from '@/lib/services-api';
import { useServiceStatusSubscription } from '@/lib/use-ws';
import { ServiceRowActions } from '@/components/services/service-row-actions';
import type { WsEvent } from '@beacon/shared';

const STATUS_STYLE: Record<string, string> = {
  up: 'text-emerald-600', down: 'text-red-600', degraded: 'text-amber-600', paused: 'text-zinc-400', pending: 'text-zinc-400',
};

export function ServicesLiveList({ initial }: { initial: ServiceDto[] }) {
  const [services, setServices] = useState(initial);
  const onEvent = useCallback((e: WsEvent) => {
    if (e.type !== 'service.status_changed') return;
    setServices((prev) => prev.map((s) => (s.id === e.serviceId ? { ...s, currentStatus: e.status } : s)));
  }, []);
  useServiceStatusSubscription('global', onEvent);

  return (
    <ul className="divide-y divide-zinc-200/40">
      {services.map((s) => (
        <li key={s.id} className="flex items-center gap-4 px-5 py-3">
          <div className="flex-1">
            <Link href={`/services/${s.id}`} className="text-[13px] font-medium text-zinc-900 hover:underline">{s.name}</Link>
            <p className="font-mono text-[11px] text-zinc-400">{s.baseUrl}{s.healthCheckPath}</p>
          </div>
          <span className={`w-20 text-[12px] font-medium capitalize ${STATUS_STYLE[s.currentStatus] ?? 'text-zinc-500'}`}>{s.currentStatus}</span>
          <ServiceRowActions service={s} />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Use it in the page** — modify `apps/web/app/(app)/services/page.tsx` so the non-empty branch renders `<ServicesLiveList initial={services} />` instead of the inline `<ul>`. Keep the header, empty state, and data-unavailable state from Slice A unchanged. (Read the current page first; replace only the list rendering.)

- [ ] **Step 3: Verify**

Run: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run lint -w @beacon/web`
Expected: clean. Manual (later, by the human): with both apps + worker running and signed in, a status flip updates a card without refresh.

- [ ] **Step 4: Commit (request approval first)**

```bash
git add apps/web/components/services/services-live-list.tsx "apps/web/app/(app)/services/page.tsx"
git commit -m "feat(web): live-updating services dashboard list"
```

---

### Task 13: Service detail page

**Files:**
- Create: `apps/web/app/(app)/services/[serviceId]/page.tsx`, `apps/web/components/services/service-status-live.tsx`

**Interfaces:**
- Consumes: `fetchService`, `fetchServiceChecks`, `currentUser`, `useServiceStatusSubscription`.
- Produces: a Server Component detail page (service header + recent check history) with a client `ServiceStatusLive` header that subscribes to `service:<id>` and updates the status live.

- [ ] **Step 1: Implement the live status header** — `apps/web/components/services/service-status-live.tsx`

```tsx
'use client';

import { useCallback, useState } from 'react';
import { useServiceStatusSubscription } from '@/lib/use-ws';
import type { ServiceStatus, WsEvent } from '@beacon/shared';

const STATUS_STYLE: Record<string, string> = {
  up: 'text-emerald-600', down: 'text-red-600', degraded: 'text-amber-600', paused: 'text-zinc-400', pending: 'text-zinc-400',
};

export function ServiceStatusLive({ serviceId, initialStatus }: { serviceId: string; initialStatus: ServiceStatus }) {
  const [status, setStatus] = useState<ServiceStatus>(initialStatus);
  const onEvent = useCallback((e: WsEvent) => {
    if (e.type === 'service.status_changed' && e.serviceId === serviceId) setStatus(e.status);
  }, [serviceId]);
  useServiceStatusSubscription(`service:${serviceId}`, onEvent);
  return <span className={`text-sm font-semibold capitalize ${STATUS_STYLE[status] ?? 'text-zinc-500'}`}>{status}</span>;
}
```

- [ ] **Step 2: Implement the detail page** — `apps/web/app/(app)/services/[serviceId]/page.tsx`

> Confirm the Next.js 16 dynamic-route `params` API (sync vs `await params`) in `node_modules/next/dist/docs/` — Next 16 may require `await params`.

```tsx
import { notFound } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { fetchService, fetchServiceChecks } from '@/lib/services-api';
import { ServiceStatusLive } from '@/components/services/service-status-live';

const CHECK_STYLE: Record<string, string> = {
  success: 'text-emerald-600', failure: 'text-red-600', timeout: 'text-amber-600', error: 'text-red-600',
};

export default async function ServiceDetailPage({ params }: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await params;
  const user = await currentUser();
  if (!user) notFound();
  const service = await fetchService(user.id, serviceId);
  if (!service) notFound();
  const checks = await fetchServiceChecks(user.id, serviceId, 50);

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div>
          <h1 className="text-sm font-semibold text-zinc-900">{service.name}</h1>
          <p className="font-mono text-[11px] text-zinc-400">{service.baseUrl}{service.healthCheckPath}</p>
        </div>
        <ServiceStatusLive serviceId={service.id} initialStatus={service.currentStatus} />
      </div>

      <div className="px-5 py-3">
        <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">Recent checks</h2>
        {checks.length === 0 ? (
          <p className="text-[12px] text-zinc-400">No checks yet — the worker will run one within a few seconds.</p>
        ) : (
          <ul className="divide-y divide-zinc-200/40">
            {checks.map((ck) => (
              <li key={ck.id} className="flex items-center gap-4 py-1.5 text-[12px]">
                <span className={`w-16 font-medium capitalize ${CHECK_STYLE[ck.status] ?? 'text-zinc-500'}`}>{ck.status}</span>
                <span className="w-12 font-mono tabular-nums text-zinc-500">{ck.statusCode ?? '—'}</span>
                <span className="w-16 font-mono tabular-nums text-zinc-500">{ck.responseTimeMs != null ? `${ck.responseTimeMs}ms` : '—'}</span>
                <span className="flex-1 font-mono text-zinc-400">{new Date(ck.checkedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify**

Run: `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run lint -w @beacon/web`
Expected: clean. Engage the frontend-design skill for a visual pass on the detail page.

- [ ] **Step 4: Commit (request approval first)**

```bash
git add "apps/web/app/(app)/services/[serviceId]/page.tsx" apps/web/components/services/service-status-live.tsx
git commit -m "feat(web): service detail page with live status header and check history"
```

---

### Task 14: Worker cleanup tick + docs + full verify

**Files:**
- Modify: `apps/server/src/workers/check-worker.ts`, `docs/INFRASTRUCTURE.md`

**Interfaces:**
- Consumes: `deleteChecksOlderThan`.
- Produces: the worker runs `deleteChecksOlderThan(30)` at most once per 24h, logging the count.

- [ ] **Step 1: Add the cleanup tick** — in `apps/server/src/workers/check-worker.ts`, add near the loop (module scope):

```ts
import { deleteChecksOlderThan, findDueServices } from '../db/repositories/services';
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;
```

And inside `runWorker`, in the poll cycle (after processing due services), add:

```ts
      if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
        lastCleanupAt = Date.now();
        try {
          const removed = await deleteChecksOlderThan(30);
          if (removed > 0) console.log(`[beacon-worker] pruned ${removed} old service_checks`);
        } catch (err) {
          console.error('[beacon-worker] cleanup failed', err);
        }
      }
```

(Merge the import with the existing `findDueServices` import.)

- [ ] **Step 2: Document** — add to `docs/INFRASTRUCTURE.md` (near the WS / app description):

```markdown
### Real-time (WebSockets)

The API host also serves a WebSocket endpoint at `wss://api.beacon.thiluxan.com/ws` (Caddy upgrades it automatically; no extra Caddy config). Clients authenticate with their Clerk session token (`?token=`), verified server-side via `@clerk/backend`. Status changes reach clients through Postgres `LISTEN/NOTIFY`: the worker emits `pg_notify('beacon_events', …)` on a status change, the server's dedicated `LISTEN` connection relays it to subscribed sockets. New env: `NEXT_PUBLIC_WS_URL` (web) and `CLERK_SECRET_KEY` (server). The worker also prunes `service_checks` older than 30 days once a day.
```

- [ ] **Step 3: Full regression verify**

Run (Postgres up):
`$SERVER_ENV npm run typecheck && NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm run typecheck -w @beacon/web && $SERVER_ENV npm run lint && $SERVER_ENV NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws npm test`
Expected: all clean/green (Slice A suite + the new WS/notify/checks tests).

- [ ] **Step 4: Commit (request approval first)**

```bash
git add apps/server/src/workers/check-worker.ts docs/INFRASTRUCTURE.md
git commit -m "feat(server): daily service_checks cleanup in worker; document realtime/ws"
```

---

## Notes for the executor

- The integration capstone tasks are 7 (LISTEN relay), 8 (real ws round-trip), and 3 (txn-atomic notify) — these prove the cross-process path end to end against a real Postgres + a real `ws` socket. The browser singleton's full connect is exercised manually; only its backoff is unit-tested.
- `applyCheckResult` stays the single status-write seam — the `pg_notify` lives there (Task 3), nowhere else.
- New server env `CLERK_SECRET_KEY` must be in every server test/typecheck command from Task 2 onward; new web env `NEXT_PUBLIC_WS_URL` in every web command.
- Production needs no extra human env step: `CLERK_SECRET_KEY` is already in `/opt/beacon/.env`, and `NEXT_PUBLIC_WS_URL` is baked into the web image by the deploy-workflow build-arg added in Task 2. Unlike Slice A, this slice adds **no new Compose service** (the WS lives in the existing `server` process; Caddy already upgrades `/ws`), so no compose-file copy to the VPS is required — the normal push-to-main deploy is sufficient.
- Approval gate: per `CLAUDE.md`, pause for the human's approval before every `git add`/`git commit`.
```
