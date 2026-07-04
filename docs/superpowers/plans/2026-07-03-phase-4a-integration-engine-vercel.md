# Phase 4a — Integration Engine + Vercel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the integration layer end-to-end with Vercel as the first concrete integration, visible on the service detail page.

**Architecture:** An AES-256-GCM credential-encryption helper + a `service_integrations` table; an `IntegrationDefinition` object-literal interface with a registry `Map`; a Vercel integration file; a second worker loop that periodically decrypts credentials and calls `fetchData`, persisting snapshots; ownership-scoped attach/list/remove API routes; and a purpose-built Vercel attach form + a card on the service detail page.

**Tech Stack:** Node + Hono, Drizzle + Postgres, Zod, `node:crypto`, native `fetch`, Next.js 16 (App Router), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-phase-4a-integration-engine-vercel-design.md`

## Global Constraints

- TypeScript strict; no `any` (use `unknown` + narrow). Prefer `type` over `interface` except the integration contract.
- Zod schemas are the source of truth; derive types with `z.infer`. DB types via Drizzle `$inferSelect`/`$inferInsert`.
- All DB access through `apps/server/src/db/repositories/`. No raw Drizzle in routes/workers/components.
- Timestamps are `timestamptz`, server clock UTC.
- **Credentials are never logged and never returned to the client.** Only metadata (config, snapshot, lastError) leaves the server.
- Background workers never crash the process on a single failure — catch, record, continue.
- New env vars added to `apps/server/src/lib/env.ts` **and** `apps/server/.env.example`.
- Server test/typecheck env prefix (all commands below assume it):
  `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon WEB_ORIGIN=http://localhost:3000 INTERNAL_API_SECRET=test-internal-secret-at-least-32-characters CLERK_SECRET_KEY=sk_test_x INTEGRATIONS_ENCRYPTION_KEY=<base64-32-bytes>`
  Generate a test key once: `openssl rand -base64 32` (e.g. `zZk9…`). `vitest.config.ts` injects env for tests — Task 1 adds the key there so most commands don't need the inline prefix.
- Local Postgres must be up for Tasks 2, 4, 5 (integration tests): `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`.
- Conventional commits; run `npm run typecheck` before each commit.

---

### Task 1: Encryption key env + AES-256-GCM crypto helper

**Files:**
- Create: `apps/server/src/lib/crypto.ts`
- Create: `apps/server/src/lib/crypto.test.ts`
- Modify: `apps/server/src/lib/env.ts`
- Modify: `apps/server/vitest.config.ts` (inject the key for tests)
- Modify: `apps/server/src/lib/env.test.ts` (add key to the base fixture)
- Modify: `apps/server/.env.example`

**Interfaces:**
- Produces: `encrypt(plaintext: string): string`, `decrypt(blob: string): string` (both in `lib/crypto.ts`); `env.INTEGRATIONS_ENCRYPTION_KEY: string`.

- [ ] **Step 1: Add the env var to the schema**

In `apps/server/src/lib/env.ts`, add to `EnvSchema` (after `CLERK_SECRET_KEY`):

```ts
  // base64-encoded 32 bytes (openssl rand -base64 32). Used for AES-256-GCM
  // encryption of integration credentials at rest.
  INTEGRATIONS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'must be base64-encoded 32 bytes'),
```

- [ ] **Step 2: Inject the key into the test env and fixtures**

In `apps/server/vitest.config.ts`, add `INTEGRATIONS_ENCRYPTION_KEY` to the injected `env` block next to `CLERK_SECRET_KEY` (read the file first to match its exact shape):

```ts
INTEGRATIONS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 zero bytes, base64
```

In `apps/server/src/lib/env.test.ts`, add the same key to the `base` fixture object (alongside `CLERK_SECRET_KEY`) so `loadEnv(base)` still succeeds.

- [ ] **Step 3: Write the failing crypto test**

Create `apps/server/src/lib/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from './crypto';

describe('crypto (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const secret = JSON.stringify({ apiToken: 'tok_123' });
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces a different blob each time (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('throws when the ciphertext is tampered', () => {
    const blob = encrypt('hello');
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a byte of the ciphertext/tag
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- crypto`
Expected: FAIL — `Cannot find module './crypto'`.

- [ ] **Step 5: Implement `crypto.ts`**

Create `apps/server/src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env';

const KEY = Buffer.from(env.INTEGRATIONS_ENCRYPTION_KEY, 'base64');
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt a UTF-8 string → base64("iv | authTag | ciphertext"). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverse of encrypt(). Throws if the auth tag does not verify. */
export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- crypto env`
Expected: PASS (crypto 3/3; env tests still green).

- [ ] **Step 7: Document the env var**

In `apps/server/.env.example`, add:

```
# Base64-encoded 32 bytes for integration-credential encryption. Generate with: openssl rand -base64 32
INTEGRATIONS_ENCRYPTION_KEY=
```

