# Phase 3 — Slice B: Real-Time WebSocket Updates — Design Spec

**Date:** 2026-06-29
**Phase:** 3 (Health Checks & Real-Time). Slice A (services + check worker) shipped; this is Slice B.
**Status:** design approved; pending implementation plan.

## Goal

Make the dashboard *live*: when the check worker flips a service's status, the change streams to the browser over a WebSocket and the UI updates in place — no refresh. Add the service detail page (deferred from Slice A) whose status updates live, and the connection-state indicator. The "watch a status flip red↔green in real time" moment becomes real.

## Scope

**In scope (Slice B):**
- Cross-process event bridge: the worker publishes status changes via Postgres `LISTEN/NOTIFY`; the server relays them to WebSocket clients.
- A WebSocket server in the Hono process: Clerk-authenticated connections, multiplexed topic subscriptions with an ownership ACL, heartbeat, in-memory fan-out.
- A browser WebSocket client: singleton connection, reconnect with exponential backoff, resubscribe on reconnect, connection-state exposure.
- Live wiring: the dashboard cards and the service detail page update status in place on `service.status_changed`. A corner connection indicator.
- The service detail page (`/services/[serviceId]`) with server-rendered recent check history.
- The nightly `service_checks` 30-day cleanup job (deferred from Slice A) in the worker.

**Out of scope (deferred):**
- Live per-check streaming into the detail-page history (status-only liveness chosen). Incidents, `degraded`, flapping → Phase 5. Domains. Multi-user (the ACL is built but single-user in practice).

## Key decisions

1. **Worker→WS bridge = Postgres `LISTEN/NOTIFY`.** The worker (separate process) issues `pg_notify('beacon_events', <json>)` on a status change; the server holds a dedicated `LISTEN beacon_events` connection and fans the event out to subscribed WS clients. No new infrastructure, fully decouples the worker from the WS transport, survives independent process restarts.
2. **WS auth = verify the Clerk session on connect.** The browser passes its Clerk session JWT when opening the WS; the server `verifyToken`s it (`@clerk/backend`), resolves `clerkUserId → userId`, and scopes all subscriptions to that user. Connect-time verification only (session tokens are short-lived; a fresh token is fetched on each reconnect).
3. **Status-only liveness.** Slice B broadcasts only `service.status_changed`. The dashboard cards and the detail page header update live; the detail page's check-history list is server-rendered and updates on navigation. Per-check streaming is deferred.
4. **NOTIFY is emitted inside `applyCheckResult`'s transaction**, only when the status actually changes — so an event fires if and only if the status write commits (no missed or phantom events). `applyCheckResult` remains the single status-write seam.

## Architecture & data flow

```
worker.applyCheckResult (status changed; inside the txn)
  └─ pg_notify('beacon_events', {type:'service.status_changed', userId, serviceId, status, previousStatus, occurredAt})
        │  (delivered on commit)
        ▼
server: dedicated LISTEN connection receives the notification
  └─ broadcast to WS clients subscribed to `global` AND `service:<serviceId>`, filtered to that userId
        ▼
browser WS client → dispatch to the matching dashboard card / detail page header → UI updates in place
```

