# Phase 5a — Incidents Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-05
**Depends on:** Phase 4 complete (integrations + check worker + WebSocket fan-out), merged to `main`.

## Goal

When a monitored service goes down, Beacon records an **incident** with a **timeline**, debounced so a single transient blip never opens one. The dashboard status and the incident open/close in lockstep. Incidents are browsable at `/incidents` (list) and `/incidents/[id]` (timeline — the "wow" screen), and linked from each service's detail page. Incident open/resolve events push over the existing WebSocket fan-out so the UI updates live.

This is **sub-phase 5a** of Phase 5. It is deliberately scoped to incidents only. The full Phase 5 ("Incidents, Alerts, Domains") is decomposed into:

- **5a — Incidents** (this spec): schema + debounced open/close logic in the check worker + incidents UI.
- **5b — Alerts** (later): Resend email on open/resolve, `alerts_sent` dedup, settings toggles. Builds on 5a.
- **5c — Domains** (later): `domains`/`domain_checks` schema + hourly DNS/SSL/WHOIS worker + domains UI. Independent of 5a/5b.

## Non-goals (YAGNI / deferred)

- **Email alerts / Resend / `alerts_sent` / settings toggles.** All of 5b. The `incidents.notification_sent` column is created per `DATA_MODEL.md` but stays unused until 5b.
- **Domains, `domain_checks`, the domain worker, `/domains` UI.** All of 5c.
- **`degraded` status and degraded-severity incidents.** The `service_status` enum keeps `degraded` (already defined) but 5a never produces it. Incidents are always `severity: 'down'`. A real `degraded` signal (e.g. a per-service latency threshold) is defined in a later phase when there's a concrete trigger for it.
- **Manual incident annotations (`note` events by a human), related-incident linking, incident acknowledgement.** The `incident_events.event_type` enum includes `note` and 5a writes exactly one kind of `note` (the pause auto-resolve marker), but there is no UI to author notes.
- **Response-time-threshold or integration-driven incidents.** 5a incidents are driven solely by the existing HTTP health check's up/down classification.
- **Incident retention/pruning.** Incidents and their events are the permanent record; the existing 30-day `service_checks` cleanup does not touch them.

## Key decisions (from brainstorm)

1. **Lockstep debounce.** On the first failing check, `current_status` stays `up` (one strike, invisible). On the **second consecutive** failing check, status flips to `down` **and** the incident opens together. Recovery mirrors: stays `down` on the first success, flips to `up` + resolves on the second consecutive success. A single transient blip is invisible on the dashboard and creates no incident.
2. **`degraded` deferred.** 5a statuses in play: `up | down | paused | pending`. Incident severity: always `down`.
3. **Timeline granularity = open + resolve + observed-on-change.** Write an `opened` event when it opens, a `resolved` event when it recovers, and an `observed` event **only when the failure detail changes** during the outage (e.g. HTTP 500 → 503, or a status code → a timeout). Identical repeated failures produce no new event (no flooding).
4. **Strike tracking via counter columns** on `services` (not re-derived from check history). See schema.
5. **Pause auto-resolves an open incident.** Pausing a service with an open incident closes that incident (checks stop, so it could never hit 2 successes) with a `note` event: "resolved: monitoring paused".
6. **Incident events fan out over the existing WS hub** unchanged — they carry `serviceId` + `userId`, which is all `connections.ts` routes on.

## Architecture fit

The status-transition path already exists and is clean. `applyCheckResult()` (`apps/server/src/db/repositories/services.ts`) runs a single `db.transaction`: insert the `service_check`, update the `services` row, and — when status changes — `pg_notify('beacon_events', …)`, which `ws/listener.ts` validates against `WsEventSchema` and hands to `hub.broadcast()`. The hub (`ws/connections.ts:43`) routes each event to connections matching `event.userId` that are subscribed to `global` or `service:<event.serviceId>`.

5a extends this path in place:

- The **debounce decision** becomes a pure function, `workers/transition.ts`, unit-tested without a DB.
- **Incident open/close/observe** live in a new repository, `db/repositories/incidents.ts`, whose mutators accept the active `tx` so they run inside `applyCheckResult`'s existing transaction.
- The **WS event union** grows from 1 → 3 members. The listener and hub need no structural change.
- Two **read endpoints** and a new **web area** are added.

No changes to `ws/connections.ts`, the crypto layer, the integration registry, or the integration workers.

## Design

### Schema additions

**`services` — two new columns** (addition beyond current `DATA_MODEL.md`; that doc will be updated):

