# Phase 1 — Foundation (Local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local npm-workspace monorepo (Next.js 15 web + Hono server + shared package) with Clerk auth, Postgres-via-Docker through Drizzle, and service-CRUD scaffolding, with an excellent local dev experience and no production/VPS work.

**Architecture:** Three workspaces — `apps/web` (Next.js 15 App Router, Tailwind v4, shadcn), `apps/server` (Hono on Node), `packages/shared` (Zod schemas consumed as TS source). The web app owns auth/UI; the server app owns all DB access through Drizzle repositories. The web app reaches the DB only by calling the server's secret-guarded `/internal/users/upsert` endpoint, preserving the "Drizzle lives only in apps/server" invariant.

**Tech Stack:** Node 22, npm workspaces, TypeScript strict, Hono + `@hono/node-server`, Drizzle ORM + `node-postgres`, Postgres 16 (Docker), Next.js 15, Tailwind v4, shadcn/ui, Clerk, Svix, Zod, Vitest, `concurrently`.

## Global Constraints

- **TS strict everywhere.** `strict: true`, no `any` (use `unknown` + narrow). Prefer `type` over `interface`. — copied from CLAUDE.md.
- **No secrets in the repo.** `.env.example` with placeholders only; real values in gitignored files. — CLAUDE.md.
- **All DB access through `apps/server/src/db/repositories/`.** No raw Drizzle in routes/workers/components; Drizzle never imported into `apps/web`. — CLAUDE.md.
- **`timestamptz` always**, server clocks UTC; every table has `id`, `created_at`, `updated_at`. — CLAUDE.md.
- **Zod is the source of truth**; derive types with `z.infer`. DB types via `$inferSelect`/`$inferInsert`. — CLAUDE.md.
- **Env validated by Zod at startup**, split: `apps/server/src/lib/env.ts` (server) and `apps/web/lib/env.client.ts` (`NEXT_PUBLIC_*`). — CLAUDE.md.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `infra:`). — CLAUDE.md.
- **Accent `#27272A` (graphite).** Status palette: up `#3F7D58`, degraded `#C18A1F`, down `#B23A48`, paused `#71717A`. Color only for status. — design spec.
- **Fonts:** Geist Sans + Geist Mono via `geist` package. — design spec (decision C).
- **`@beacon/shared` consumed as TS source** (no build step). — design spec (decision B).
- **Dev orchestration via `concurrently`.** — design spec (decision A).
- **Ports:** web `3000`, server `3001`, Postgres `5432`.
- **Approval workflow:** the human approves before every `git add`/`git commit`. The commit step in each task is a *checkpoint to request approval*, not an instruction to commit unattended. — CLAUDE.md.

### Divergence from spec (intentional, verified 2026-06-26)
- Spec's file tree listed `apps/web/tailwind.config.ts`. Tailwind v4 + current shadcn are **CSS-first**: no `tailwind.config.ts`; tokens live in `app/globals.css` (`@theme`), with `components.json` and `postcss.config.mjs`. The plan uses the v4 layout.

### Library-API verification note
Context7 is not installed in this environment. Before writing non-trivial code against Clerk, Drizzle, Hono, shadcn, or Tailwind, confirm the current API via the library's official docs (WebFetch) — surfaces drift. Clerk middleware + Tailwind v4 setup were verified 2026-06-26 (see Sources at end).

---

## File structure (end state)

```
package.json  tsconfig.base.json  eslint.config.mjs  .prettierrc  .gitignore  .env.example  README.md
infrastructure/docker-compose.dev.yml
packages/shared/{package.json,tsconfig.json,src/index.ts,src/schemas/health.ts,src/schemas/health.test.ts}
apps/server/
  package.json tsconfig.json drizzle.config.ts .env.example vitest.config.ts
  src/index.ts src/router.ts
  src/lib/{env.ts,env.test.ts}
  src/db/{index.ts,schema.ts,repositories/users.ts,repositories/users.test.ts}
  drizzle/  (generated migration)
apps/web/
  package.json tsconfig.json next.config.ts postcss.config.mjs components.json .env.example vitest.config.ts middleware.ts
  app/{layout.tsx,page.tsx,globals.css}
  app/health/page.tsx
  app/(auth)/sign-in/[[...sign-in]]/page.tsx
  app/(auth)/sign-up/[[...sign-up]]/page.tsx
  app/(app)/{layout.tsx,services/page.tsx}
  app/api/clerk/webhook/route.ts
  components/ui/*  (shadcn: button card input label sonner)
  lib/{env.client.ts,api-client.ts,ensure-user-exists.ts,clerk-webhook.ts,clerk-webhook.test.ts}
```

---