**Topics:** `global` (all of the user's status changes — the dashboard subscribes here) and `service:<id>` (one service — the detail page subscribes here). Each status change is broadcast to both.

## Dependencies, environment, infrastructure

- **Server deps (stack-approved):** `ws` + `@types/ws` (the locked-in WebSocket library); `@clerk/backend` for `verifyToken`.
- **Server env (new):** `CLERK_SECRET_KEY` — the server now verifies Clerk JWTs. Already present in `/opt/beacon/.env`; add to `apps/server/src/lib/env.ts` and `.env.example`.
- **Web env (new):** `NEXT_PUBLIC_WS_URL` — `wss://api.beacon.thiluxan.com/ws` (prod), `ws://localhost:3001/ws` (local). Add to `env.client.ts` and `.env.example`.
- **Infrastructure:** Caddy already reverse-proxies the API host to `server:3001` and upgrades WebSocket connections automatically, so `/ws` needs no Caddy change. `/internal/*`→404 does not match `/ws`.

## Server — WebSocket layer (`apps/server/src/ws/`)

- **`ws/server.ts`** — attach a `ws` `WebSocketServer` (`noServer: true`) to the Node HTTP server returned by `@hono/node-server`'s `serve()`, handling the `upgrade` event for path `/ws`.
- **`ws/auth.ts`** — `authenticateConnection(token): Promise<{ userId } | null>`: `verifyToken` the Clerk JWT, then `getByClerkId` → internal `userId`. Reject (close with a policy code) on missing/invalid token or unknown user.
- **`ws/connections.ts`** — the in-memory registry `Map<connId, { ws, userId, topics: Set<string> }>`; `subscribe`/`unsubscribe` with a **topic ACL** (`service:<id>` requires `getService(userId, id) !== null`; `global` always allowed for the connection's own user); 30s heartbeat ping with pong tracking, drop after 2 missed; `broadcast(topic, event)` iterating connections subscribed to the topic whose `userId` matches the event's `userId`.
- **`ws/listener.ts`** — a dedicated long-lived `pg` client running `LISTEN beacon_events` (separate from the Drizzle pool); parse each payload (validated by the shared event schema) and call `broadcast` for `global` + `service:<serviceId>`; reconnect the LISTEN client with backoff if it drops.
- **Wire-up** in `apps/server/src/index.ts`: after `serve()`, attach the WS server and start the listener.

## Server — events & detail-page data

- **Shared event schema** (`packages/shared`): `WsEventSchema` — a discriminated union on `type`; v1 member `service.status_changed` with payload `{ serviceId, userId, status, previousStatus, occurredAt }`. Used for both the NOTIFY payload and the WS message envelope, so server and client agree.
- **`applyCheckResult`** (existing, `services.ts`): when `statusChanged`, within the same transaction, emit `select pg_notify('beacon_events', <WsEvent json>)`.
- **Detail-page data:** `GET /internal/services/:id/checks?limit=N` (guarded by `x-internal-secret` + `x-clerk-user-id`, ownership-scoped) → repo `listChecks(userId, serviceId, limit)` → recent `service_checks` newest-first. `ServiceCheckDto` added to the web client.

## Web — real-time UI

- **`lib/ws-client.ts`** — a browser singleton: opens one WS to `NEXT_PUBLIC_WS_URL` with the Clerk token; reconnect with exponential backoff (1s→2s→4s→8s… capped 30s) and resubscribe to all topics on reconnect; `subscribe(topic, handler)` / `unsubscribe`; responds to server pings; exposes `connectionState` (`connected | reconnecting | disconnected`).
- **Token plumbing:** a thin React provider/hook supplies the Clerk session token (`useAuth().getToken()`) to the singleton and re-fetches it on reconnect.
- **`useLiveServices(initial)` / `useLiveService(initial)`** — the dashboard list and detail header become thin **client** components that hydrate from server-fetched data and patch state on `service.status_changed` (dashboard subscribes `global`; detail subscribes `service:<id>`).
- **Connection indicator** — a small corner dot (green = connected, yellow = reconnecting, red = disconnected) in the app shell, reading the singleton's state.
- **Service detail page** (`app/(app)/services/[serviceId]/page.tsx`) — Server Component fetching the service + last N checks; a client header subscribes to `service:<id>` and updates status live; the check-history list is server-rendered. Dashboard cards link to it.

## Worker — cleanup job

In the worker loop, a once-per-day tick (gated by an in-process `lastCleanupAt`): `deleteChecksOlderThan(30)` (new repo function deleting `service_checks` with `checked_at < now() - 30 days`). Stateless; safe to run on any worker start.

## Error handling

- WS connect: invalid/missing token → close with a policy code; the client treats an auth-close as fatal (does not infinitely retry a bad token) but retries on transient network closes.
- LISTEN connection drop → reconnect with backoff; on reconnect, the server's in-memory subscriptions are intact (only the pg LISTEN socket re-establishes). A brief gap may drop events; acceptable (the next status change re-asserts).
- Broadcast to a dead socket is caught and the connection cleaned up; one bad client never affects others.
- The browser singleton degrades to the connection indicator showing "reconnecting"; the last server-rendered state remains visible (no crash, no fake data).

## Testing (TDD)

- **Unit (no I/O):** the WS message protocol parse/serialize; the topic-ACL decision function; the reconnect backoff calculator; the NOTIFY payload (de)serialization against `WsEventSchema`.
- **Integration (Postgres):** `listChecks` ownership-scoped; `applyCheckResult` emits a NOTIFY only on status change (LISTEN on a test connection, assert the payload); the listener→broadcast path delivers to a fake subscribed connection and respects the userId filter + topic ACL.
- The browser singleton's reconnect/resubscribe is exercised by a focused unit test on the backoff/resubscribe logic; full connect is manual.

## Definition of done

Per `CLAUDE.md`: typecheck + lint clean (all workspaces); happy path works end-to-end (a worker status flip updates the dashboard live without refresh); failure cases handled (WS drop → reconnecting indicator, invalid token → clean close); new env in `.env.example` + `env.ts`/`env.client.ts`; `INFRASTRUCTURE.md` updated (the `/ws` endpoint, `NEXT_PUBLIC_WS_URL`, `CLERK_SECRET_KEY` on the server); commits explain *why*; human approval before each commit.
