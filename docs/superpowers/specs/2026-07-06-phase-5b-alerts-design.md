# Phase 5b — Alerts Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-06
**Depends on:** Phase 5a (incidents) complete, merged to `main` (PRs #11, #12).

## Goal

When an incident opens, email me. When it recovers on its own, email me a resolution follow-up. A settings page lets me turn alerts on/off globally and per-service and set the destination address. Delivery is durable (survives worker restarts, retries transient failures) and de-duplicated (never two emails for the same incident event).

This is sub-phase **5b** of Phase 5 (Incidents, Alerts, Domains). **5c — Domains** (DNS/SSL/WHOIS worker + `/domains` UI) remains and is independent of 5a/5b.

## Non-goals (YAGNI / deferred)

- **Non-email channels** (Slack, Discord, push, webhooks). `alerts_sent.channel` is an enum with only `'email'` this phase; the shape leaves room but nothing else is built.
- **Per-service destination addresses / routing rules / escalation / on-call.** One global destination (with the Clerk email as fallback). PRD explicitly rules out paging/escalation.
- **Alert throttling beyond incident-level dedup** (digests, rate limits, quiet hours).
- **Domains and everything in 5c.**
- **Rich HTML email templates / branding.** A clean, plain, legible email is enough for v1; no template engine.
- **Retry backoff / max-attempts ceiling.** The reconciler retries a failed send every tick; a *persistently* failing send (bad config) re-attempts each interval. Acceptable for single-user v1 — a misconfiguration is noticed immediately. A backoff/ceiling is a later concern.

## Key decisions (from brainstorm)

1. **Delivery = polling reconciler worker.** A new background loop (a 3rd loop alongside the check + integration workers) scans for incidents needing an open/resolve email, sends, and records. Durable and retry-capable — this is what 5a's half-built `incidents.notification_sent` flag + the planned `alerts_sent` table were designed for. Chosen over a `pg_notify` listener (fire-and-forget: a listener down during the notify loses the alert) and over inline-in-the-check-worker (couples email to the check loop; a slow Resend call blocks a check slot; pause-resolves live in a request handler, needing a 2nd path).
2. **Global settings live in a dedicated `notification_settings` table** (one row per user), not on `users` (which the Clerk webhook overwrites on every sync) and not in env (the phase needs a settings *page*).
3. **Resolve email fires only when we sent the open email AND the incident recovered on its own.** Pause auto-resolves are silent (you paused it deliberately). Incidents that were never open-alerted (alerts off at open time) stay silent both ways.
4. **Resend via `fetch` (its REST API), no new dependency** — consistent with the native-`ws` / no-socket.io minimalism.
5. **`RESEND_API_KEY` is optional.** Unset → the email lib no-ops and the reconciler skips with a log line, so local dev without Resend runs cleanly.

## Architecture fit

5a emits `incident.opened` / `incident.resolved` over `pg_notify` for the WebSocket layer, but **alerts do not consume that stream** — they reconcile off table state, which is what makes them durable. The dedup discriminators already exist on `incidents` after 5a:

- `notification_sent` (bool) → repurposed as "the open alert was sent" (denormalized fast-path filter).
- `resolution_check_id` (uuid, nullable) → the **recovery-vs-pause discriminator**: real recovery sets it to the resolving check's id; pause auto-resolve leaves it `null`.

So 5b adds exactly one incident-adjacent table (`alerts_sent`), one settings table, a Resend email lib, a reconciler worker, two read/write endpoints, and a settings page. The reconciler joins to a new `alerts` repository; nothing in the 5a check/incident path changes except that `applyCheckResult`/`setPaused` already set the fields we rely on.

The email/Resend layer is **not** an `IntegrationRegistry` integration — integrations are per-service platform data sources (Vercel/GitHub). Email is a notification channel: a plain server lib.

## Design

### Schema additions

**`alerts_sent`** — the send ledger + dedup source of truth:
```ts
{
  id: uuid (pk, defaultRandom)
  incidentId: uuid (fk → incidents.id, on delete cascade, indexed)
  channel: alertChannel('email')          // enum ['email']
  kind: alertKind                          // enum ['opened','resolved']
  status: alertStatus                      // enum ['sent','failed']
  sentAt: timestamptz (not null, defaultNow)
  createdAt: timestamptz
}
```
- Index: `index('alerts_sent_incident_idx').on(incidentId)`.
- **Partial unique** `uniqueIndex('alerts_sent_one_per_kind_idx').on(incidentId, channel, kind).where(sql\`status = 'sent'\`)` — at most one *successful* send per `(incident, channel, kind)`; makes a duplicate ledger row structurally impossible. Failed rows are unconstrained (auditable, and their absence of a `sent` peer is what drives retry).

New enums: `alertChannel = pgEnum('alert_channel', ['email'])`, `alertKind = pgEnum('alert_kind', ['opened','resolved'])`, `alertStatus = pgEnum('alert_status', ['sent','failed'])`.

**`notification_settings`** — one row per user:
```ts
{
  id: uuid (pk, defaultRandom)
  userId: uuid (fk → users.id, on delete cascade, UNIQUE)
  alertsEnabled: boolean (not null, default true)   // global master switch
  alertEmail: text (nullable)                        // null → fall back to users.email
  createdAt / updatedAt: timestamptz
}
```

No new columns on `incidents` or `services` — `notification_sent`, `resolution_check_id`, and `services.alerts_enabled` all exist from earlier phases.

Migration generated via `npm run db:generate`, committed, applied locally and (at deploy) in production. Verify the partial-unique `WHERE status = 'sent'` clause survives generation (Drizzle sometimes drops index `.where()` — hand-edit the SQL if missing).

### `alerts` repository (`db/repositories/alerts.ts`)

```ts
export type AlertKind = 'opened' | 'resolved';

// Incidents whose OPEN email is due: open, not yet open-alerted, and alerts on
// (global COALESCE(ns.alerts_enabled,true) AND service.alerts_enabled).
// Returns the data the email needs (service name, failure detail, owner email + override).
findIncidentsNeedingOpenAlert(limit: number): Promise<AlertTarget[]>;

// Incidents whose RESOLVE email is due: resolved, open-alerted (notification_sent=true),
// recovered on its own (resolution_check_id IS NOT NULL), no alerts_sent(resolved,sent) yet.
// NOT gated on the current toggle — if we sent "down", we send "recovered".
findIncidentsNeedingResolveAlert(limit: number): Promise<AlertTarget[]>;

// On success (opened): set incidents.notification_sent = true AND insert alerts_sent(opened,sent) — one tx.
// On success (resolved): insert alerts_sent(resolved,sent).
// On failure: insert alerts_sent(kind,failed). All via this repo.
recordAlertSent(tx-or-db, { incidentId, kind }): Promise<void>;
recordAlertFailed(tx-or-db, { incidentId, kind }): Promise<void>;
markOpenNotified(tx, incidentId): Promise<void>;   // used with recordAlertSent('opened')
```

`AlertTarget` carries: `incidentId`, `serviceId`, `serviceName`, `severity`, `startedAt`, `resolvedAt`, `durationSeconds`, the opening failure detail (see below), and the resolved destination email (`alert_email ?? users.email`).

**Failure-detail source for the open email:** the incident's `opened` `incident_event.message` already holds the human string (e.g. `"HTTP 500"`) written in 5a. The open-alert query joins that `opened` event and uses its `message` verbatim for the email body — no re-derivation, no reading of the raw check. (An incident always has exactly one `opened` event, written in the same transaction as the incident row.)

### `notification-settings` repository (`db/repositories/notification-settings.ts`)

```ts
getResolvedSettings(userId): Promise<{ alertsEnabled: boolean; alertEmail: string }>;
// no row → { alertsEnabled: true, alertEmail: users.email }; row with null alert_email → users.email.
upsertSettings(userId, { alertsEnabled?: boolean; alertEmail?: string | null }): Promise<void>;
```

### Email library (`lib/email.ts`)

```ts
type SendResult = { ok: true } | { ok: false; error: string };
sendEmail(input: { to: string; subject: string; text: string }): Promise<SendResult>;
```
- Thin wrapper over `POST https://api.resend.com/emails` via `fetch`, `Authorization: Bearer ${RESEND_API_KEY}`, `from: ALERT_FROM_EMAIL`. No SDK dependency.
- **If `RESEND_API_KEY` OR `ALERT_FROM_EMAIL` is unset** (either one — both are optional env): return `{ ok: false, error: 'alerts disabled: email not configured' }` without calling out (and the reconciler logs once + skips — see below). Never throws. A single exported `alertsConfigured()` helper (both env present) gates both the lib and the worker so they agree.
- Non-2xx from Resend → `{ ok: false, error }` with the status; internal detail logged, never surfaced.
- Message builders (pure, unit-testable): `openEmail(target)` and `resolveEmail(target)` produce `{ subject, text }`. Open: service name, "is DOWN", the failure detail, and the incident link `${WEB_ORIGIN}/incidents/${incidentId}`. Resolve: service name, "has RECOVERED", duration (`formatDuration`-style), the link.

### Reconciler worker (`workers/alert-worker.ts`)

```ts
runAlertWorker(deps?: { send?: typeof sendEmail }): Promise<never>;  // deps for tests
```
- Loop every `ALERT_POLL_INTERVAL_MS` (~12s), `BATCH_LIMIT` per kind.
- If email is not configured (`alertsConfigured()` false — `RESEND_API_KEY` or `ALERT_FROM_EMAIL` missing): log once ("alerts disabled: email not configured") and idle (no queries) — dev-friendly.
- Each tick: `findIncidentsNeedingOpenAlert` → for each, `send(openEmail(t))`; on ok → tx { `markOpenNotified` + `recordAlertSent(opened)` }; on failure → `recordAlertFailed(opened)`. Then the same for resolve.
- Per-incident `try/catch` so one failure never blocks the batch; per-tick `try/catch` so the loop never crashes (mirrors `check-worker`).
- Registered as a 3rd loop in `workers/index.ts`.
- **At-least-once:** the send is external, the mark is a subsequent DB write; a crash in that tiny window re-sends once next tick. Acceptable for v1; the partial-unique keeps the ledger single-rowed.

### HTTP API (`router.ts`, `/internal/*`, own auth guards)

- `GET /internal/notification-settings` → `getResolvedSettings(userId)`.
- `PUT /internal/notification-settings` → `upsertSettings`, body validated by `NotificationSettingsUpdateSchema`.
- Two new `app.use('/internal/notification-settings', …)` + `/*` secret guards (the `/internal/services*` middleware doesn't cover this path — same pattern as `/internal/incidents`).
- Per-service alert toggle reuses the existing `PATCH /internal/services/:id` (`ServiceUpdateSchema.alertsEnabled`). No new route.

### Shared schema (`packages/shared`)

```ts
NotificationSettingsUpdateSchema = z.object({
  alertsEnabled: z.boolean().optional(),
  alertEmail: z.string().email().nullable().optional(),
});
```

### Web (`apps/web`)

- `lib/notification-settings-api.ts` (server-only): `fetchNotificationSettings`, `updateNotificationSettings` — mirrors `services-api.ts`.
- `app/(app)/settings/page.tsx` (Server Component): fetches settings + the service list.
  - **Global alerts** section: an on/off toggle bound to `alertsEnabled`, and a destination-email input whose placeholder is the resolved Clerk email when no override is set. Saved through a server action → `PUT`.
  - **Per-service alerts** section: a compact list of services, each with an alerts toggle writing `alerts_enabled` via the existing service update path.
- Small client toggle component(s) + server action(s), following the `service-row-actions` pattern (no state library). A `SETTINGS` link added to the `(app)` layout nav.
- Design pass via the frontend-design skill (settings is a plain form; keep it consistent with the existing surfaces — not a headline screen).

### Env / infra

- `env.ts`: `RESEND_API_KEY: z.string().optional()`, `ALERT_FROM_EMAIL: z.string().email().optional()` — **both optional** so dev without Resend boots cleanly; `alertsConfigured()` = both present. `.env.example` (server) updated with both + a comment that the from-domain must be verified in Resend.
- `INFRASTRUCTURE.md`: a Resend section — account, verified sending domain, the two prod env vars (the worker process reads them).
- `DATA_MODEL.md`: `alerts_sent` + `notification_settings` tables documented.

## Data flow (open → resolve, happy path)

```
incident opens (5a)            → notification_sent=false, no alerts_sent rows
alert worker tick              → findNeedingOpenAlert picks it (alerts on)
                                 send openEmail → ok
                                 tx: notification_sent=true + alerts_sent(opened,sent)
next tick                      → not re-picked (notification_sent=true)
incident recovers on its own   → resolved_at set, resolution_check_id NOT NULL
alert worker tick              → findNeedingResolveAlert picks it (open-alerted, recovered, no resolved-sent)
                                 send resolveEmail → ok → alerts_sent(resolved,sent)
--- vs pause ---
incident resolved by pause     → resolution_check_id NULL → never picked for a resolve email
```

## Error handling

- `sendEmail` never throws; failures become `alerts_sent(failed)` rows and retry next tick.
- The worker's per-incident and per-tick `try/catch` guarantee one bad send or a DB blip can't crash the loop or block other alerts.
- `RESEND_API_KEY` unset is a normal (dev) state, not an error — logged once, no send attempts.
- API returns the existing RFC-7807-style problem details; no internal/email detail leaked to the client. The destination email is only ever the owner's own.

## Testing (TDD)

- **`lib/email.test.ts`** — `openEmail`/`resolveEmail` builders produce the right subject/body incl. the `WEB_ORIGIN` link; `sendEmail` no-ops (returns the disabled result) when either env var is unset; maps a mocked non-2xx `fetch` to `{ ok:false }`; a 2xx to `{ ok:true }`. (`fetch` injected/mocked; no network.)
- **`db/repositories/alerts.test.ts`** (integration) — open-needed honors global-off, service-off, and excludes already-open-alerted; resolve-needed requires open-alerted + `resolution_check_id NOT NULL` (excludes pause-resolves) + no prior resolved-sent; `recordAlertSent`/`Failed` write the right rows; the partial-unique rejects a 2nd `(incident,email,opened,sent)`.
- **`db/repositories/notification-settings.test.ts`** (integration) — default when no row (enabled + users.email); upsert; `alert_email` null → fallback, set → override.
- **`workers/alert-worker.test.ts`** (integration, injected mock `send`) — a seeded open incident gets one open email + is marked; a 2nd tick sends nothing (dedup); a recovered-on-its-own incident gets a resolve email; a pause-resolved incident gets none; a `send` that returns failure records `failed` and retries next tick; one failing target doesn't stop the others.
- **`router` tests** — settings GET/PUT: auth (401 without secret / unknown user), ownership, validation (bad email → 400).
- **`packages/shared`** — `NotificationSettingsUpdateSchema` accepts/ rejects the right shapes.
- Web: no component tests (convention) — typecheck + lint.

## What "done" looks like

1. `npm run typecheck` + `npm run lint` clean (all workspaces).
2. Migration generated, committed, applied locally; partial-unique `WHERE status='sent'` present.
3. New env vars in `.env.example` + `env.ts` (`RESEND_API_KEY` + `ALERT_FROM_EMAIL`, both optional).
4. Happy path verified end-to-end: break a service → receive a "down" email with the incident link; recover it → receive a "recovered" email with duration. Toggle global off → no email. Pause a down service → no email.
5. Failure case handled: email not configured (`RESEND_API_KEY` or `ALERT_FROM_EMAIL` unset) runs cleanly (no crash, no send); a Resend non-2xx records `failed` and retries.
6. `DATA_MODEL.md` (two tables) + `INFRASTRUCTURE.md` (Resend) updated.
7. Approved before commit; branch `phase-5b-alerts`.
