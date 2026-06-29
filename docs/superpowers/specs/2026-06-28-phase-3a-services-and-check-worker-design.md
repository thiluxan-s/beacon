# Phase 3 — Slice A: Services & Check Worker — Design Spec

**Date:** 2026-06-28
**Phase:** 3 (Health Checks & Real-Time), decomposed into Slice A (this spec) then Slice B.
**Status:** design approved; pending implementation plan.

## Goal

Make health checks *real*: a user can add a service through the dashboard, a background worker runs scheduled HTTP health checks, and each service's status flips between `up`/`down` in the database based on the latest check. Status is visible on the dashboard and updates **on refresh** — live streaming arrives in Slice B.

This slice delivers a working monitoring loop on a solid, tested data + worker foundation, before the real-time layer is built on top of it.

## Scope

**In scope (Slice A):**
- `services` + `service_checks` schema and migration (local + production).
- Service repositories (CRUD + worker queries) and `service_checks` repository.
- Internal HTTP API endpoints for services CRUD on the Hono server.
- Web dashboard: services list as status cards, Add Service dialog, edit / delete / pause.
- The `check-worker` background process: scheduled HTTP checks, result persistence, status transitions.

**Out of scope — deferred to Slice B:** WebSocket server + client, live UI updates, connection-state indicator, the service **detail page** + check-history view.

**Out of scope — deferred to Phase 5:** `degraded` status, flapping hysteresis (2-consecutive-checks rule), incidents and incident events.

**Out of scope — later:** `domains` / `domain_checks`; a worker "wake-up" endpoint for instant first checks; the `service_checks` 30-day retention/cleanup job (no aged data exists yet in Slice A).

## Key decisions

1. **Status logic:** the worker classifies each check as `success` / `failure` / `timeout` / `error`, and sets `current_status` to `up` (success) or `down` (otherwise). The status flips **immediately** when a check result differs from the current status. `pending` is the initial state; `paused` is set by configuration. `degraded` exists in the enum but is never set in Slice A.
2. **CRUD goes through the internal API**, reusing the established pattern: the browser talks only to the Next.js app; the web's Server Components (reads) and Server Actions (writes) call new `/internal/services*` endpoints on the Hono server, server-side, guarded by the `x-internal-secret` header and reached over `INTERNAL_API_URL`. The web never touches Postgres directly. The worker, being part of `apps/server`, accesses the DB directly via repositories (no HTTP).
3. **First check is poll-driven:** `createService` inserts with `current_status = 'pending'` and `next_check_at = now`, so the worker picks it up within its poll interval (~5s). No wake-up endpoint.
4. **Dashboard CRUD only** in Slice A; the service detail page ships in Slice B with the live updates it is meant to display.

## Architecture & data flow

```
Browser ──> Next.js web ──(Server Components: reads)──┐
            (Server Actions: writes) ─────────────────┤ x-internal-secret over
                                                       │ INTERNAL_API_URL (http://server:3001)
                                                       ▼
                                              Hono /internal/services*
                                                       │ repositories
                                                       ▼
                                                   Postgres
                                                       ▲
                              check-worker (separate process) ── reads/writes DB directly
```

This reuses the Phase 2 plumbing end to end: internal endpoints are blocked publicly at Caddy (`/internal/*` → 404) and reached only over the internal Docker network.

## Schema (`apps/server/src/db/schema.ts`)

Per `DATA_MODEL.md`, scoped to the two tables this slice needs.

**`services`** — columns: `id` (uuid pk), `user_id` (fk → users, cascade, indexed), `name`, `description` (nullable), `base_url`, `health_check_path` (default `'/'`), `expected_status_codes` (int[], default `[200]`), `check_interval_seconds` (default `60`), `timeout_seconds` (default `10`), `current_status` (enum `pending|up|degraded|down|paused`, default `pending`), `current_status_since` (timestamptz), `last_check_at` (nullable), `next_check_at` (nullable), `paused` (bool default false), `alerts_enabled` (bool default true), `created_at`, `updated_at`.
Indexes: `(user_id, current_status)`, `next_check_at`.

**`service_checks`** — columns: `id` (uuid pk), `service_id` (fk → services, cascade, indexed), `checked_at` (timestamptz, indexed), `status` (enum `success|failure|timeout|error`), `status_code` (int, nullable), `response_time_ms` (int, nullable), `error_message` (text, nullable).
Index: `(service_id, checked_at)`.

Migration generated with `npm run db:generate`, applied locally with `npm run db:migrate`; production applies it automatically inside `deploy.sh`.

## Shared schemas (`packages/shared`)

- `ServiceStatus` and `CheckStatus` enums (Zod), shared by web + server.
- `ServiceCreateSchema` (name, base_url required; description, health_check_path, expected_status_codes, check_interval_seconds, timeout_seconds optional with defaults) and `ServiceUpdateSchema` (partial).
- `Service` / `ServiceCheck` types derive from the Drizzle schema (`$inferSelect`).