Also append `INTEGRATIONS_ENCRYPTION_KEY=<a real base64-32 key>` to your local `apps/server/.env` so the server/worker can start.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck -w @beacon/server`
Expected: exit 0.

```bash
git add apps/server/src/lib/crypto.ts apps/server/src/lib/crypto.test.ts apps/server/src/lib/env.ts apps/server/src/lib/env.test.ts apps/server/vitest.config.ts apps/server/.env.example
git commit -m "feat(server): AES-256-GCM credential crypto + INTEGRATIONS_ENCRYPTION_KEY env"
```

---

### Task 2: `service_integrations` schema + migration + repository

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/repositories/service-integrations.ts`
- Create: `apps/server/src/db/repositories/service-integrations.test.ts`

**Interfaces:**
- Consumes: `getService(userId, id)` from `repositories/services.ts` (ownership check).
- Produces (from `repositories/service-integrations.ts`):
  - `upsertIntegration(args: { serviceId: string; integrationId: string; config: Record<string, unknown>; credentialsEncrypted: string }): Promise<ServiceIntegration>`
  - `listIntegrations(userId: string, serviceId: string): Promise<ServiceIntegration[]>`
  - `getIntegration(userId: string, serviceId: string, integrationId: string): Promise<ServiceIntegration | null>`
  - `deleteIntegration(userId: string, serviceId: string, integrationId: string): Promise<boolean>`
  - `findDueIntegrations(olderThanMs: number, limit: number): Promise<ServiceIntegration[]>`
  - `recordFetchSuccess(id: string, snapshot: Record<string, unknown>): Promise<void>`
  - `recordFetchError(id: string, error: string): Promise<void>`
  - type `ServiceIntegration = typeof serviceIntegrations.$inferSelect`

- [ ] **Step 1: Add the table to the schema**

In `apps/server/src/db/schema.ts`, add `jsonb` and `uniqueIndex` to the `drizzle-orm/pg-core` import, then append:

```ts
export const serviceIntegrations = pgTable(
  'service_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastSnapshot: jsonb('last_snapshot').$type<Record<string, unknown>>(),
    lastError: text('last_error'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_integrations_service_integration_idx').on(t.serviceId, t.integrationId),
    index('service_integrations_due_idx').on(t.enabled, t.lastFetchedAt),
  ],
);

export type ServiceIntegration = typeof serviceIntegrations.$inferSelect;
export type NewServiceIntegration = typeof serviceIntegrations.$inferInsert;
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run db:generate -w @beacon/server`
Expected: a new file under `apps/server/drizzle/` creating `service_integrations`.

Run: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres` then `npm run db:migrate -w @beacon/server`
Expected: `[beacon-server] migrations applied`.

- [ ] **Step 3: Write the failing repository test**

Create `apps/server/src/db/repositories/service-integrations.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { createService } from './services';
import {
  upsertIntegration,
  listIntegrations,
  getIntegration,
  deleteIntegration,
  findDueIntegrations,
  recordFetchSuccess,
  recordFetchError,
} from './service-integrations';

const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };

