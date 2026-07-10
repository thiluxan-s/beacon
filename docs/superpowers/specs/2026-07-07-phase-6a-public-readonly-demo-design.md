# Phase 6a — Public Read-Only Demo Mode Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-07
**Depends on:** Phase 5 complete (services, incidents, alerts, domains all merged to `main`).

## Goal

Expose the dashboard read-only at a public URL (`/demo`) so a recruiter can watch real-time status updates on the actual production instance — without a login, and with a hard guarantee they cannot create, edit, delete, pause, or attach anything. Only entities the owner explicitly marks public are shown. This is the keystone code feature of Phase 6 (the "Polish, Demo, Ship" phase): it unlocks the live-demo link the README and demo video depend on.

This is sub-phase **6a** of Phase 6. Phase 6 is a heterogeneous ship checklist, decomposed into: **6a — public read-only demo mode** (this spec); later code passes (landing polish, mobile/responsive, accessibility, OG/favicon); the **README rewrite** (writing); design assets (architecture diagram, demo video); and ship/ops (custom domain, security review, runbook verify, portfolio entry). Those are separate tracks, not part of 6a.

## Non-goals (YAGNI / deferred)

- **Public write/interactivity of any kind.** The public view only reads. No public sign-up, no "claim a demo account," no comments.
- **Multi-tenant public pages.** Single owner (`PUBLIC_OWNER_CLERK_ID`); not a per-user public-status-page product.
- **Live public domains.** Domains have no WS events (5c decision); the public domains list is server-rendered and refreshes on load, not via WS. Only services + incidents are live on `/demo`.
- **Exposing config/credentials/settings/URLs.** The public DTOs are minimal (name/status/timings); base URLs, health paths, integration data, alert settings, and the `/settings` surface are never on the public path.
- **Uptime %/analytics on the public view.** Out of scope for 6a; the public view shows current status + recent incidents, not historical rollups.
- **A separate public subdomain.** `/demo` on the same host is enough; the custom-domain work is a separate Phase 6 item.
- **Rate limiting / abuse protection beyond read-only scoping.** The anon WS is receive-only and public-scoped; dedicated rate limiting is deferred (no measured need).

## Key decisions (from brainstorm)

1. **Per-entity opt-in `is_public` flag** on `services` and `domains` (default `false`). Incidents inherit from their service. Nothing is public until explicitly toggled.
2. **Anonymous read-only WebSocket** for liveness — an unauthenticated connection in "public mode" that can only subscribe to `is_public` service topics and only receives status/incident broadcasts. The client→server message schema is only `subscribe`/`unsubscribe`, so there is no mutation frame to abuse.
3. **`PUBLIC_OWNER_CLERK_ID` env gate** (optional). Unset → public mode is fully off: the public endpoints and the anon WS are disabled and `/demo` shows a "not enabled" state. Safe-by-default, like the optional Resend vars.
4. **Dedicated read-only web components** (not the authed lists reused with a flag) — a small, deliberate duplication that guarantees no mutation control can leak onto the public path.
5. **Public URL is `/demo`.**

## Architecture fit

The read-only guarantee's backbone already exists and is not being weakened:
- Every mutation is a **Server Action** requiring a Clerk session (`requireClerkId()` throws without one), and those call the **internal API which requires a server-only secret** (`INTERNAL_API_SECRET`). An anonymous visitor has neither wall's key.
- The WebSocket already only accepts two client message types (`subscribe`/`unsubscribe`) — there is no write path over the socket.

So 6a adds a **parallel read-only lane** beside the authed app: two `is_public` flags, a set of public read endpoints, an anonymous WS mode, and a public `/demo` route with dedicated read-only components — without touching the mutation path. The existing `ConnectionHub` already routes broadcasts by `event.userId` + topic subscription; the anon lane reuses that, scoping subscriptions to public topics.

## Design

### Schema additions

```ts
services.isPublic:  boolean('is_public').notNull().default(false)
domains.isPublic:   boolean('is_public').notNull().default(false)
```
No `is_public` on incidents — visibility inherits from the incident's service (`incidents JOIN services ON … WHERE services.is_public`). Migration generated, committed, applied locally.