```ts
consecutiveFailures:  integer('consecutive_failures').notNull().default(0)
consecutiveSuccesses: integer('consecutive_successes').notNull().default(0)
```

Rationale: O(1), race-free inside the existing transaction, trivially testable. The alternative (re-deriving strikes from the last two `service_checks` rows each apply) is avoided.

**`incidents`** — per `DATA_MODEL.md`, with 5a simplifications:

```ts
{
  id: uuid (pk, defaultRandom)
  serviceId: uuid (fk → services.id, on delete cascade, indexed)
  startedAt: timestamptz (not null)
  resolvedAt: timestamptz (nullable)            // null = ongoing
  durationSeconds: integer (nullable)           // set when resolvedAt is set
  severity: incidentSeverity('down')            // enum ['degraded','down']; 5a always 'down'
  triggerCheckId: uuid (fk → service_checks.id) // the check that opened it
  resolutionCheckId: uuid (fk → service_checks.id, nullable)
  notificationSent: boolean (not null, default false)  // unused until 5b
  createdAt / updatedAt: timestamptz
}
```

Indexes:
- `index('incidents_service_started_idx').on(serviceId, startedAt DESC)` — per-service history.
- **Partial unique index** `uniqueIndex('incidents_one_open_per_service_idx').on(serviceId).where(sql\`resolved_at IS NULL\`)` — guarantees **at most one open incident per service**, so "the open incident" is an unambiguous lookup and also satisfies the data-model's "current incidents" query.

**`incident_events`** — per `DATA_MODEL.md`:

```ts
{
  id: uuid (pk, defaultRandom)
  incidentId: uuid (fk → incidents.id, on delete cascade, indexed)
  occurredAt: timestamptz (not null)
  eventType: incidentEventType   // enum ['opened','observed','resolved','note']
  message: text (not null)
  metadata: jsonb (nullable)     // e.g. { status, statusCode, errorMessage } for observed/opened
  createdAt: timestamptz
}
```

Index: `index('incident_events_incident_occurred_idx').on(incidentId, occurredAt)`.

New enums: `incidentSeverity = pgEnum('incident_severity', ['degraded','down'])`, `incidentEventType = pgEnum('incident_event_type', ['opened','observed','resolved','note'])`.

Migration generated via `npm run db:generate`, committed, applied locally and (at deploy) in production.

### The transition decision — pure function

`apps/server/src/workers/transition.ts`:

```ts
const CONFIRM_THRESHOLD = 2;

type TransitionInput = {
  currentStatus: 'pending' | 'up' | 'down' | 'degraded' | 'paused';
  consecutiveFailures: number;   // AFTER applying this check's raw result
  consecutiveSuccesses: number;  // AFTER applying this check's raw result
  rawStatus: 'up' | 'down';      // classifyCheck's serviceStatus for this check
};

type TransitionResult = {
  nextStatus: 'up' | 'down';                    // caller writes only if != currentStatus
  incidentAction: 'open' | 'resolve' | 'none';
};

export function decideTransition(input: TransitionInput): TransitionResult;
```

Rules:

| currentStatus | rawStatus | condition | nextStatus | incidentAction |
|---|---|---|---|---|
| `up` or `pending` | `down` | `consecutiveFailures >= 2` | `down` | `open` |
| `pending` | `up` | first success (`>= 1`) | `up` | `none` |
| `up` | `up` | — | `up` | `none` |
| `down` | `up` | `consecutiveSuccesses >= 2` | `up` | `resolve` |
| `down` | `down` | — | `down` | `none` |
| any | — | condition not met | *currentStatus* (no change) | `none` |