describe('service-integrations repository', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('upserts (one row per service+integration) and lists with ownership', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_i', email: 'i@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p1' }, credentialsEncrypted: 'enc1' });
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p2' }, credentialsEncrypted: 'enc2' });
    const rows = await listIntegrations(u.id, svc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config).toEqual({ projectId: 'p2' });
    expect(rows[0]!.credentialsEncrypted).toBe('enc2');
  });

  it('getIntegration returns null for a non-owner', async () => {
    const owner = await upsertFromClerk({ clerkUserId: 'u_own', email: 'o@e.com' });
    const other = await upsertFromClerk({ clerkUserId: 'u_oth', email: 'x@e.com' });
    const svc = await createService(owner.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    expect(await getIntegration(other.id, svc.id, 'vercel')).toBeNull();
    expect(await getIntegration(owner.id, svc.id, 'vercel')).not.toBeNull();
  });

  it('records fetch success and error, and finds due rows', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_due', email: 'd@e.com' });
    const svc = await createService(u.id, svcInput);
    const row = await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    // never-fetched rows are due
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).toContain(row.id);
    await recordFetchSuccess(row.id, { deployments: [] });
    const after = await getIntegration(u.id, svc.id, 'vercel');
    expect(after!.lastSnapshot).toEqual({ deployments: [] });
    expect(after!.lastError).toBeNull();
    // just-fetched rows are no longer due
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).not.toContain(row.id);
    await recordFetchError(row.id, 'boom');
    expect((await getIntegration(u.id, svc.id, 'vercel'))!.lastError).toBe('boom');
  });

  it('deleteIntegration removes only the owner\'s row', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_del', email: 'del@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    expect(await deleteIntegration(u.id, svc.id, 'vercel')).toBe(true);
    expect(await listIntegrations(u.id, svc.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- service-integrations`
Expected: FAIL — `Cannot find module './service-integrations'`.

- [ ] **Step 5: Implement the repository**

Create `apps/server/src/db/repositories/service-integrations.ts`:

```ts
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../index';
import { serviceIntegrations, services, type ServiceIntegration } from '../schema';
import { getService } from './services';

export type { ServiceIntegration };

export async function upsertIntegration(args: {
  serviceId: string;
  integrationId: string;
  config: Record<string, unknown>;
  credentialsEncrypted: string;
}): Promise<ServiceIntegration> {
  const rows = await db
    .insert(serviceIntegrations)
    .values({
      serviceId: args.serviceId,
      integrationId: args.integrationId,
      config: args.config,
      credentialsEncrypted: args.credentialsEncrypted,
    })
    .onConflictDoUpdate({
      target: [serviceIntegrations.serviceId, serviceIntegrations.integrationId],
      set: {
        config: args.config,
        credentialsEncrypted: args.credentialsEncrypted,
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertIntegration: no row returned');
  return row;
}

export async function listIntegrations(userId: string, serviceId: string): Promise<ServiceIntegration[]> {
  if (!(await getService(userId, serviceId))) return [];
  return db.select().from(serviceIntegrations).where(eq(serviceIntegrations.serviceId, serviceId));
}

export async function getIntegration(
  userId: string,
  serviceId: string,
  integrationId: string,
): Promise<ServiceIntegration | null> {
  if (!(await getService(userId, serviceId))) return null;
  const rows = await db
    .select()
    .from(serviceIntegrations)
    .where(and(eq(serviceIntegrations.serviceId, serviceId), eq(serviceIntegrations.integrationId, integrationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteIntegration(userId: string, serviceId: string, integrationId: string): Promise<boolean> {
  if (!(await getService(userId, serviceId))) return false;
  const rows = await db
    .delete(serviceIntegrations)
    .where(and(eq(serviceIntegrations.serviceId, serviceId), eq(serviceIntegrations.integrationId, integrationId)))
    .returning({ id: serviceIntegrations.id });
  return rows.length > 0;
}

/** Enabled integrations never fetched, or last fetched more than `olderThanMs` ago. */
export async function findDueIntegrations(olderThanMs: number, limit: number): Promise<ServiceIntegration[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .select()
    .from(serviceIntegrations)
    .where(
      and(
        eq(serviceIntegrations.enabled, true),
        or(isNull(serviceIntegrations.lastFetchedAt), lt(serviceIntegrations.lastFetchedAt, cutoff)),
      ),
    )
    .limit(limit);
}

export async function recordFetchSuccess(id: string, snapshot: Record<string, unknown>): Promise<void> {
  await db
    .update(serviceIntegrations)
    .set({ lastSnapshot: snapshot, lastFetchedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(serviceIntegrations.id, id));
}

export async function recordFetchError(id: string, error: string): Promise<void> {
  await db
    .update(serviceIntegrations)
    .set({ lastError: error, lastFetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(serviceIntegrations.id, id));
}
```

> Note: `services` and `sql` may be unused imports — remove any the linter flags.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- service-integrations`
Expected: PASS (4/4).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck -w @beacon/server`

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/db/repositories/service-integrations.ts apps/server/src/db/repositories/service-integrations.test.ts
git commit -m "feat(server): service_integrations table + repository"
```

---

### Task 3: IntegrationDefinition interface + Vercel integration + registry

**Files:**
- Create: `apps/server/src/integrations/types.ts`
- Create: `apps/server/src/integrations/vercel.ts`
- Create: `apps/server/src/integrations/registry.ts`
- Create: `apps/server/src/integrations/vercel.test.ts`
- Modify: `CLAUDE.md` (update the integration-interface wording)

**Interfaces:**
- Produces:
  - `IntegrationDefinition<Creds, Config>` and `IntegrationDataSnapshot` (in `types.ts`)
  - `vercelIntegration: IntegrationDefinition<VercelCredentials, VercelConfig>` with `id: 'vercel'` (in `vercel.ts`)
  - `IntegrationRegistry: Map<string, IntegrationDefinition>` (in `registry.ts`)

- [ ] **Step 1: Define the interface**

Create `apps/server/src/integrations/types.ts`:

```ts
import type { z } from 'zod';

/** Loose per-integration payload; stored as JSONB and rendered by per-integration UI. */
export type IntegrationDataSnapshot = Record<string, unknown>;

export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  testCredentials(credentials: Creds): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
```

- [ ] **Step 2: Write the failing Vercel test**

Create `apps/server/src/integrations/vercel.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vercelIntegration } from './vercel';

const creds = { apiToken: 'tok_abc' };
const config = { projectId: 'prj_1' };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

describe('vercelIntegration', () => {
  it('validates credentials and config schemas', () => {
    expect(vercelIntegration.credentialsSchema.safeParse(creds).success).toBe(true);
    expect(vercelIntegration.credentialsSchema.safeParse({}).success).toBe(false);
    expect(vercelIntegration.configSchema.safeParse(config).success).toBe(true);
    expect(vercelIntegration.configSchema.safeParse({}).success).toBe(false);
  });

  it('testCredentials ok on 200', async () => {
    stubFetch(() => new Response('{"projects":[]}', { status: 200 }));
    expect(await vercelIntegration.testCredentials(creds)).toEqual({ ok: true });
  });

  it('testCredentials error on 401', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }));
    const r = await vercelIntegration.testCredentials(creds);
    expect(r.ok).toBe(false);
  });

  it('fetchData maps deployments into a snapshot', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          deployments: [
            { uid: 'd1', url: 'app.vercel.app', state: 'READY', target: 'production', createdAt: 1710000000000, meta: { githubCommitSha: 'abc123', githubCommitMessage: 'ship it' } },
          ],
        }),
        { status: 200 },
      ),
    );
    const snap = await vercelIntegration.fetchData(creds, config);
    expect(Array.isArray(snap.deployments)).toBe(true);
    expect((snap.deployments as unknown[]).length).toBe(1);
    expect(snap.productionStatus).toBe('READY');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- vercel`
Expected: FAIL — `Cannot find module './vercel'`.

- [ ] **Step 4: Implement the Vercel integration**

> Before writing, confirm the current Vercel REST endpoints/fields with Context7 (`/v2/projects`, `/v6/deployments`). The shapes below match Vercel's documented responses as of this plan.

Create `apps/server/src/integrations/vercel.ts`:

```ts
import { z } from 'zod';
import type { IntegrationDataSnapshot, IntegrationDefinition } from './types';

const VercelCredentialsSchema = z.object({ apiToken: z.string().min(1) });
const VercelConfigSchema = z.object({ projectId: z.string().min(1), teamId: z.string().optional() });

export type VercelCredentials = z.infer<typeof VercelCredentialsSchema>;
export type VercelConfig = z.infer<typeof VercelConfigSchema>;

const API = 'https://api.vercel.com';

function teamQuery(teamId?: string): string {
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
}

export const vercelIntegration: IntegrationDefinition<VercelCredentials, VercelConfig> = {
  id: 'vercel',
  name: 'Vercel',
  credentialsSchema: VercelCredentialsSchema,
  configSchema: VercelConfigSchema,

  async testCredentials(credentials) {
    try {
      const res = await fetch(`${API}/v2/projects?limit=1`, {
        headers: { Authorization: `Bearer ${credentials.apiToken}` },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Vercel returned ${res.status}` };
    } catch {
      return { ok: false, error: 'Could not reach Vercel' };
    }
  },

  async fetchData(credentials, config) {
    const url = `${API}/v6/deployments?projectId=${encodeURIComponent(config.projectId)}&limit=5${teamQuery(config.teamId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${credentials.apiToken}` } });
    if (!res.ok) throw new Error(`Vercel deployments returned ${res.status}`);
    const body = (await res.json()) as { deployments?: unknown[] };
    const raw = Array.isArray(body.deployments) ? body.deployments : [];
    const deployments = raw.map((d) => {
      const dep = d as Record<string, unknown>;
      const meta = (dep.meta as Record<string, unknown> | undefined) ?? {};
      return {
        state: String(dep.state ?? 'UNKNOWN'),
        target: (dep.target as string | null) ?? null,
        url: (dep.url as string | null) ?? null,
        createdAt: typeof dep.createdAt === 'number' ? new Date(dep.createdAt).toISOString() : null,
        commitSha: (meta.githubCommitSha as string | undefined) ?? null,
        commitMessage: (meta.githubCommitMessage as string | undefined) ?? null,
      };
    });
    const production = deployments.find((d) => d.target === 'production');
    const snapshot: IntegrationDataSnapshot = {
      deployments,
      productionStatus: production?.state ?? null,
      fetchedAt: new Date().toISOString(),
    };
    return snapshot;
  },
};
```

- [ ] **Step 5: Create the registry**

Create `apps/server/src/integrations/registry.ts`:

```ts
import type { IntegrationDefinition } from './types';
import { vercelIntegration } from './vercel';

// Add new integrations here — one import + one entry. That is the whole point.
export const IntegrationRegistry: Map<string, IntegrationDefinition> = new Map([
  [vercelIntegration.id, vercelIntegration as IntegrationDefinition],
]);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- vercel`
Expected: PASS (4/4).

- [ ] **Step 7: Update CLAUDE.md wording**

In `CLAUDE.md`, in the "Integrations" conventions section, change the line describing each integration as "a class implementing the `MonitoringIntegration` interface" to reflect the object-literal shape:

> Each integration is an object implementing the `IntegrationDefinition` interface in `apps/server/src/integrations/types.ts`. One file per integration; register it in `IntegrationRegistry` (`registry.ts`) with a single map entry.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck -w @beacon/server`

```bash
git add apps/server/src/integrations CLAUDE.md
git commit -m "feat(server): IntegrationDefinition interface, Vercel integration, registry"
```

---

### Task 4: Integration worker (second loop in the existing process)

**Files:**
- Create: `apps/server/src/workers/integration-worker.ts`
- Create: `apps/server/src/workers/integration-worker.test.ts`
- Modify: `apps/server/src/workers/index.ts`

**Interfaces:**
- Consumes: `findDueIntegrations`, `recordFetchSuccess`, `recordFetchError` (repo); `decrypt` (crypto); `IntegrationRegistry` (registry).
- Produces:
  - `processDueIntegrations(deps?: { registry?: Map<string, IntegrationDefinition> }): Promise<void>` — one pass over due integrations.
  - `runIntegrationWorker(): Promise<never>` — the loop.

- [ ] **Step 1: Write the failing worker test**

Create `apps/server/src/workers/integration-worker.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pool } from '../db/index';
import { upsertFromClerk } from '../db/repositories/users';
import { createService } from '../db/repositories/services';
import { upsertIntegration, getIntegration } from '../db/repositories/service-integrations';
import { encrypt } from '../lib/crypto';
import type { IntegrationDefinition } from '../integrations/types';
import { processDueIntegrations } from './integration-worker';

const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };

function fakeDef(behavior: 'ok' | 'throw'): IntegrationDefinition {
  return {
    id: 'faker',
    name: 'Faker',
    credentialsSchema: z.object({ apiToken: z.string() }),
    configSchema: z.object({}),
    async testCredentials() { return { ok: true }; },
    async fetchData() {
      if (behavior === 'throw') throw new Error('kaboom');
      return { ok: 1 };
    },
  };
}

describe('processDueIntegrations', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  async function seed(): Promise<{ userId: string; serviceId: string }> {
    const u = await upsertFromClerk({ clerkUserId: 'u_w', email: 'w@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'faker', config: {}, credentialsEncrypted: encrypt(JSON.stringify({ apiToken: 't' })) });
    return { userId: u.id, serviceId: svc.id };
  }

  it('persists a snapshot on success', async () => {
    const { userId, serviceId } = await seed();
    await processDueIntegrations({ registry: new Map([['faker', fakeDef('ok')]]) });
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastSnapshot).toEqual({ ok: 1 });
    expect(row!.lastError).toBeNull();
  });

  it('records last_error on failure without throwing', async () => {
    const { userId, serviceId } = await seed();
    await expect(processDueIntegrations({ registry: new Map([['faker', fakeDef('throw')]]) })).resolves.toBeUndefined();
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastError).toContain('kaboom');
  });

  it('skips integrations whose id is not in the registry', async () => {
    const { userId, serviceId } = await seed();
    await processDueIntegrations({ registry: new Map() }); // faker not registered
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastSnapshot).toBeNull();
    expect(row!.lastError).toContain('Unknown integration');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- integration-worker`
Expected: FAIL — `Cannot find module './integration-worker'`.

- [ ] **Step 3: Implement the worker**

Create `apps/server/src/workers/integration-worker.ts`:

```ts
import { findDueIntegrations, recordFetchError, recordFetchSuccess } from '../db/repositories/service-integrations';
import { IntegrationRegistry } from '../integrations/registry';
import type { IntegrationDefinition } from '../integrations/types';
import { decrypt } from '../lib/crypto';

const DUE_AFTER_MS = 5 * 60_000; // fetch each integration at most every 5 minutes
const POLL_INTERVAL_MS = 60_000; // wake once a minute to find due work
const BATCH = 20;

export async function processDueIntegrations(
  deps: { registry?: Map<string, IntegrationDefinition> } = {},
): Promise<void> {
  const registry = deps.registry ?? IntegrationRegistry;
  const due = await findDueIntegrations(DUE_AFTER_MS, BATCH);
  for (const row of due) {
    try {
      const def = registry.get(row.integrationId);
      if (!def) {
        await recordFetchError(row.id, `Unknown integration '${row.integrationId}'`);
        continue;
      }
      const credentials = def.credentialsSchema.parse(JSON.parse(decrypt(row.credentialsEncrypted)));
      const config = def.configSchema.parse(row.config);
      const snapshot = await def.fetchData(credentials, config);
      await recordFetchSuccess(row.id, snapshot);
    } catch (err) {
      // Never let one integration's failure stop the batch.
      const msg = err instanceof Error ? err.message : 'fetch failed';
      await recordFetchError(row.id, msg).catch(() => undefined);
    }
  }
}

export async function runIntegrationWorker(): Promise<never> {
  for (;;) {
    try {
      await processDueIntegrations();
    } catch (err) {
      console.error('[beacon-worker] integration pass failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- integration-worker`
Expected: PASS (3/3).

- [ ] **Step 5: Wire the loop into the worker process**

Modify `apps/server/src/workers/index.ts` to start both loops independently:

```ts
import 'dotenv/config';
import './../lib/env'; // validate env at startup
import { runWorker } from './check-worker';
import { runIntegrationWorker } from './integration-worker';

console.log('[beacon-worker] starting check loop');
void runWorker().catch((err) => console.error('[beacon-worker] check loop crashed', err));

console.log('[beacon-worker] starting integration loop');
void runIntegrationWorker().catch((err) => console.error('[beacon-worker] integration loop crashed', err));
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck -w @beacon/server`

```bash
git add apps/server/src/workers/integration-worker.ts apps/server/src/workers/integration-worker.test.ts apps/server/src/workers/index.ts
git commit -m "feat(server): integration fetch worker loop"
```

---

### Task 5: Attach/list/remove API routes

**Files:**
- Modify: `apps/server/src/router.ts`
- Create: `apps/server/src/router.integrations.test.ts`

**Interfaces:**
- Consumes: `IntegrationRegistry`, `encrypt`, `upsertIntegration`, `listIntegrations`, `deleteIntegration`, `getService`.
- Produces routes:
  - `POST /internal/services/:id/integrations` body `{ integrationId, config, credentials }` → 201 `{ integrationId, config, enabled, lastFetchedAt, lastError, snapshot }`
  - `GET /internal/services/:id/integrations` → `{ integrations: [...] }` (no credentials)
  - `DELETE /internal/services/:id/integrations/:integrationId` → 204

- [ ] **Step 1: Write the failing route test**

Create `apps/server/src/router.integrations.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { createService } from './db/repositories/services';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();
const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };
const H = (clerk: string) => ({ 'content-type': 'application/json', 'x-internal-secret': SECRET, 'x-clerk-user-id': clerk });

afterEach(() => vi.unstubAllGlobals());
function stubFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status }))));
}

describe('integration routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  async function ownedService(clerk = 'u_ir'): Promise<string> {
    const u = await upsertFromClerk({ clerkUserId: clerk, email: `${clerk}@e.com` });
    return (await createService(u.id, svcInput)).id;
  }

  it('attaches a valid Vercel integration (credentials never returned)', async () => {
    stubFetch(200); // testCredentials -> ok
    const id = await ownedService();
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST',
      headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.integrationId).toBe('vercel');
    expect(body.config).toEqual({ projectId: 'p1' });
    expect(JSON.stringify(body)).not.toContain('tok'); // no credential leakage
  });

  it('rejects when testCredentials fails and saves nothing', async () => {
    stubFetch(401);
    const id = await ownedService();
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'bad' } }),
    });
    expect(res.status).toBe(400);
    const list = await app.request(`/internal/services/${id}/integrations`, { headers: H('u_ir') });
    expect((await list.json()).integrations).toHaveLength(0);
  });

  it('401 without the internal secret', async () => {
    const res = await app.request('/internal/services/x/integrations', { headers: { 'x-clerk-user-id': 'u_ir' } });
    expect(res.status).toBe(401);
  });

  it('404 when the service is not owned', async () => {
    stubFetch(200);
    const id = await ownedService('u_owner');
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_other'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    // u_other must exist for resolveUserId; create then attempt
    await upsertFromClerk({ clerkUserId: 'u_other', email: 'o@e.com' });
    const res2 = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_other'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    expect(res2.status).toBe(404);
  });

  it('deletes an integration', async () => {
    stubFetch(200);
    const id = await ownedService();
    await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    const del = await app.request(`/internal/services/${id}/integrations/vercel`, { method: 'DELETE', headers: H('u_ir') });
    expect(del.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- router.integrations`
Expected: FAIL (routes 404 / not implemented).

- [ ] **Step 3: Implement the routes**

In `apps/server/src/router.ts`, add imports:

```ts
import { z } from 'zod';
import { IntegrationRegistry } from './integrations/registry';
import { encrypt } from './lib/crypto';
import { upsertIntegration, listIntegrations, deleteIntegration } from './db/repositories/service-integrations';
import type { ServiceIntegration } from './db/repositories/service-integrations';
```

Add a serializer (near the top of `createRouter`) and the three routes (after the `/checks` route). Credentials are never included:

```ts
  const AttachSchema = z.object({
    integrationId: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    credentials: z.record(z.string(), z.unknown()),
  });

  function toIntegrationDto(row: ServiceIntegration) {
    return {
      integrationId: row.integrationId,
      config: row.config,
      enabled: row.enabled,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      lastError: row.lastError,
      snapshot: row.lastSnapshot ?? null,
    };
  }

  app.get('/internal/services/:id/integrations', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const rows = await listIntegrations(userId, c.req.param('id'));
    return c.json({ integrations: rows.map(toIntegrationDto) });
  });

  app.post('/internal/services/:id/integrations', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const serviceId = c.req.param('id');
    if (!(await getService(userId, serviceId))) return c.json({ error: 'not found' }, 404);

    const parsed = AttachSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);

    const def = IntegrationRegistry.get(parsed.data.integrationId);
    if (!def) return c.json({ error: 'unknown integration' }, 400);

    const config = def.configSchema.safeParse(parsed.data.config);
    if (!config.success) return c.json({ error: 'invalid config', issues: config.error.issues }, 400);
    const creds = def.credentialsSchema.safeParse(parsed.data.credentials);
    if (!creds.success) return c.json({ error: 'invalid credentials' }, 400);

    const test = await def.testCredentials(creds.data);
    if (!test.ok) return c.json({ error: test.error }, 400);

    const row = await upsertIntegration({
      serviceId,
      integrationId: def.id,
      config: config.data as Record<string, unknown>,
      credentialsEncrypted: encrypt(JSON.stringify(creds.data)),
    });
    return c.json(toIntegrationDto(row), 201);
  });

  app.delete('/internal/services/:id/integrations/:integrationId', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const ok = await deleteIntegration(userId, c.req.param('id'), c.req.param('integrationId'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- router.integrations`
Expected: PASS (5/5).

- [ ] **Step 5: Full server suite + typecheck + commit**

Run: `npm run test -w @beacon/server` then `npm run typecheck -w @beacon/server`
Expected: all green.

```bash
git add apps/server/src/router.ts apps/server/src/router.integrations.test.ts
git commit -m "feat(server): attach/list/remove integration API routes"
```

---

### Task 6: Web integration client + Vercel attach form

**Files:**
- Modify: `apps/web/lib/services-api.ts` (add integration client fns + `IntegrationDto`)
- Modify: `apps/web/app/(app)/services/actions.ts` (add server actions)
- Create: `apps/web/components/services/integration-attach-dialog.tsx`
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx` (render the attach control + pass integrations down — see Task 7 for the card)

> UI tasks: verified by `typecheck` + `lint` + manual smoke (the web app does not unit-test components — follow the existing pattern). No component unit tests.

**Interfaces:**
- Consumes: server routes from Task 5.
- Produces:
  - `IntegrationDto` type + `fetchIntegrations(clerkUserId, serviceId)`, `attachIntegration(clerkUserId, serviceId, body)`, `removeIntegration(clerkUserId, serviceId, integrationId)` in `services-api.ts`.
  - Server actions `attachVercelAction(...)`, `removeIntegrationAction(...)` returning `{ ok: true } | { ok: false; error: string }`.
  - `<IntegrationAttachDialog serviceId=... />` client component.

- [ ] **Step 1: Add the web API client functions**

In `apps/web/lib/services-api.ts`, append:

```ts
export type IntegrationDto = {
  integrationId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastError: string | null;
  snapshot: Record<string, unknown> | null;
};

export async function fetchIntegrations(clerkUserId: string, serviceId: string): Promise<IntegrationDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchIntegrations failed: ${res.status}`);
  return (await res.json()).integrations as IntegrationDto[];
}

export async function attachIntegration(
  clerkUserId: string,
  serviceId: string,
  body: { integrationId: string; config: Record<string, unknown>; credentials: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations`, {
    method: 'POST', headers: headers(clerkUserId), body: JSON.stringify(body), cache: 'no-store',
  });
  if (res.ok) return { ok: true };
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: err.error ?? `Request failed (${res.status})` };
}

export async function removeIntegration(clerkUserId: string, serviceId: string, integrationId: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations/${integrationId}`, {
    method: 'DELETE', headers: headers(clerkUserId), cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) throw new Error(`removeIntegration failed: ${res.status}`);
}
```

- [ ] **Step 2: Add server actions**

In `apps/web/app/(app)/services/actions.ts`, add (match the file's existing `'use server'` + `currentUser()` + `revalidatePath` patterns already used for service actions):

```ts
import { attachIntegration, removeIntegration } from '@/lib/services-api';

export async function attachVercelAction(
  serviceId: string,
  input: { apiToken: string; projectId: string; teamId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in' };
  const config: Record<string, unknown> = { projectId: input.projectId };
  if (input.teamId) config.teamId = input.teamId;
  const res = await attachIntegration(user.id, serviceId, { integrationId: 'vercel', config, credentials: { apiToken: input.apiToken } });
  if (res.ok) revalidatePath(`/services/${serviceId}`);
  return res;
}

export async function removeIntegrationAction(serviceId: string, integrationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in' };
  await removeIntegration(user.id, serviceId, integrationId);
  revalidatePath(`/services/${serviceId}`);
  return { ok: true };
}
```

> If `currentUser`/`revalidatePath` aren't already imported in `actions.ts`, add them (`import { currentUser } from '@clerk/nextjs/server'`, `import { revalidatePath } from 'next/cache'`).

- [ ] **Step 3: Build the attach dialog (client)**

Create `apps/web/components/services/integration-attach-dialog.tsx` — a `'use client'` component with a small form (API token [password], project ID, optional team ID), calling `attachVercelAction` in a transition, showing the returned error inline on failure, and closing on success. Use the existing dialog/input primitives from `apps/web/components/ui` (match `service-form-dialog.tsx`'s structure and styling). Keep it minimal — the design pass is 4b.

- [ ] **Step 4: Render the attach control on the detail page**

In `apps/web/app/(app)/services/[serviceId]/page.tsx`, fetch integrations server-side (`fetchIntegrations(user.id, serviceId)`) and render an "Integrations" section header with `<IntegrationAttachDialog serviceId={serviceId} />`. (The cards themselves are Task 7.)

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/services-api.ts apps/web/app/\(app\)/services/actions.ts apps/web/components/services/integration-attach-dialog.tsx apps/web/app/\(app\)/services/\[serviceId\]/page.tsx
git commit -m "feat(web): integration API client, server actions, Vercel attach form"
```

---

### Task 7: Vercel integration card + render + final verification

**Files:**
- Create: `apps/web/components/services/vercel-integration-card.tsx`
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx` (render cards from fetched integrations)

**Interfaces:**
- Consumes: `IntegrationDto` (Task 6), the Vercel snapshot shape `{ deployments: [{ state, target, url, createdAt, commitSha, commitMessage }], productionStatus, fetchedAt }`.

- [ ] **Step 1: Build the card**

Create `apps/web/components/services/vercel-integration-card.tsx` — a server component taking `{ integration: IntegrationDto }`. Render:
- Header: "Vercel" + a `productionStatus` badge (READY→up token, ERROR→down token, BUILDING→pending token) reusing the existing status token classes.
- If `integration.lastError` and no snapshot: an inline error line ("Couldn't reach Vercel — retrying").
- Else the latest deployments as rows: state dot, `target`, relative `createdAt`, truncated `commitMessage` + short `commitSha`.
- Empty state if `deployments` is empty.
Match the density/typography of the existing service-detail tables. Presentable; the full design pass is 4b.

- [ ] **Step 2: Render cards on the detail page**

In `[serviceId]/page.tsx`, map the fetched integrations to `<VercelIntegrationCard integration={i} />` for `i.integrationId === 'vercel'` (the registry-driven generic rendering comes in 4b). Include a remove control wired to `removeIntegrationAction`.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exit 0.

- [ ] **Step 4: Full-suite regression**

Run (Postgres up): `npm run test -w @beacon/shared && npm run test -w @beacon/server && npm run test -w @beacon/web`
Run: `npm run typecheck && npm run lint` (root, both apps)
Expected: all green.

- [ ] **Step 5: Manual smoke — real Vercel integration (success criterion)**

With the dev stack running (`npm run dev`) and **outbound DNS working** (disconnect the VPN / `wsl --shutdown` first — the integration worker must reach `api.vercel.com`):
1. Open a service's detail page → **Add integration** → enter a **real** Vercel API token + a real `projectId` (e.g. Wayfare or Investor Thesis). Bad credentials must show the error and not save.
2. On success the card appears; within ~5 min the worker populates it with real deployments (or trigger sooner by restarting the worker).

⚠️ If local DNS can't be restored, defer this step to post-deploy verification against production (the VPS has outbound internet).

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/services/vercel-integration-card.tsx apps/web/app/\(app\)/services/\[serviceId\]/page.tsx
git commit -m "feat(web): Vercel integration card on service detail page"
```

---

## Self-Review

**Spec coverage:** §1 data model → Task 2; §2 crypto → Task 1; §3 interface+registry → Task 3; §4 Vercel → Task 3; §5 worker → Task 4; §6 API → Task 5; §7 UI (form + card) → Tasks 6–7; §8 error handling → Tasks 3–5 (testCredentials gate, worker containment, no credential leakage test); §9 testing/DoD → per-task tests + Task 7 regression + real-credential smoke; `CLAUDE.md` wording → Task 3; env var → Task 1.

**Placeholder scan:** UI Tasks 6–7 describe the dialog/card without full JSX — intentional, since the codebase does not unit-test components and the 4b design pass will rework them; the data contracts and wiring are fully specified. All server tasks have complete code.

**Type consistency:** `ServiceIntegration` (Task 2) flows into worker (Task 4), routes (Task 5). `IntegrationDto` (Task 6) matches `toIntegrationDto` (Task 5). Vercel snapshot shape (`deployments`/`productionStatus`, Task 3) matches the card consumer (Task 7) and the worker test's fake. `processDueIntegrations({ registry })` signature consistent between Task 4 impl and test.