## Task 1: Monorepo root scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: npm workspaces `apps/*` + `packages/*`; root scripts `dev`, `typecheck`, `lint`, `format`; `tsconfig.base.json` extended by every workspace.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
.next/
dist/
*.tsbuildinfo
.env
.env.local
.env.production
.env*.local
npm-debug.log*
coverage/
.DS_Store
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "beacon",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "concurrently -n web,server -c blue,green \"npm:dev:web\" \"npm:dev:server\"",
    "dev:web": "npm run dev -w @beacon/web",
    "dev:server": "npm run dev -w @beacon/server",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "format": "prettier --write .",
    "db:generate": "npm run db:generate -w @beacon/server",
    "db:migrate": "npm run db:migrate -w @beacon/server"
  },
  "devDependencies": {
    "concurrently": "^9.1.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 4: Create `.prettierrc`**

```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 5: Create `eslint.config.mjs` (flat config, root)**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 6: Create root `.env.example`**

```bash
# Beacon — root env reference. Real values live in gitignored files.
# Per-app examples:
#   apps/server/.env.example  -> copy to apps/server/.env
#   apps/web/.env.example     -> copy to apps/web/.env.local
# Shared between web & server (must match): INTERNAL_API_SECRET
```

- [ ] **Step 7: Install root dev deps and the lint toolchain**

Run: `npm install -D @eslint/js eslint typescript-eslint`
Then: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 8: Verify typecheck script runs (no workspaces yet → no-op)**

Run: `npm run typecheck`
Expected: exits 0 (no workspaces with the script yet).

- [ ] **Step 9: Commit (request approval first)**

```bash
git add package.json package-lock.json tsconfig.base.json eslint.config.mjs .prettierrc .gitignore .env.example
git commit -m "chore: scaffold npm-workspace monorepo root"
```

---

## Task 2: `packages/shared` with the health schema (TDD)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/schemas/health.ts`
- Test: `packages/shared/src/schemas/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `@beacon/shared` exporting `HealthResponseSchema` (Zod) and `type HealthResponse = { status: 'ok'; service: string; time: string }`. Both web and server import these.

- [ ] **Step 1: Create `packages/shared/package.json`** (consumed as TS source — `exports` point at `src`)

```json
{
  "name": "@beacon/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "vitest": "^2.1.8" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "noEmit": true },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install workspace deps**

Run: `npm install -w @beacon/shared`
Expected: `zod` and `vitest` resolved into the workspace.

- [ ] **Step 4: Write the failing test** — `packages/shared/src/schemas/health.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './health';

describe('HealthResponseSchema', () => {
  it('accepts a valid health response', () => {
    const value = { status: 'ok', service: 'beacon-server', time: '2026-06-26T00:00:00.000Z' };
    expect(HealthResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a wrong status literal', () => {
    expect(() => HealthResponseSchema.parse({ status: 'bad', service: 's', time: 't' })).toThrow();
  });

  it('rejects a missing field', () => {
    expect(() => HealthResponseSchema.parse({ status: 'ok', service: 's' })).toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -w @beacon/shared`
Expected: FAIL — cannot resolve `./health`.

- [ ] **Step 6: Implement `packages/shared/src/schemas/health.ts`**

```ts
import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

- [ ] **Step 7: Implement `packages/shared/src/index.ts`**

```ts
export { HealthResponseSchema, type HealthResponse } from './schemas/health';
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -w @beacon/shared`
Expected: PASS (3 tests).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck -w @beacon/shared`
Expected: exits 0.

- [ ] **Step 10: Commit (request approval first)**

```bash
git add packages/shared package-lock.json
git commit -m "feat(shared): add HealthResponse zod schema and workspace"
```

---

## Task 3: `apps/server` Hono app + env validation + `/health` (TDD)

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/.env.example`, `apps/server/src/index.ts`, `apps/server/src/router.ts`, `apps/server/src/lib/env.ts`
- Test: `apps/server/src/lib/env.test.ts`

**Interfaces:**
- Consumes: `@beacon/shared` `HealthResponseSchema`.
- Produces: `createRouter()` returning a Hono app with `GET /health`; `loadEnv(raw: NodeJS.ProcessEnv)` returning a validated `Env`; module `env` (the validated singleton).

- [ ] **Step 1: Create `apps/server/package.json`**

```json
{
  "name": "@beacon/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@beacon/shared": "*",
    "@hono/node-server": "^1.13.7",
    "drizzle-orm": "^0.38.3",
    "hono": "^4.6.14",
    "pg": "^8.13.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.30.1",
    "tsx": "^4.19.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "noEmit": true,
    "types": ["node"],
    "paths": { "@/*": ["./src/*"] },
    "baseUrl": "."
  },
  "include": ["src/**/*.ts", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Create `apps/server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 4: Create `apps/server/.env.example`**

```bash
DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon
PORT=3001
LOG_LEVEL=info
WEB_ORIGIN=http://localhost:3000
INTERNAL_API_SECRET=changeme-generate-with-openssl-rand-base64-32
```

- [ ] **Step 5: Install workspace deps**

Run: `npm install -w @beacon/server` then `npm install -D -w @beacon/server @types/node`
Expected: deps resolved.

- [ ] **Step 6: Write the failing test** — `apps/server/src/lib/env.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://beacon:beacon@localhost:5432/beacon',
  WEB_ORIGIN: 'http://localhost:3000',
  INTERNAL_API_SECRET: 'a-32-char-minimum-secret-value-1234',
};

describe('loadEnv', () => {
  it('applies defaults for PORT and LOG_LEVEL', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow();
  });

  it('throws when INTERNAL_API_SECRET is too short', () => {
    expect(() => loadEnv({ ...base, INTERNAL_API_SECRET: 'short' })).toThrow();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -w @beacon/server`
Expected: FAIL — cannot resolve `./env`.

- [ ] **Step 8: Implement `apps/server/src/lib/env.ts`**

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEB_ORIGIN: z.string().url(),
  INTERNAL_API_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv(process.env);
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -w @beacon/server`
Expected: PASS (3 tests). (The `env` singleton reads `process.env`; tests call `loadEnv` directly so they don't depend on process env.)

> Note: if importing `./env` in tests triggers the singleton parse against an empty `process.env`, set the three required vars in `apps/server/vitest.config.ts` via `test.env`, or split the singleton into `env.runtime.ts`. Prefer adding `test: { env: { DATABASE_URL: '...', WEB_ORIGIN: '...', INTERNAL_API_SECRET: '...' } }` to the vitest config.

- [ ] **Step 10: Write the failing `/health` test** — `apps/server/src/router.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@beacon/shared';
import { createRouter } from './router';

describe('GET /health', () => {
  it('returns a valid HealthResponse', async () => {
    const app = createRouter();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HealthResponseSchema.parse(body).status).toBe('ok');
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npm test -w @beacon/server`
Expected: FAIL — cannot resolve `./router`.

- [ ] **Step 12: Implement `apps/server/src/router.ts`**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HealthResponse } from '@beacon/shared';

export function createRouter(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'beacon-server',
      time: new Date().toISOString(),
    };
    return c.json(body);
  });

  return app;
}

export function withCors(app: Hono, origin: string): Hono {
  app.use('*', cors({ origin, credentials: true }));
  return app;
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `npm test -w @beacon/server`
Expected: PASS.

- [ ] **Step 14: Implement `apps/server/src/index.ts` (entry)**

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { createRouter } from './router';

const app = new Hono();
app.use('*', cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.route('/', createRouter());

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[beacon-server] listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 15: Manual smoke test**

Run (in `apps/server`, with the three env vars exported): `npm run dev -w @beacon/server`, then `curl -s localhost:3001/health`
Expected: `{"status":"ok","service":"beacon-server","time":"..."}`. Stop the server.

- [ ] **Step 16: Typecheck**

Run: `npm run typecheck -w @beacon/server`
Expected: exits 0.

- [ ] **Step 17: Commit (request approval first)**

```bash
git add apps/server package-lock.json
git commit -m "feat(server): hono app with validated env and /health endpoint"
```

---

## Task 4: Local Postgres (Docker) + Drizzle schema + migration

**Files:**
- Create: `infrastructure/docker-compose.dev.yml`, `apps/server/drizzle.config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/index.ts`, `apps/server/src/db/migrate.ts`
- Generated: `apps/server/drizzle/0000_*.sql` + meta

**Interfaces:**
- Consumes: `env.DATABASE_URL`.
- Produces: `users` table; `db` Drizzle client; `User`/`NewUser` types; a `migrate` entrypoint.

**Precondition:** Docker Desktop WSL integration enabled (`docker compose version` works).

- [ ] **Step 1: Create `infrastructure/docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    container_name: beacon-postgres-dev
    restart: unless-stopped
    environment:
      POSTGRES_USER: beacon
      POSTGRES_PASSWORD: beacon
      POSTGRES_DB: beacon
    ports:
      - '5432:5432'
    volumes:
      - beacon_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U beacon -d beacon']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  beacon_postgres_data:
```

- [ ] **Step 2: Bring up Postgres**

Run: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`
Expected: container healthy. Verify: `docker compose -f infrastructure/docker-compose.dev.yml ps` shows `healthy`.

- [ ] **Step 3: Create `apps/server/src/db/schema.ts`**

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

- [ ] **Step 4: Create `apps/server/src/db/index.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../lib/env';
import * as schema from './schema';

const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });
export { pool };
```

- [ ] **Step 5: Create `apps/server/drizzle.config.ts`**

```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
```

Run: `npm install -D -w @beacon/server dotenv`

- [ ] **Step 6: Create `apps/server/src/db/migrate.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { env } from '../lib/env';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('[beacon-server] migrations applied');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Generate the migration**

Run (with `DATABASE_URL` available, e.g. via `apps/server/.env`): `npm run db:generate -w @beacon/server`
Expected: `apps/server/drizzle/0000_*.sql` created containing `CREATE TABLE "users"`.

- [ ] **Step 8: Apply the migration**

Run: `DATABASE_URL=postgresql://beacon:beacon@localhost:5432/beacon npm run db:migrate -w @beacon/server`
Expected: "migrations applied".

- [ ] **Step 9: Verify the table exists**

Run: `docker compose -f infrastructure/docker-compose.dev.yml exec postgres psql -U beacon -d beacon -c '\d users'`
Expected: columns `id, clerk_user_id, email, created_at, updated_at`.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck -w @beacon/server`
Expected: exits 0.

- [ ] **Step 11: Commit (request approval first)**

```bash
git add infrastructure/docker-compose.dev.yml apps/server/drizzle.config.ts apps/server/src/db apps/server/drizzle package-lock.json
git commit -m "feat(server): postgres docker, drizzle users schema, first migration"
```

---

## Task 5: Users repository + secret-guarded `/internal/users/upsert` (TDD)

**Files:**
- Create: `apps/server/src/db/repositories/users.ts`
- Test: `apps/server/src/db/repositories/users.test.ts`
- Modify: `apps/server/src/router.ts` (add `/internal/users/upsert`), `apps/server/src/index.ts` (no change needed if router mounted at `/`)

**Interfaces:**
- Consumes: `db`, `users` schema, `env.INTERNAL_API_SECRET`.
- Produces: `getByClerkId(clerkUserId: string): Promise<User | null>`; `upsertFromClerk(input: { clerkUserId: string; email: string }): Promise<User>`; route `POST /internal/users/upsert` requiring header `x-internal-secret` to equal `INTERNAL_API_SECRET`, body `{ clerkUserId, email }`, returning the upserted user.

**Precondition:** Postgres up and migrated (Task 4). This task's repository test is an **integration test** against the dev DB.

- [ ] **Step 1: Implement `apps/server/src/db/repositories/users.ts`**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../index';
import { users, type User } from '../schema';

export async function getByClerkId(clerkUserId: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertFromClerk(input: {
  clerkUserId: string;
  email: string;
}): Promise<User> {
  const rows = await db
    .insert(users)
    .values({ clerkUserId: input.clerkUserId, email: input.email })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email: input.email, updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertFromClerk: no row returned');
  return row;
}
```

- [ ] **Step 2: Write the failing integration test** — `apps/server/src/db/repositories/users.test.ts`

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { getByClerkId, upsertFromClerk } from './users';

describe('users repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('inserts a new user and reads it back', async () => {
    const created = await upsertFromClerk({ clerkUserId: 'user_1', email: 'a@example.com' });
    expect(created.clerkUserId).toBe('user_1');
    const found = await getByClerkId('user_1');
    expect(found?.email).toBe('a@example.com');
  });

  it('is idempotent and updates email on conflict', async () => {
    await upsertFromClerk({ clerkUserId: 'user_1', email: 'a@example.com' });
    const updated = await upsertFromClerk({ clerkUserId: 'user_1', email: 'b@example.com' });
    expect(updated.email).toBe('b@example.com');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('returns null for an unknown clerk id', async () => {
    expect(await getByClerkId('nope')).toBeNull();
  });
});
```

- [ ] **Step 3: Provide test env to vitest** — add to `apps/server/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: 'postgresql://beacon:beacon@localhost:5432/beacon',
      WEB_ORIGIN: 'http://localhost:3000',
      INTERNAL_API_SECRET: 'test-internal-secret-at-least-16',
    },
  },
});
```

- [ ] **Step 4: Run the test to verify it passes** (Postgres must be up + migrated)

Run: `npm test -w @beacon/server`
Expected: PASS (env + health + repository tests all green).

- [ ] **Step 5: Write the failing route test** — append to `apps/server/src/router.test.ts`

```ts
import { upsertFromClerk } from './db/repositories/users';
// ... existing imports ...

