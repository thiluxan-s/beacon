# Data Model

## Entity relationship

```
User (1) ──< (N) Service ──< (N) ServiceCheck
                  │
                  ├──< (N) ServiceIntegration
                  │
                  └──< (N) Incident
                              │
                              └──< (N) IncidentEvent

User (1) ──< (N) Domain ──< (N) DomainCheck
```

- A **User** has many **Services**.
- A **Service** has many **ServiceChecks** (history of HTTP health checks).
- A **Service** has many **ServiceIntegrations** (one per attached platform — Vercel, GitHub, etc.).
- A **Service** has many **Incidents** (when status transitions to bad).
- An **Incident** has many **IncidentEvents** (timeline of what happened during the incident).
- A **User** has many **Domains** (separate from services — these are domain-level concerns).

All deletions cascade downward. Deleting a service deletes its checks, integrations, and incidents.

## Table-by-table

### `users`

Same pattern as Wayfare and Investor Thesis. Thin row keyed to Clerk (or to whatever auth we land on).

```ts
{
  id: uuid (pk)
  clerk_user_id: text (unique, indexed)
  email: text
  created_at: timestamptz
  updated_at: timestamptz
}
```

For v1 single-user, this table will have exactly one row. The schema is designed so adding more users later (v2 multi-user) is trivial — every owned entity already has `user_id`.

### `services`

The central entity. Every monitored thing is a service.

```ts
{
  id: uuid (pk)
  user_id: uuid (fk → users.id, on delete cascade, indexed)
  name: text                                    // "Wayfare", "Investor Thesis", "Client X API"
  description: text                             // optional, longer context
  base_url: text                                // "https://wayfare.thiluxan.com" — what we ping
  health_check_path: text (default '/')         // appended to base_url
  expected_status_codes: integer[] (default [200])
  check_interval_seconds: integer (default 60)
  timeout_seconds: integer (default 10)
  current_status: enum('pending', 'up', 'degraded', 'down', 'paused')
  current_status_since: timestamptz             // when it entered current status
  last_check_at: timestamptz (nullable)
  next_check_at: timestamptz (nullable)
  paused: boolean (default false)
  alerts_enabled: boolean (default true)
  consecutive_failures: integer (default 0)     // strike counter powering 2-check debounce (Phase 5a)
  consecutive_successes: integer (default 0)    // strike counter powering 2-check debounce (Phase 5a)
  created_at: timestamptz
  updated_at: timestamptz
}
```

**Indexes:** `(user_id, current_status)` for the dashboard filter; `next_check_at` for the worker's "find due checks" query.

**Why `expected_status_codes` as an array?** Some services intentionally return 401 for unauthenticated requests but are still "up." The default is `[200]` but the user can configure `[200, 401, 403]` for a service where those count as healthy.