### Feature gate

`env.ts`: `PUBLIC_OWNER_CLERK_ID: z.string().optional()`. A helper `publicModeEnabled(): boolean` = the var is set. When disabled, the public read endpoints return `404` and the anon WS connect is rejected; `/demo` renders the "not enabled" state. `.env.example` documents it.

### Repositories

- `services.ts`: `listPublicServices()` → services `WHERE is_public = true`; `isServicePublic(serviceId): Promise<boolean>` (exists AND `is_public`). Add `isPublic: z.boolean().optional()` to `ServiceUpdateSchema`'s `.extend({...})` (alongside `paused`/`alertsEnabled`); the existing `updateService` already spreads the patch into `.set(...)`, so the column update works once the schema field + DB column exist.
- `incidents.ts`: `listPublicIncidents()` → incidents joined to `services WHERE is_public = true`, newest first.
- `domains.ts`: `listPublicDomains()` → domains `WHERE is_public = true`; `setDomainPublic(userId, id, isPublic): Promise<Domain | null>` (uuid-guarded, owner-scoped), exposed via `POST /internal/domains/:id/visibility` (body `{ isPublic: boolean }`, mirroring the recheck endpoint).

### Public read endpoints (`router.ts`, secret-gated, no user resolution)

Behind a new `app.use('/internal/public/*', …)` secret guard. Each returns `404` when `!publicModeEnabled()`, else a **minimal public DTO array**:
- `GET /internal/public/services` → `{ id, name, currentStatus, lastCheckAt }[]`.
- `GET /internal/public/incidents` → `{ id, serviceName, severity, startedAt, resolvedAt, durationSeconds }[]`.
- `GET /internal/public/domains` → `{ id, domain, currentStatus, sslExpiresAt, domainExpiresAt }[]`.

No base URLs, health paths, config, credentials, or alert settings in any public DTO.

### Anonymous read-only WebSocket

- **Connect** (`ws/server.ts` upgrade + `ws/auth.ts`): a connection with `?public=1` and no token is a **public** connection. `authenticateConnection` gains a public path: when `publicModeEnabled()`, resolve `PUBLIC_OWNER_CLERK_ID` → the owner's `userId` and return `{ userId, public: true }`; when disabled, return `null` (rejected → socket closed, as today). A normal token connection is unchanged (`public: false`).
- **`Conn` gains `public: boolean`** (`ConnectionHub.add(ws, userId, isPublic)`).
- **Subscribe** (`connections.ts`): for a `public` conn, `subscribe` **rejects `global`** and, for `service:<id>`, checks `isServicePublic(serviceId)` (new dep, replacing the ownership check) — a public conn can only subscribe to public services' topics. A non-public conn is unchanged (ownership check).
- **Receive-only:** the anon conn receives `service.status_changed` / `incident.*` broadcasts (the hub already routes incidents on `service:<serviceId>`) for its subscribed public topics. No mutation frame exists to handle.

### Web