describe('POST /internal/users/upsert', () => {
  it('rejects without the internal secret', async () => {
    const app = createRouter();
    const res = await app.request('/internal/users/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_x', email: 'x@example.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('upserts with a valid secret', async () => {
    const app = createRouter();
    const res = await app.request('/internal/users/upsert', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': 'test-internal-secret-at-least-16',
      },
      body: JSON.stringify({ clerkUserId: 'user_x', email: 'x@example.com' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clerkUserId).toBe('user_x');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w @beacon/server`
Expected: FAIL — route returns 404.

- [ ] **Step 7: Add the route to `apps/server/src/router.ts`**

Add imports and the route inside `createRouter()` before `return app;`:

```ts
import { z } from 'zod';
import { env } from './lib/env';
import { upsertFromClerk } from './db/repositories/users';

const UpsertUserSchema = z.object({ clerkUserId: z.string().min(1), email: z.string().email() });

// inside createRouter(), before `return app;`
app.post('/internal/users/upsert', async (c) => {
  if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const parsed = UpsertUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const user = await upsertFromClerk(parsed.data);
  return c.json(user);
});
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -w @beacon/server`
Expected: PASS.

- [ ] **Step 9: Typecheck + lint**

Run: `npm run typecheck -w @beacon/server && npm run lint -w @beacon/server`
Expected: exits 0.

- [ ] **Step 10: Commit (request approval first)**

```bash
git add apps/server
git commit -m "feat(server): users repository and secret-guarded upsert endpoint"
```

---

## Task 6: `apps/web` Next.js 15 scaffold + Tailwind v4 design tokens + shadcn

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `components.json`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `components/ui/*`
- Modify: root `tsconfig` references not required (each app standalone).

**Interfaces:**
- Consumes: `@beacon/shared` (later tasks).
- Produces: a running Next 15 app on `:3000` with Geist fonts, graphite + status tokens, and shadcn primitives (button, card, input, label, sonner).

> Verify current shadcn/Next/Tailwind-v4 init flow via official docs before running (verified 2026-06-26). Use the CLI to generate canonical config, then layer Beacon tokens on top.

- [ ] **Step 1: Scaffold Next.js into `apps/web`**

Run: `npx create-next-app@latest apps/web --typescript --tailwind --app --eslint --no-src-dir --import-alias "@/*" --use-npm`
Expected: Next 15 app created with Tailwind v4 + `app/globals.css` containing `@import "tailwindcss";`.

- [ ] **Step 2: Rename the package and align scripts** — edit `apps/web/package.json`

Set `"name": "@beacon/web"`. Ensure scripts include:

```json
{
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Make `apps/web/tsconfig.json` extend the base** (keep Next's `plugins`/`paths`)

Ensure it has `"extends": "../../tsconfig.base.json"` while preserving the Next.js-generated `compilerOptions` (`jsx`, `plugins`, `paths`, `moduleResolution: "Bundler"`, `noEmit`). Keep `"strict": true`.

- [ ] **Step 4: Add deps**

Run: `npm install -w @beacon/web @beacon/shared geist && npm install -D -w @beacon/web vitest`
Expected: resolved.

- [ ] **Step 5: Initialize shadcn**

Run: `npx shadcn@latest init -c apps/web` (choose base color Zinc, CSS variables yes)
Then: `npx shadcn@latest add button card input label sonner -c apps/web`
Expected: `components.json` + `components/ui/{button,card,input,label,sonner}.tsx` created; CSS variables added to `app/globals.css`.

- [ ] **Step 6: Add Beacon status tokens** — append to `apps/web/app/globals.css` `@theme inline` block (or a new `@theme` block)

```css
@theme {
  --color-accent: #27272a;
  --color-status-up: #3f7d58;
  --color-status-degraded: #c18a1f;
  --color-status-down: #b23a48;
  --color-status-paused: #71717a;
}

@layer utilities {
  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }
}
```

- [ ] **Step 7: Wire Geist fonts in `apps/web/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Beacon',
  description: 'Monitor anything you ship — a self-hosted dashboard for the services I run.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-zinc-50 font-sans text-zinc-900 antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
```

> Ensure `globals.css` maps `--font-sans`/`--font-mono` to `var(--font-geist-sans)`/`var(--font-geist-mono)` inside `@theme inline` so Tailwind's `font-sans`/`font-mono` use Geist.

- [ ] **Step 8: Replace `apps/web/app/page.tsx` with the Beacon landing page**

```tsx
import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Beacon</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-900">
        Monitor anything you ship.
      </h1>
      <p className="mt-4 max-w-xl text-zinc-600">
        A self-hosted, real-time dashboard for the services I run — uptime, response times, and
        deploy health in one place, regardless of where each service is hosted.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
        >
          Sign in
        </Link>
        <Link href="/health" className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-900">
          System status
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 9: Run the dev server and eyeball it**

Run: `npm run dev -w @beacon/web`, open http://localhost:3000
Expected: landing page renders with Geist, graphite "Sign in" button. Stop the server.

- [ ] **Step 10: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exits 0.

- [ ] **Step 11: Commit (request approval first)**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): next.js 15 scaffold, geist fonts, design tokens, landing page"
```

---

## Task 7: Web env + api-client + public `/health` round-trip

**Files:**
- Create: `apps/web/lib/env.client.ts`, `apps/web/lib/api-client.ts`, `apps/web/app/health/page.tsx`, `apps/web/.env.example`

**Interfaces:**
- Consumes: `@beacon/shared` `HealthResponseSchema`.
- Produces: `clientEnv` (validated `NEXT_PUBLIC_*`); `fetchServerHealth(): Promise<HealthResponse | null>`; a public `/health` Server Component.

- [ ] **Step 1: Create `apps/web/.env.example`**

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
CLERK_WEBHOOK_SECRET=whsec_xxx
INTERNAL_API_SECRET=changeme-must-match-apps-server
```

- [ ] **Step 2: Create `apps/web/lib/env.client.ts`**

```ts
import { z } from 'zod';

const ClientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
});

export const clientEnv = ClientEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
});
```

> `NEXT_PUBLIC_*` must be referenced by literal name (not dynamically) for Next to inline them.

- [ ] **Step 3: Create `apps/web/lib/api-client.ts`**

```ts
import { HealthResponseSchema, type HealthResponse } from '@beacon/shared';
import { clientEnv } from './env.client';

export async function fetchServerHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_API_URL}/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return HealthResponseSchema.parse(await res.json());
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Create the public `apps/web/app/health/page.tsx` (Server Component)**

```tsx
import { fetchServerHealth } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const health = await fetchServerHealth();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
      <div className="mt-6 flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: health ? 'var(--color-status-up)' : 'var(--color-status-down)' }}
        />
        <span className="font-mono text-sm">
          server: {health ? 'ok' : 'unavailable'}
        </span>
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Manual round-trip test**

Run both apps: `npm run dev` (root). With `apps/web/.env.local` and `apps/server/.env` set, visit http://localhost:3000/health
Expected: green dot + "server: ok". Stop the server app and refresh → red dot + "server: unavailable" (graceful).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: exits 0.

- [ ] **Step 7: Commit (request approval first)**

```bash
git add apps/web
git commit -m "feat(web): client env, api-client, public health round-trip page"
```

---

## Task 8: Clerk auth — provider, middleware, sign-in/up, protected app shell

**Files:**
- Modify: `apps/web/app/layout.tsx` (wrap in `ClerkProvider`), `apps/web/package.json`
- Create: `apps/web/middleware.ts`, `apps/web/app/(auth)/sign-in/[[...sign-in]]/page.tsx`, `apps/web/app/(auth)/sign-up/[[...sign-up]]/page.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/services/page.tsx`

**Interfaces:**
- Consumes: Clerk env vars; `clientEnv`.
- Produces: protected `(app)/*`; sign-in/up pages; a `/services` empty state.

> Verify Clerk's current Next 15 API before coding (verified 2026-06-26: `clerkMiddleware` + `createRouteMatcher` from `@clerk/nextjs/server`; `<ClerkProvider>` from `@clerk/nextjs`).

- [ ] **Step 1: Install Clerk**

Run: `npm install -w @beacon/web @clerk/nextjs`
Expected: resolved.

- [ ] **Step 2: Create `apps/web/middleware.ts`**

```ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/services(.*)', '/incidents(.*)', '/settings(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico)).*)', '/(api|trpc)(.*)'],
};
```

> The webhook route `/api/clerk/webhook` is intentionally NOT protected (it authenticates via Svix HMAC).

- [ ] **Step 3: Wrap the root layout in `ClerkProvider`** — edit `apps/web/app/layout.tsx`

Wrap the returned tree:

```tsx
import { ClerkProvider } from '@clerk/nextjs';
// ...existing imports...

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <body className="min-h-screen bg-zinc-50 font-sans text-zinc-900 antialiased">
          {children}
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 4: Create `apps/web/app/(auth)/sign-in/[[...sign-in]]/page.tsx`**

```tsx
import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <SignIn />
    </main>
  );
}
```

- [ ] **Step 5: Create `apps/web/app/(auth)/sign-up/[[...sign-up]]/page.tsx`**

```tsx
import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <SignUp />
    </main>
  );
}
```

- [ ] **Step 6: Create `apps/web/app/(app)/layout.tsx`** (calls `ensureUserExists()` — implemented in Task 9; temporary inline until then)

```tsx
import { UserButton } from '@clerk/nextjs';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3">
        <span className="font-mono text-sm font-medium tracking-tight">beacon</span>
        <UserButton />
      </header>
      <div className="px-6 py-8">{children}</div>
    </div>
  );
}
```

> Task 9 adds the `ensureUserExists()` call at the top of this component.

- [ ] **Step 7: Create `apps/web/app/(app)/services/page.tsx`** (dense empty state, disabled CTA)

```tsx
import { Button } from '@/components/ui/button';

export default function ServicesPage() {
  return (
    <section className="mx-auto max-w-5xl">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Services</h1>
        <Button disabled>Add service</Button>
      </div>
      <div className="mt-16 flex flex-col items-center justify-center text-center">
        <p className="text-sm font-medium text-zinc-900">No services yet</p>
        <p className="mt-1 max-w-sm text-sm text-zinc-500">
          Once monitoring is wired up, the services you track will appear here with live status,
          uptime, and response times.
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Manual auth flow test** (requires real Clerk keys in `apps/web/.env.local`)

Run: `npm run dev -w @beacon/web`. Visit `/services` while signed out → redirected to `/sign-in`. Sign up → redirected back; `/services` shows the empty state and a UserButton.
Expected: behaves as described.

- [ ] **Step 9: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exits 0.

- [ ] **Step 10: Commit (request approval first)**

```bash
git add apps/web
git commit -m "feat(web): clerk auth, middleware, sign-in/up, protected services shell"
```

---

## Task 9: Clerk webhook (Svix, TDD) + `ensureUserExists` fallback

**Files:**
- Create: `apps/web/lib/clerk-webhook.ts`, `apps/web/lib/ensure-user-exists.ts`, `apps/web/app/api/clerk/webhook/route.ts`
- Test: `apps/web/lib/clerk-webhook.test.ts`, `apps/web/vitest.config.ts`
- Modify: `apps/web/app/(app)/layout.tsx` (invoke `ensureUserExists()`)

**Interfaces:**
- Consumes: `CLERK_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`, `NEXT_PUBLIC_API_URL`, Clerk server `auth()`/`currentUser()`.
- Produces: `handleClerkWebhook(rawBody, headers, deps): Promise<{ status; body }>`; `upsertUserOnServer(input): Promise<void>`; `ensureUserExists(): Promise<void>`; route `POST /api/clerk/webhook`.

- [ ] **Step 1: Install Svix**

Run: `npm install -w @beacon/web svix`
Expected: resolved.

- [ ] **Step 2: Create `apps/web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 3: Write the failing test** — `apps/web/lib/clerk-webhook.test.ts`

```ts
import { Webhook } from 'svix';
import { describe, expect, it, vi } from 'vitest';
import { handleClerkWebhook } from './clerk-webhook';

const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

function sign(payload: string) {
  const id = 'msg_test';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const wh = new Webhook(SECRET);
  const signature = wh.sign(id, new Date(Number(timestamp) * 1000), payload);
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature };
}

describe('handleClerkWebhook', () => {
  it('rejects an invalid signature with 400', async () => {
    const upsertUser = vi.fn();
    const out = await handleClerkWebhook('{}', { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'bad' }, {
      webhookSecret: SECRET,
      upsertUser,
    });
    expect(out.status).toBe(400);
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('upserts on user.created', async () => {
    const payload = JSON.stringify({
      type: 'user.created',
      data: { id: 'user_42', email_addresses: [{ email_address: 'z@example.com' }] },
    });
    const upsertUser = vi.fn().mockResolvedValue(undefined);
    const out = await handleClerkWebhook(payload, sign(payload), { webhookSecret: SECRET, upsertUser });
    expect(out.status).toBe(200);
    expect(upsertUser).toHaveBeenCalledWith({ clerkUserId: 'user_42', email: 'z@example.com' });
  });

  it('ignores unsubscribed event types with 200 { ignored: true }', async () => {
    const payload = JSON.stringify({ type: 'session.created', data: { id: 's_1' } });
    const upsertUser = vi.fn();
    const out = await handleClerkWebhook(payload, sign(payload), { webhookSecret: SECRET, upsertUser });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ignored: true });
    expect(upsertUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w @beacon/web`
Expected: FAIL — cannot resolve `./clerk-webhook`.

- [ ] **Step 5: Implement `apps/web/lib/clerk-webhook.ts`**

```ts
import { Webhook } from 'svix';

type WebhookDeps = {
  webhookSecret: string;
  upsertUser: (input: { clerkUserId: string; email: string }) => Promise<void>;
};

type ClerkUserEvent = {
  type: string;
  data: { id: string; email_addresses?: { email_address: string }[] };
};

export async function handleClerkWebhook(
  rawBody: string,
  headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string },
  deps: WebhookDeps,
): Promise<{ status: number; body: unknown }> {
  const wh = new Webhook(deps.webhookSecret);
  let evt: ClerkUserEvent;
  try {
    evt = wh.verify(rawBody, {
      'svix-id': headers['svix-id'] ?? '',
      'svix-timestamp': headers['svix-timestamp'] ?? '',
      'svix-signature': headers['svix-signature'] ?? '',
    }) as ClerkUserEvent;
  } catch {
    return { status: 400, body: { error: 'invalid signature' } };
  }

  if (evt.type === 'user.created' || evt.type === 'user.updated') {
    const email = evt.data.email_addresses?.[0]?.email_address ?? '';
    await deps.upsertUser({ clerkUserId: evt.data.id, email });
    return { status: 200, body: { ok: true } };
  }
  return { status: 200, body: { ignored: true } };
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -w @beacon/web`
Expected: PASS (3 tests).

- [ ] **Step 7: Implement `apps/web/lib/ensure-user-exists.ts`** (the server-call helper + lazy fallback)

```ts
import 'server-only';
import { currentUser } from '@clerk/nextjs/server';

export async function upsertUserOnServer(input: {
  clerkUserId: string;
  email: string;
}): Promise<void> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/internal/users/upsert`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upsertUserOnServer failed: ${res.status}`);
}

export async function ensureUserExists(): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  const email = user.emailAddresses[0]?.emailAddress ?? '';
  try {
    await upsertUserOnServer({ clerkUserId: user.id, email });
  } catch {
    // Non-fatal: the webhook is the primary path; log-and-continue keeps the page rendering.
  }
}
```

- [ ] **Step 8: Implement `apps/web/app/api/clerk/webhook/route.ts`**

```ts
import { handleClerkWebhook } from '@/lib/clerk-webhook';
import { upsertUserOnServer } from '@/lib/ensure-user-exists';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const out = await handleClerkWebhook(
    rawBody,
    {
      'svix-id': req.headers.get('svix-id') ?? '',
      'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
      'svix-signature': req.headers.get('svix-signature') ?? '',
    },
    {
      webhookSecret: process.env.CLERK_WEBHOOK_SECRET ?? '',
      upsertUser: upsertUserOnServer,
    },
  );
  return Response.json(out.body, { status: out.status });
}
```

- [ ] **Step 9: Invoke `ensureUserExists()` in `apps/web/app/(app)/layout.tsx`**

Add at the top of the `AppLayout` component body:

```tsx
import { ensureUserExists } from '@/lib/ensure-user-exists';
// ...
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await ensureUserExists();
  // ...rest unchanged
}
```

- [ ] **Step 10: End-to-end verification** (Postgres up, both apps running, real Clerk keys, webhook secret)

Sign up a new user. Verify the row:
Run: `docker compose -f infrastructure/docker-compose.dev.yml exec postgres psql -U beacon -d beacon -c 'select clerk_user_id, email from users;'`
Expected: one row for the new user (created via webhook, or via `ensureUserExists()` on first `/services` load).

- [ ] **Step 11: Typecheck + lint + full test**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all exit 0 / green.

- [ ] **Step 12: Commit (request approval first)**

```bash
git add apps/web
git commit -m "feat(web): clerk webhook handler with svix verification and ensureUserExists fallback"
```

---

## Task 10: README + acceptance verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: an accurate current-state README; a green acceptance checklist.

- [ ] **Step 1: Write `README.md`** describing the CURRENT state (not a phase TODO)

Include: what Beacon is (one paragraph), the deliberate "self-hosted, not serverless" framing with the ~$10/mo note, local setup (`npm install`, `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`, copy `.env.example` files, `npm run db:migrate`, `npm run dev`), the monorepo layout, and an explicit "What works today" list (auth, users table, health round-trip) vs. "Not built yet" (monitoring, WebSockets, integrations — link to `docs/phases/`). Mention the integration-layer abstraction as the architectural centerpiece and link `docs/ARCHITECTURE.md`.

- [ ] **Step 2: Run the full acceptance checklist** (from the phase doc)

```bash
npm run typecheck            # passes across workspaces
npm run lint                 # clean
docker compose -f infrastructure/docker-compose.dev.yml up -d postgres   # healthy
npm run dev                  # web :3000 + server :3001
```

Then manually confirm each acceptance criterion from the design spec (landing page; signup creates a row; signed-out `/services` redirects; signed-in `/services` empty state; `/health` shows "server: ok"; no secrets committed).

- [ ] **Step 3: Confirm no secrets are tracked**

Run: `git ls-files | grep -E '\.env(\.local|\.production)?$'`
Expected: no output (only `.env.example` files exist, which are fine).

- [ ] **Step 4: Commit (request approval first)**

```bash
git add README.md
git commit -m "docs: README describing Phase 1 local foundation"
```

- [ ] **Step 5: Finishing the branch** — use superpowers:finishing-a-development-branch to decide how `phase-1-foundation` integrates into `main` (the human handles the PR/merge per CLAUDE.md).

---

## Self-review (completed by plan author)

- **Spec coverage:** every spec section maps to a task — monorepo/tooling (T1), shared (T2), server+env+health (T3), docker+drizzle+migration (T4), repository+upsert boundary (T5), web scaffold+tokens+fonts (T6), client env+api-client+health page (T7), Clerk auth+middleware+pages (T8), webhook+ensureUserExists (T9), README+acceptance (T10). All 11 acceptance criteria are exercised across T4/T6/T7/T8/T9/T10.
- **Placeholder scan:** no TBD/TODO; every code step contains real code; `.env.example` placeholder strings are intentional example content.
- **Type consistency:** `HealthResponse`/`HealthResponseSchema` consistent across T2/T3/T7; `upsertFromClerk({ clerkUserId, email })` consistent across T5/T9; `handleClerkWebhook(rawBody, headers, deps)` consistent T9; `upsertUserOnServer`/`ensureUserExists` consistent T9.
- **Known sequencing constraint:** T4 onward require Docker running. T5/T9 DB checks depend on a migrated DB. T8/T9 manual steps require real Clerk keys (human-provided). These are called out in each task's preconditions.

## Sources (library API verification, 2026-06-26)
- [Tailwind v4 — shadcn/ui](https://ui.shadcn.com/docs/tailwind-v4)
- [Next.js installation — shadcn/ui](https://ui.shadcn.com/docs/installation/next)
- [clerkMiddleware() | Next.js — Clerk Docs](https://clerk.com/docs/reference/nextjs/clerk-middleware)
- [Next.js Quickstart (App Router) — Clerk Docs](https://clerk.com/docs/nextjs/getting-started/quickstart)