**Why `paused` AND a `paused` enum value on `current_status`?** Paused is a *configuration* (don't check), not just a *status*. Storing both lets us pause without losing track of the last real status.

### `service_checks`

Every HTTP health check ever performed. Time-series-ish. Keep around 30 days; archive or delete older.

```ts
{
  id: uuid (pk)
  service_id: uuid (fk → services.id, on delete cascade, indexed)
  checked_at: timestamptz (indexed)
  status: enum('success', 'failure', 'timeout', 'error')
  status_code: integer (nullable)               // null for timeout / error / DNS failure
  response_time_ms: integer (nullable)
  error_message: text (nullable)                // for 'error' status: brief description
}
```

**Indexes:** `(service_id, checked_at)` is the hot path — every service detail view queries "last N checks for service X."

**Retention:** Drop checks older than 30 days via a daily cleanup job. Keep aggregated daily summaries forever (separate `service_daily_summary` table — not built in v1, but planned for v2).

### `service_integrations`

A service has zero or more integrations attached.

```ts
{
  id: uuid (pk)
  service_id: uuid (fk → services.id, on delete cascade, indexed)
  integration_id: text                          // 'vercel' | 'github' | (registry key)
  config: jsonb                                 // integration-specific config (Vercel project ID, GitHub repo, etc.)
  credentials_encrypted: text                   // encrypted credentials (see Architecture for encryption)
  last_fetched_at: timestamptz (nullable)
  last_snapshot: jsonb (nullable)               // most recent fetchData() result
  last_error: text (nullable)                   // if last fetch failed
  enabled: boolean (default true)
  created_at: timestamptz
  updated_at: timestamptz
  
  // Unique constraint on (service_id, integration_id) — one Vercel integration per service, not many
}
```

**Why JSONB for config and snapshot?** Each integration's shape is unique. Vercel needs `projectId`, GitHub needs `owner` + `repo`, Railway will need different fields. Storing as JSONB + validating per-integration with a Zod schema (defined inside each integration file) is cleaner than a wide table with mostly-null columns.

**Why `credentials_encrypted` as text, not jsonb?** It's encrypted bytes serialized to base64 — opaque to the database. Decryption happens in app code with `INTEGRATIONS_ENCRYPTION_KEY`.

### `incidents`

When a service transitions to a bad state, an incident is opened. When it recovers, the incident is closed.

```ts
{
  id: uuid (pk)
  service_id: uuid (fk → services.id, on delete cascade, indexed)
  started_at: timestamptz
  resolved_at: timestamptz (nullable)            // null = still ongoing
  duration_seconds: integer (nullable)           // computed when resolved_at set
  severity: enum('degraded', 'down')
  trigger_check_id: uuid (fk → service_checks.id)  // the check that opened it
  resolution_check_id: uuid (fk → service_checks.id, nullable)
  notification_sent: boolean (default false)
  created_at: timestamptz
  updated_at: timestamptz
}
```

**Indexes:** `(service_id, started_at DESC)` for the per-service incident history; a **partial unique index** on `(service_id) WHERE resolved_at IS NULL` — this isn't just a query aid, it's a database-enforced invariant that a service can have at most one open (unresolved) incident at a time.

**Flapping protection:** Don't open a new incident until 2 consecutive failed checks. Don't close until 2 consecutive successful checks. This avoids alert noise from transient failures.

### `incident_events`

Timeline of what happened during an incident. v1 includes: incident opened, status code observations, integrations dropped data, incident resolved. Designed for extension (manual annotations, related incidents, etc.).

```ts
{
  id: uuid (pk)
  incident_id: uuid (fk → incidents.id, on delete cascade, indexed)
  occurred_at: timestamptz
  event_type: enum('opened', 'observed', 'resolved', 'note')
  message: text
  metadata: jsonb (nullable)                     // event-type-specific extras
  created_at: timestamptz
}
```

### `domains`

Domains are tracked separately from services. A service uses a domain; the domain itself has its own health concerns (DNS, SSL, expiry).

```ts
{
  id: uuid (pk)
  user_id: uuid (fk → users.id, on delete cascade, indexed)
  domain: text                                  // "wayfare.thiluxan.com"
  check_interval_seconds: integer (default 3600)  // hourly for domains; faster doesn't help
  current_status: enum('healthy', 'warning', 'expiring_soon', 'expired', 'unhealthy')
  ssl_expires_at: timestamptz (nullable)
  domain_expires_at: timestamptz (nullable)
  ssl_issuer: text (nullable)                   // "Let's Encrypt", "Cloudflare", etc.
  last_check_at: timestamptz (nullable)
  next_check_at: timestamptz (nullable)
  created_at: timestamptz
  updated_at: timestamptz
}
```

**Why a separate table?** Multiple services can share a domain (e.g., I might run 3 services under `*.thiluxan.com`). Checking the domain once and joining is cleaner than re-checking SSL for every service.

### `domain_checks`

Same shape as service_checks but for domains.

```ts
{
  id: uuid (pk)
  domain_id: uuid (fk → domains.id, on delete cascade, indexed)
  checked_at: timestamptz (indexed)
  dns_resolved: boolean
  dns_ip: text (nullable)
  ssl_valid: boolean (nullable)
  ssl_expires_at: timestamptz (nullable)
  ssl_days_until_expiry: integer (nullable)
  error_message: text (nullable)
}
```

### Alert rows (Phase 5 or later)

Not strictly part of v1's MVP but worth planning for. A simple `alerts_sent` table tracks deduplication ("don't send another email about the same incident").

```ts
alerts_sent {
  id: uuid (pk)
  incident_id: uuid (fk → incidents.id, indexed)
  channel: enum('email')                         // 'slack', 'discord', etc. in v2
  sent_at: timestamptz
  status: enum('sent', 'failed')
}
```

## What we deliberately don't model

- **No `Platform` table.** Integrations are identified by string IDs that map to the registry — not foreign keys to a platforms table. Adding a platform = adding a file, not seeding a row.
- **No `User.preferences`.** Single user; preferences can be hardcoded for v1 (or stored as env vars).
- **No metrics ingestion / time-series tables.** ServiceCheck is enough for v1. If we ever go deeper (response time histograms, percentiles), a dedicated time-series approach via TimescaleDB extension or rollup tables.
- **No audit log.** Single-user app; no need to track who did what.
- **No soft deletes.** Cascade deletes are sufficient.

## Migrations

Same as before. Drizzle generates into `apps/server/drizzle/`. Always commit generated migrations. Never edit applied migrations.

```bash
npm run db:generate
npm run db:migrate
npm run db:push      # local dev only
```

Production migrations run as part of the deploy script (see `INFRASTRUCTURE.md`).

## Encryption of integration credentials

Stored as text in the `service_integrations.credentials_encrypted` column. Encryption with AES-256-GCM, key from `INTEGRATIONS_ENCRYPTION_KEY` env var.

```ts
// apps/server/src/lib/crypto.ts
encrypt(plaintext: string): string  // returns base64(iv || ciphertext || authTag)
decrypt(ciphertext: string): string
```

Decryption happens in worker / route handlers, not in components. Decrypted credentials never logged. The encryption key is never sent to the client.

## Seeding

Phase 6's seed script populates the DB for a local demo with realistic-looking data:
- One demo user
- 3-4 services (mock health check results)
- 1-2 integrations attached
- A historical incident (recovered)
- 2-3 domains

For *production*, no seeding — I configure my own services through the UI as I build.
