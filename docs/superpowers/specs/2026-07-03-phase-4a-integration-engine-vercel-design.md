# Phase 4a — Integration Engine + Vercel (design spec)

**Status:** approved (design), pending implementation plan
**Slice of:** Phase 4 — Integrations. This is 4a of a vertical split; 4b adds GitHub, the generic Zod-driven form, the integration-card design pass, and the "how to add an integration" runbook.

## Goal

Stand up the integration layer end-to-end with **Vercel** as the first concrete integration, visible on the service detail page. Prove the whole vertical: an encrypted-credentials engine, the `IntegrationDefinition` interface + registry, a background fetch loop, attach/list/remove API, a minimal-but-real attach form, and a Vercel card rendering live deployment data.

The abstraction is the differentiator (see `ARCHITECTURE.md` → "Integration Layer"): services are platform-agnostic; integrations are opt-in, platform-specific, and loosely coupled. Adding a platform later must remain a "drop a file in `integrations/` + one registry line" operation.

## Non-goals (deferred to 4b)

- GitHub integration (proves "drop a file" by adding one file in 4b).
- The **generic Zod-schema-driven form generator** — 4a uses a purpose-built Vercel form.
- The integration-card **design pass** — 4a's card is presentable but not the final polish.
- The `ARCHITECTURE.md` "how to add an integration" runbook.

## Key decisions (confirmed)

1. **Interface shape:** object literal `IntegrationDefinition<Creds, Config>` with Zod-inferred generics — not a class. `CLAUDE.md`'s "class implementing `MonitoringIntegration`" wording will be updated to match this object-literal shape.
2. **Worker model:** a second loop (`runIntegrationWorker()`) in the **existing** worker process (`workers/index.ts`), independently error-contained — no new compose service.
3. **4a attach form:** purpose-built Vercel form; generic generator deferred to 4b.

## Design

### 1. Data model & migration

New `service_integrations` table via Drizzle migration, matching `DATA_MODEL.md`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `defaultRandom()` |
| `service_id` | uuid fk → services.id | **on delete cascade**, indexed |
| `integration_id` | text | registry key (`'vercel'`) |
| `config` | jsonb | non-secret per-service config |
| `credentials_encrypted` | text | opaque AES-GCM blob (base64) |
| `last_fetched_at` | timestamptz null | |
| `last_snapshot` | jsonb null | most recent `fetchData()` result |
| `last_error` | text null | last fetch failure message |
| `enabled` | boolean | default true |
| `created_at` / `updated_at` | timestamptz | |

- **Unique constraint `(service_id, integration_id)`** — one Vercel link per service.
- All access through a new `db/repositories/service-integrations.ts`. No raw Drizzle in routes/workers/components.

### 2. Crypto (`apps/server/src/lib/crypto.ts`)

- **AES-256-GCM.** New required env var `INTEGRATIONS_ENCRYPTION_KEY`: 32 bytes, base64-encoded (`openssl rand -base64 32`), validated by Zod at startup in `env.ts`; added to `apps/server/.env.example` as a placeholder only. Real key lives in `/opt/beacon/.env` on the VPS (never committed).
- `encrypt(plaintext: string) → string`: random 12-byte IV, returns base64 of `iv | authTag(16) | ciphertext`.
- `decrypt(blob: string) → string`: reverses; throws on auth-tag mismatch (tamper/wrong key).
- Credentials are `JSON.stringify`'d, encrypted, and stored as that blob. **Never logged, never returned to the client.**

### 3. Interface & registry (`apps/server/src/integrations/`)

```ts
// types.ts
export type IntegrationDataSnapshot = Record<string, unknown>; // loose, per-integration
export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  testCredentials(creds: Creds): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(creds: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
```

```ts
// registry.ts
export const IntegrationRegistry = new Map<string, IntegrationDefinition>([
  [vercelIntegration.id, vercelIntegration],
]);
```

The registry is consulted to: list configurable integrations, validate + test on attach, and drive the worker's fetch loop. Adding an integration = one import + one Map entry.

### 4. Vercel integration (`apps/server/src/integrations/vercel.ts`)