Notes:
- Transition **into** `down` is debounced (2 strikes). Transition **out of** `pending` into `up` is **immediate** (1 success) so a newly added healthy service shows green without waiting a cycle; transition out of `down` into `up` is debounced (2 successes).
- `paused` is never an input to `decideTransition` (paused services aren't checked). Pause handling is separate (see below).
- The counters passed in are the **post-update** values; the caller increments/resets before calling.

The `observed`-on-change decision is **not** in `decideTransition` — it needs the open incident's last event metadata (I/O). It lives in the incidents repository.

### Counter update logic (in `applyCheckResult`)

Given the incoming check's `rawStatus`:
- `down` → `consecutiveFailures = service.consecutiveFailures + 1`, `consecutiveSuccesses = 0`
- `up`   → `consecutiveSuccesses = service.consecutiveSuccesses + 1`, `consecutiveFailures = 0`

These new values are always written to the `services` row (alongside `lastCheckAt`/`nextCheckAt`), regardless of whether status changes.

### Wiring into `applyCheckResult`

`applyCheckResult` stays the single transactional boundary. New flow inside the existing `db.transaction(async (tx) => { … })`:

1. Insert the `service_check` (unchanged) — capture its `id` (via `.returning({ id })`).
2. Compute post-update counters from `rawStatus` (above). `rawStatus` is `args.newStatus`-adjacent; the worker already computes `classifyCheck(...).serviceStatus`. Pass it through as an explicit field so `applyCheckResult` doesn't re-derive it. **Interface change:** `applyCheckResult`'s args gain `rawStatus: 'up' | 'down'` (the classifier's `serviceStatus`); the existing `newStatus` field is removed — the *confirmed* next status is now decided by `decideTransition`, not by the classifier. `check-worker.ts` passes `rawStatus: r.serviceStatus` instead of `newStatus: r.serviceStatus`.
3. Call `decideTransition({ currentStatus: service.currentStatus, consecutiveFailures, consecutiveSuccesses, rawStatus })`.
4. Update `services`: always write `consecutiveFailures`, `consecutiveSuccesses`, `lastCheckAt`, `nextCheckAt`, `updatedAt`; write `currentStatus` + `currentStatusSince` only when `nextStatus !== currentStatus`.
5. Act on `incidentAction`:
   - **`open`** → `openIncident(tx, { serviceId, triggerCheckId, startedAt: now, detail })`: insert the `incidents` row + an `opened` `incident_event` whose `message`/`metadata` describe the failure detail (`{ status, statusCode, errorMessage }`).
   - **`resolve`** → `resolveIncident(tx, { serviceId, resolutionCheckId, resolvedAt: now })`: find the open incident (partial-unique lookup), set `resolvedAt`, `durationSeconds = floor((resolvedAt - startedAt)/1000)`, `resolutionCheckId`; insert a `resolved` `incident_event`.
   - **`none` + `rawStatus === 'down'` + an incident is open** → `recordObservationIfChanged(tx, { serviceId, detail, occurredAt: now })`: compare `detail` to the open incident's most-recent event `metadata`; if changed, insert an `observed` event; if identical, do nothing.
6. `pg_notify('beacon_events', …)`:
   - existing `service.status_changed` when status changed (unchanged);
   - `incident.opened` on open;
   - `incident.resolved` on resolve.

All incident DB access is in `db/repositories/incidents.ts`; mutators take `tx`. No raw Drizzle in the worker.

### Pause handling

`setPaused(userId, id, true)` (in `services.ts`) gains: within a transaction, after setting `paused`/`currentStatus='paused'`, if the service has an open incident, resolve it with `resolvedAt = now`, `durationSeconds` computed, `resolutionCheckId = null`, and a `note` `incident_event` "resolved: monitoring paused". Emit an `incident.resolved` WS event so the UI updates. Un-pausing does not reopen anything; the service re-enters `pending` and re-debounces from scratch (counters reset to 0 on pause).

### WS contract (`packages/shared/src/schemas/ws-event.ts`)

Grow the discriminated union to three members:

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

`ws/listener.ts` and `ws/connections.ts` need no change — the listener already `safeParse`s against `WsEventSchema`, and the hub routes on `serviceId`/`userId`, which both new events carry.

### HTTP API (`apps/server/src/router.ts`, `/internal/*`, behind existing internal auth)

- `GET /internal/incidents?serviceId=<uuid>&open=true` — the authed user's incidents, newest first, with the service name joined. `serviceId` filters to one service (backs the service-detail history link); `open=true` filters to unresolved. Returns a DTO array.
- `GET /internal/incidents/:id` — one incident (ownership-checked via join to `services.user_id`) plus its `incident_events` ordered by `occurredAt`.

Both via new repository functions:
- `listIncidents(userId, { serviceId?, open? })`
- `getIncidentWithEvents(userId, incidentId)` → `{ incident, events } | null`

Ownership is enforced by joining incidents → services and filtering `services.user_id = userId`, mirroring `getService`. `404`/empty for non-owned or missing, per the existing problem-details convention.

### Web UI (`apps/web`, App Router)

Default to Server Components; `"use client"` only for live subscriptions.

- **`/incidents`** — `app/(app)/incidents/page.tsx`, Server Component, fetches the list via the server's internal API (same fetch pattern as the services pages). Dense table: service · severity · started (relative time via the shared `relativeTime` helper) · duration or **"ongoing"** · resolved/open. Optional `?serviceId=` filter. A thin client wrapper subscribes to `global` and, on `incident.opened` / `incident.resolved`, prepends or updates the affected row (push, not poll). Skeleton loading state matching the table.
- **`/incidents/[id]`** — `app/(app)/incidents/[id]/page.tsx`, Server Component, fetches detail + events. Renders a **vertical timeline** (opened → observed… → resolved), each entry with its `occurredAt`, type, and message. For an ongoing incident, a client child subscribes to `service:<id>` to tick the live duration and, on `incident.resolved`, flip the incident to resolved (showing final duration) — refetching the timeline to surface any interim `observed` events. **`observed` events are not pushed live in 5a** (they're infrequent on-change entries and have no WS event); they render on page load and on the resolve refetch. Adding a live `incident.observed` event is a deferred nicety.
- **Service detail page** — add an "Incidents" section listing that service's recent incidents with a link to `/incidents?serviceId=<id>`. A `down` service shows a subtle "active incident" badge linking to the open incident.
- Navigation entry for Incidents in the app layout.
- A full **frontend-design skill** pass on the timeline and list happens during implementation (per `CLAUDE.md`); pixel design is not specified here.

## Data flow (open → resolve, happy path)

```
check fails (raw down)   → applyCheckResult: consecutiveFailures 0→1
                            decideTransition(up, f=1) → {nextStatus: up,   none}   (invisible strike)
check fails (raw down)   → applyCheckResult: consecutiveFailures 1→2
                            decideTransition(up, f=2) → {nextStatus: down, open}
                            insert incident + 'opened' event; status→down
                            pg_notify service.status_changed + incident.opened
                            → listener → hub → dashboard(global) + detail(service:id) update live
check fails (503 now)    → decideTransition(down, ...) → none; detail changed 500→503
                            insert 'observed' event; no status change, so no pg_notify
                            (observed events are not pushed live in 5a — see UI)
check ok  (raw up)       → consecutiveSuccesses 0→1; decideTransition(down, s=1) → {down, none}
check ok  (raw up)       → consecutiveSuccesses 1→2; decideTransition(down, s=2) → {up, resolve}
                            set resolvedAt/duration/resolutionCheckId; 'resolved' event; status→up
                            pg_notify service.status_changed + incident.resolved
```

## Error handling

- Incident logic runs inside `applyCheckResult`'s transaction: any failure rolls back the check insert + status update together (consistent with today). The worker's per-check try/catch (`check-worker.ts:69`) already ensures one failed apply never crashes the poll loop.
- `pg_notify` payloads are the WS events; the listener `safeParse`s and drops malformed payloads (existing behavior) — a bad emit degrades to "no live update," never a crash.
- API endpoints return the existing RFC-7807-style problem details; internal detail (SQL, etc.) is never leaked to the client.
- The partial unique index is a backstop: if logic ever tried to open a second concurrent incident for a service, the insert fails loudly rather than silently corrupting state.

## Testing (TDD)

- **`workers/transition.test.ts`** — exhaustive pure tests: fail/fail opens; single fail then success (no incident); down + single success (no resolve); down + 2 successes resolves; pending→up immediate; pending→fail/fail opens; flap sequences.
- **`db/repositories/incidents.test.ts`** — `openIncident` (row + opened event, trigger check set); `resolveIncident` (duration math, resolution check set, resolved event); `recordObservationIfChanged` (identical detail ⇒ no event, changed detail ⇒ event); one-open-per-service invariant (second open rejected); pause auto-resolve path; `listIncidents` filters; `getIncidentWithEvents` ownership + ordering.
- **`db/repositories/services.test.ts` (extend)** — `applyCheckResult` sequence tests: fail/fail/ok/ok produces exactly one incident with `opened`+`resolved` events and the right `pg_notify` payloads; counters update correctly; `setPaused(true)` with an open incident auto-resolves.
- **`packages/shared/schemas/ws-event.test.ts` (extend)** — `incident.opened`/`incident.resolved` parse; malformed rejected; discriminated union still narrows.
- **`router.integrations`-style `router` tests** — incidents list/detail: auth required, ownership enforced, `serviceId`/`open` filters, `404` on non-owned/missing.

## What "done" looks like

1. `npm run typecheck` passes (both apps).
2. `npm run lint` clean (both apps).
3. Migration generated, committed, applied locally.
4. Happy path verified end-to-end manually: point a service at a URL, force it to fail twice, watch the dashboard flip to `down` and an incident appear at `/incidents` live; recover it, watch it resolve with a duration and a timeline.
5. At least one failure case handled (single blip → no incident; pause → auto-resolve).
6. `DATA_MODEL.md` updated for the two new `services` counter columns and the partial-unique-open-incident index; `ARCHITECTURE.md` WS-event section updated for the two new event types.
7. Approved before commit; branch `phase-5a-incidents`.