## Server — repositories + internal endpoints

`db/repositories/services.ts`:
- `createService(userId, input)` — inserts with `pending` + `next_check_at = now`.
- `listServicesByUser(userId)`, `getService(userId, id)`, `updateService(userId, id, patch)`, `deleteService(userId, id)`, `setPaused(userId, id, paused)`.
- Worker-facing: `findDueServices(limit)` (`next_check_at <= now AND paused = false`), `applyCheckResult(...)` (transactionally records the check + updates `last_check_at`/`next_check_at`/status).

`db/repositories/service-checks.ts`: `recordCheck(...)`. (The 30-day retention/cleanup job is deferred — there is no old data to prune in Slice A.)

Router additions (all `x-internal-secret`-guarded, user resolved from `clerkUserId`; `users` repo gains `getByClerkId` if not present):
- `GET /internal/services` — list for user.
- `POST /internal/services` — create (validates `ServiceCreateSchema`).
- `GET /internal/services/:id` — fetch one (404 if not owned).
- `PATCH /internal/services/:id` — update (validates `ServiceUpdateSchema`).
- `DELETE /internal/services/:id` — delete.
- `POST /internal/services/:id/pause` — set `paused` (body `{ paused: boolean }`).

## The check worker (`apps/server/src/workers/check-worker.ts`)

A plain loop — Postgres is the queue; no BullMQ/Inngest.

```
while (true) {
  const due = await findDueServices(BATCH_LIMIT);
  await runBounded(due, MAX_CONCURRENCY, checkOne);
  await sleep(POLL_INTERVAL_MS);   // ~5s
}
```

- **`checkOne(service)`**: `fetch(base_url + health_check_path)` with an `AbortController` hard timeout at `timeout_seconds`; measure response time; classify:
  - `success` — response received and `status_code ∈ expected_status_codes`.
  - `failure` — response received but status not expected.
  - `timeout` — aborted by the timeout.
  - `error` — DNS/connection/other fetch error (capture a brief `error_message`).
- Persist a `service_checks` row; update `last_check_at` and `next_check_at = now + check_interval_seconds`.
- **Status transition:** `newStatus = success ? 'up' : 'down'`. If `newStatus !== current_status`, update `current_status` + `current_status_since`. This update is funneled through a single function call so Slice B can add a WebSocket broadcast at exactly this seam.
- **Bounded concurrency** via a small no-dependency semaphore/queue helper (the phase doc's "don't run more than N in parallel"); native `fetch` + `AbortController`, no new dependencies.
- The classification (`response | timeout | error → CheckStatus + derived ServiceStatus`) is a **pure function**, unit-tested independently of the network.

**Process model:** production `infrastructure/docker-compose.yml` gains a `worker` service using the **same `beacon-server` image** with a different command (e.g. `npm run worker` → `tsx src/workers/check-worker.ts`), sharing `DATABASE_URL`. Local dev runs the worker alongside web + server via the concurrent `npm run dev`. Docker restarts the worker if it crashes; it is stateless and resumes from the DB.

## Web — dashboard CRUD

Engage the **frontend-design skill** (this is the headline dashboard surface).

- **`/services`** — a Server Component fetching `listServicesByUser` via the internal API, rendering services as **status cards**: name, status badge (`pending`/`up`/`down`/`paused`), last response time, relative "last checked", with an honest empty state when there are none.
- **Add Service dialog** — a client component; a short form (name + base_url prominent; description, path, expected codes, interval, timeout behind sensible defaults) → Server Action `createService` → revalidate.
- **Row actions** — edit (dialog → `updateService`), delete (confirm → `deleteService`), pause/resume (`setPaused`).
- Status shown reflects the worker and refreshes on navigation; live updates are Slice B.

## Error handling

- Server Actions return `{ ok: true, data } | { ok: false, error }`; never throw across the boundary.
- Internal endpoints return problem-shaped JSON errors; the worker never crashes the process on a single check failure (catch, record as `error`/`failure`, continue).
- Client sees friendly messages; full detail goes to logs; no internal state leaked to the client.

## Testing (TDD)

- **Worker classification** — unit tests for `success` (expected code), `failure` (unexpected code), `timeout`, `error`, and multi-code `expected_status_codes`.
- **Repositories** — integration tests against the CI Postgres (existing users-repo pattern): create/list/get/update/delete/pause, ownership scoping, and `findDueServices` selection.
- **Shared schemas** — validation tests for `ServiceCreateSchema` defaults and rejection of bad input.
- CI already provisions Postgres, runs migrations, and runs the full test suite.

## Definition of done

Per `CLAUDE.md`: typecheck + lint clean; happy path works end-to-end (add a service → worker checks it → status flips → visible on refresh); at least one failure case handled (unreachable URL → `down`); new env (if any) in `.env.example` + `env.ts`; migration generated and applied; `INFRASTRUCTURE.md` updated for the new `worker` compose service; commits explain *why*; human approval before each commit.