- **`app/demo/page.tsx`** (public Server Component, NOT under `(app)`): if `!publicModeEnabled` (detected via the endpoints 404-ing, surfaced as a disabled state) → "public demo not enabled." Else fetches the three public endpoints and renders a read-only dashboard with a banner "Read-only · live public dashboard" (a fixed string; single-owner, no name injected). Wrapped in a `PublicWsProvider`.
- **`components/public/`** — `PublicServicesList`, `PublicIncidentsList`, `PublicDomainsList` (client): render the minimal DTOs; services/incidents subscribe to the anon WS (`service:<id>` per public service) for live status; **no** action components composed. Domains render static (no WS).
- **`lib/public-api.ts`** (server-only): `fetchPublicServices/Incidents/Domains` — hit the public endpoints with the internal secret; a `404` (disabled) surfaces as a `null`/disabled signal to the page.
- **WS client (`lib/ws-client.ts` / `use-ws`)**: a **public mode** — `new BeaconSocket({ url, public: true })` connects with `?public=1` and skips `getToken`. `PublicWsProvider` (client) wraps `/demo` and reuses the subscribe API.
- **Middleware (`middleware.ts`)**: add `'/domains(.*)'` to the protected matcher (missed in 5c); confirm `/demo` is **not** protected.
- **`/settings` — "Public dashboard" section**: lists services + domains, each with a public toggle (reusing the alerts per-entity toggle pattern) → `toggleServicePublicAction` (via the service `PATCH`) / `toggleDomainPublicAction` (via the new domain visibility endpoint); plus a "View public dashboard →" link to `/demo`.
- Full **frontend-design** pass on `/demo` (it's recruiter-facing — the live public surface).

### Env / infra

- `PUBLIC_OWNER_CLERK_ID` (server, optional) in `env.ts` + `.env.example`. The public WS reuses `NEXT_PUBLIC_WS_URL` with `?public=1`.
- `INFRASTRUCTURE.md`: note the public mode + the env var; `DATA_MODEL.md`: the two `is_public` columns.

## Data flow (a recruiter on `/demo`)

```
GET /demo (public, no Clerk session)
  Server Component → fetchPublic{Services,Incidents,Domains} (internal secret, is_public rows only)
  render read-only lists + banner
  PublicWsProvider → WS connect ?public=1 (no token)
    server: publicModeEnabled? → owner userId, public:true conn  (else close)
  client subscribes service:<id> for each public service
    subscribe: public conn + isServicePublic(id) → allowed (global / private → refused)
  owner's service goes down → pg_notify → hub broadcasts → anon conn receives status_changed → dot flips live
  (a create/edit/delete attempt has no UI, and no session/secret to reach a mutation) 
```

## Error handling

- Public mode disabled (`PUBLIC_OWNER_CLERK_ID` unset): endpoints `404`, anon WS rejected, `/demo` shows the disabled state — never a crash.
- An anon WS that tries to subscribe to `global` or a private/non-public service topic is refused (`subscribe` returns false); it simply never receives those events.
- Public endpoints leak no internal detail (minimal DTOs; RFC-7807-style errors otherwise).
- The owner's own authed app is unchanged — normal token WS connections and the full `(app)` still work exactly as before.

## Testing (TDD)

- **`ws/auth.test.ts` (extend):** a public-marker connection resolves to `{ userId: owner, public: true }` when `PUBLIC_OWNER_CLERK_ID` is set; returns `null` when unset; a normal token path is unchanged.
- **`ws/connections.test.ts` (extend):** a `public` conn — `subscribe('global')` → false; `subscribe('service:<private>')` → false; `subscribe('service:<public>')` → true (via injected `isServicePublic`). A non-public conn is unchanged.
- **`db/repositories` (integration):** `listPublicServices`/`listPublicIncidents`/`listPublicDomains` return only `is_public` rows (a private entity is excluded; a public service's incident is included, a private service's is not); `isServicePublic` true/false; `setDomainPublic` sets + is owner-scoped.
- **`router` tests:** `/internal/public/*` — `404` when disabled; when enabled, return only public rows; secret-gated (401 without it).
- **`packages/shared`:** `ServiceUpdateSchema` accepts `isPublic`.
- **Web:** no component tests (convention) — typecheck + lint, plus the manual "poke at it as a recruiter" pass (below).

## What "done" looks like

1. `npm run typecheck` + `npm run lint` clean (all workspaces).
2. Migration generated, committed, applied (the two `is_public` columns).
3. `PUBLIC_OWNER_CLERK_ID` in `.env.example` + `env.ts`.
4. Happy path: with public mode enabled and a service/domain marked public, `/demo` (in a logged-out browser) shows those entities read-only; force a public service down → the dot flips **live** with no login; a private service never appears.
5. **Enforcement verified (the phase doc's emphasis):** logged out, there is no add/edit/delete/pause/recheck control on `/demo`; the anon WS refuses `global` and private-service subscriptions; hitting a mutation Server Action with no session fails; `/internal/public/*` needs the secret. Toggling public mode off (`PUBLIC_OWNER_CLERK_ID` unset) makes `/demo` show "not enabled" and the anon WS reject.
6. `/domains` added to the Clerk protected matcher; `/demo` confirmed public.
7. `DATA_MODEL.md` + `INFRASTRUCTURE.md` updated.
8. Approved before commit; branch `phase-6a-public-demo`.