- `credentialsSchema`: `{ apiToken: z.string().min(1) }`.
- `configSchema`: `{ projectId: z.string().min(1), teamId: z.string().optional() }`.
- `testCredentials`: `GET https://api.vercel.com/v2/projects` (append `?teamId=` when present) with `Authorization: Bearer <apiToken>`; `{ok:true}` on 200, else `{ok:false, error}` with a sanitized message.
- `fetchData`: `GET /v6/deployments?projectId=…&limit=5` (+ `teamId`); snapshot = the latest **5** deployments `{ state, createdAt, url, commitSha?, commitMessage? }` plus a best-effort derived `productionStatus` (the state of the most recent production deployment, or `null` if unknown).
- Exact Vercel endpoints/fields confirmed against current docs (Context7) at implementation time.

### 5. Integration worker (second loop in the existing process)

- `workers/integration-worker.ts` exports `runIntegrationWorker(): Promise<never>`.
- `workers/index.ts` starts it alongside `runWorker()`; each loop is independently error-contained so one crashing never stops the other.
- Loop: wakes roughly every **60s**, selects `enabled` integrations that are **due** (`last_fetched_at` null or older than **5 minutes**); for each, look up the def in the registry, `decrypt` credentials, run `fetchData(creds, config)`, then persist `last_snapshot` + `last_fetched_at` on success, or `last_error` on failure. A single integration's failure is caught and never crashes the loop (per worker-resilience convention).

### 6. API routes (`router.ts`, ownership-scoped, RFC 7807 errors)

- `POST /services/:id/integrations` — body `{ integrationId, config, credentials }`. Look up the def; validate `config`/`credentials` against its schemas; run `testCredentials` and **reject the save (surfacing the error) if it fails**; `encrypt` credentials; **upsert** on `(service_id, integration_id)` — re-attaching an already-configured integration replaces its config + credentials rather than erroring.
- `GET /services/:id/integrations` — returns `{ integrationId, config, enabled, lastFetchedAt, lastError, snapshot }`. **Never returns credentials.**
- `DELETE /services/:id/integrations/:integrationId`.
- All routes verify the service belongs to the authenticated user before acting.

### 7. UI — minimal-but-real (service detail page)

- **"Add integration"** control → a **purpose-built Vercel form** (API token, project ID, optional team ID). Submits via a Server Action that calls the attach route. On `testCredentials` failure it shows the error inline and does **not** save; on success the card appears.
- **`<VercelIntegrationCard />`** reads `last_snapshot` and renders the recent deployments (state dot, relative time, commit) with loading / empty / error states, plus `lastError` if a fetch failed. Presentable, but the full design pass + generic form land in 4b.

### 8. Error handling

- Credentials never logged or returned to the client.
- `testCredentials` failures surfaced to the user **before** saving.
- Worker `fetchData` failures recorded in `last_error`; the loop continues.
- `decrypt` failures (tamper / rotated key) surface as an integration error, not a process crash.
- Client-facing errors stay generic ("Couldn't reach Vercel"); full detail only in logs.

### 9. Testing & definition of done

- **Unit:** crypto round-trip + tamper/auth-tag-failure; registry lookup; Vercel `credentialsSchema`/`configSchema` validation and `testCredentials`/`fetchData` against **mocked HTTP**; worker due-selection and persist-on-success vs persist-on-error; API route auth/ownership/validation and credentials-never-returned.
- **Integration (real Postgres):** `service-integrations` repository CRUD + the unique constraint.
- **Real credential check (success criterion):** configure a real Vercel integration (Wayfare or Investor Thesis). ⚠️ Local live fetch needs outbound DNS, currently broken by the host VPN — so the real fetch is verified either after restoring local DNS or against production post-deploy. The plan will call this out explicitly.
- `npm run typecheck` + `npm run lint` clean (both apps); `INTEGRATIONS_ENCRYPTION_KEY` added to `.env.example` + `env.ts`; migration generated and applied locally (and to prod via the deploy pipeline); `CLAUDE.md` integration wording updated to the object-literal shape.

## Open follow-ups for 4b

GitHub integration (one file), generic Zod-driven form generator, integration-card design pass, and the `ARCHITECTURE.md` "how to add an integration" runbook.
