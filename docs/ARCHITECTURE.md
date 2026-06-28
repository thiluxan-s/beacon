# Architecture

## System diagram

```
                                Internet
                                   │
                                   ▼
                       ┌────────────────────┐
                       │    Namecheap DNS   │
                       │  (no proxy; A only)│
                       └─────────┬──────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   DigitalOcean Droplet │
                    │     Ubuntu 24.04 LTS   │
                    │                        │
                    │  ┌──────────────────┐  │
                    │  │      Caddy       │  │
                    │  │  (reverse proxy  │  │
                    │  │  + auto SSL)     │  │
                    │  └────────┬─────────┘  │
                    │           │            │
                    │     ┌─────┴──────┐     │
                    │     ▼            ▼     │
                    │ ┌───────┐   ┌───────┐  │
                    │ │  Web  │   │  API  │  │
                    │ │ Next  │   │ Hono  │  │
                    │ │  app  │   │+ WS   │  │
                    │ │ :3000 │   │ :3001 │  │
                    │ └───────┘   └───┬───┘  │
                    │                 │      │
                    │                 ▼      │
                    │  ┌─────────────────┐   │
                    │  │   Postgres 16   │   │
                    │  │  (Docker)       │   │
                    │  └─────────────────┘   │
                    │                        │
                    │  ┌─────────────────┐   │
                    │  │  Worker process │   │
                    │  │ (background     │   │
                    │  │  health checks) │   │
                    │  └─────────────────┘   │
                    └───────────┬────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        ┌──────────┐      ┌──────────┐      ┌──────────┐
        │ Vercel   │      │ GitHub   │      │ Monitored│
        │   API    │      │   API    │      │ services │
        │          │      │          │      │  (HTTP)  │
        └──────────┘      └──────────┘      └──────────┘
```

All processes run on a single DigitalOcean Droplet, orchestrated via Docker Compose. Caddy fronts everything, terminates SSL, routes `/` to the Next.js app and `/api/*` + `/ws` to the Hono server.

## The two critical flows

### Flow 1: Background health check → status change → live UI update

```
1. WORKER PROCESS runs continuously, scheduled checks every 60s per service.
2. For each due check:
   - Make HTTP request to service.base_url with configured method/timeout.
   - Record the result in service_checks table (response time, status code, success/fail).
3. If this check result CHANGES the service's status (up → down, down → up, up → degraded):
   - Update service.current_status.
   - Write an incident row (or close an open one).
   - Emit a WebSocket event: { type: 'service.status_changed', payload: { ... } }
   - If status is now "down" and email alerting enabled: queue an alert email.
4. The API server's WebSocket layer fans the event out to all currently-connected clients
   subscribed to that service.
5. The frontend updates the UI in place — the affected service card transitions
   visually, and (if user is on the service detail page) the check history grows.
```

### Flow 2: User adds a service → first check → live in the dashboard

```
1. USER on the dashboard clicks "Add service" → submits the form.
2. SERVER ACTION
   - Validates input (Zod).
   - Inserts a `services` row with status = 'pending'.
   - Inserts a `service_checks` row with status = 'pending' to trigger immediate first check.
   - Calls the worker's "wake up" endpoint to run pending checks immediately.
   - Returns the new service to the client.
3. WORKER picks up the pending check, runs it, follows Flow 1 from step 2.
4. The dashboard already shows the new service (in 'pending' state); when the worker
   completes the first check, the WebSocket event flips it to 'up' or 'down'.
```

This pattern — optimistic insert + worker-driven first check + WebSocket update — is the central UX of the dashboard. It feels instant even though real work is happening in the background.

## Integration Layer — the core abstraction of this project

This is the highest-value section of this document. Read carefully.

### The principle

A *service* is anything we monitor at the HTTP layer. An *integration* adds platform-specific context to a service — recent deploys, build status, repo activity, whatever the platform exposes.

**Services are platform-agnostic. Integrations are platform-specific. They are loosely coupled.**

This means:
- Every service gets uptime monitoring, response times, and SSL/DNS health (where applicable) regardless of platform.
- Integrations are *opt-in*. A service can have zero integrations and still be fully monitored at the HTTP layer.
- A service can have multiple integrations (e.g., a service hosted on Vercel with a GitHub repo backing it — both integrations active, both contributing data).
- Adding a new platform later (Railway, Fly.io, AWS, custom webhook) is *always* a "drop a new file in `apps/server/src/integrations/`" operation.

### The interface every integration implements

```ts
// apps/server/src/integrations/types.ts

export interface IntegrationDefinition {
  // Unique identifier — used as the discriminator in the database.
  readonly id: string; // 'vercel' | 'github' | 'railway' | ...
  
  // Human-readable name for the UI.
  readonly name: string;
  
  // Zod schema for the credentials this integration needs.
  // Encrypted at rest; validated on configuration.
  readonly credentialsSchema: z.ZodSchema;
  
  // Zod schema for any per-service configuration (e.g., the Vercel project ID).
  readonly configSchema: z.ZodSchema;
  
  // Validate that credentials work — called once when the integration is configured.
  // Should make a minimal API call (e.g., "list my projects") to confirm auth.
  testCredentials(credentials: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  
  // Fetch the current platform-specific data for a service.
  // Called periodically (e.g., every 5 minutes) by a background worker.
  // Returns whatever shape the integration needs — typed per-integration.
  fetchData(credentials: unknown, config: unknown): Promise<IntegrationDataSnapshot>;
}
```

`IntegrationDataSnapshot` is intentionally loose — the structure is per-integration. We store it as JSONB in the database and the frontend's per-integration UI knows how to render it.

### The registry

```ts
// apps/server/src/integrations/registry.ts

import { vercelIntegration } from './vercel';
import { githubIntegration } from './github';

export const IntegrationRegistry = new Map<string, IntegrationDefinition>([
  [vercelIntegration.id, vercelIntegration],
  [githubIntegration.id, githubIntegration],
  // Add new integrations here. ONE LINE. That's the whole point.
]);
```

The registry is consulted at runtime when:
- The UI lists available integrations to configure.
- A service-integration link is created (we look up the def to validate credentials).
- The worker runs scheduled integration fetches (it walks active integrations per service).

### Data shape

```
service (id, name, base_url, current_status, paused, ...)
  │
  └── service_integration (id, service_id, integration_id, credentials_encrypted, config, last_snapshot)
          │
          (integration_id is 'vercel' | 'github' | etc. — looked up in the registry)
```

A service has many service_integrations (one per platform). Each holds the encrypted credentials, the per-service config (e.g., which Vercel project), and a cache of the last snapshot.

### Adding a new integration in the future

The promise of the abstraction: a new integration is one file plus one line.

```ts
// apps/server/src/integrations/railway.ts
export const railwayIntegration: IntegrationDefinition = {
  id: 'railway',
  name: 'Railway',
  credentialsSchema: z.object({ apiToken: z.string().min(1) }),
  configSchema: z.object({ projectId: z.string(), environmentId: z.string() }),
  async testCredentials(creds) { /* ... */ },
  async fetchData(creds, config) { /* ... */ },
};

// apps/server/src/integrations/registry.ts
import { railwayIntegration } from './railway';
// ...add to the Map.
```

That's the entire change. No DB schema migrations. No new UI components (the existing "configure integration" UI reads from the registry and renders forms from the Zod schemas). No new routes.

**If a future integration requires changing core code outside `integrations/`, the abstraction is wrong — pause and reconsider.**

## WebSocket layer

### Connection model

- One persistent WebSocket per browser tab. Multiplexed: a single connection carries subscriptions to many topics.
- Topics: `service:<id>` (status updates for a service), `incident:<id>` (events on an incident), `domain:<id>` (domain status), `global` (system-wide events like "service added").
- Client sends `{ type: 'subscribe', topic: 'service:abc123' }` to start receiving events for a topic.
- Server validates the user has access to the topic (currently: single-user, so always yes — but the check is in place for future multi-user support).
- Server tracks `connectionId → Set<topic>` in memory.

### Fan-out

When an event happens (e.g., service status changes), the source code calls:

```ts
broadcast({ type: 'service.status_changed', topic: `service:${id}`, payload: { ... } });
```

The broadcast helper iterates connections subscribed to that topic and sends the message. No queue, no fan-out service — just in-memory iteration. Single-process simplicity.

### Reliability

- Heartbeat: server sends a ping every 30s. Client responds with pong. Two missed heartbeats = server closes the connection.
- Client reconnect: exponential backoff (1s, 2s, 4s, 8s, max 30s), resubscribe to all topics on reconnect.
- Server restart: clients reconnect within seconds. No state to preserve — subscriptions are reestablished.
- The dashboard always shows a connection indicator (small dot in the corner: green = connected, yellow = reconnecting, red = disconnected).

### Why native `ws` and not Socket.io?

Socket.io adds a transport layer, a protocol, a lot of features we don't need (rooms, namespaces, multiple transports). For one-server single-user with simple topics, plain `ws` is fewer dependencies and zero magic. If we ever need horizontal scaling (we won't), Socket.io is a justified addition then.

## Background workers

Two workers run as separate processes inside the Docker Compose stack:

1. **`check-worker`** — runs HTTP health checks on a schedule. Polls the `services` table for due checks (next_check_at < now), executes them, writes results, emits WS events on status change.
2. **`integration-worker`** — runs integration fetches on a (less frequent) schedule. Polls `service_integrations` for due fetches, calls `integration.fetchData()`, stores the snapshot.

Both workers are simple loops:

```ts
while (true) {
  const due = await findDueWork();
  await Promise.all(due.map(processOne));
  await sleep(5000); // check every 5s for new due work
}
```

No queue (Inngest, BullMQ, etc.) needed — Postgres IS the queue. Cheap and easy.

If a worker crashes, Docker restarts it. If it crashes immediately on startup repeatedly, monitor that yourself (via the external UptimeRobot watcher of the dashboard itself).

## Authentication

Single user (me). Two options being considered, decided in Phase 1:

1. **Clerk** — same auth as Wayfare and Investor Thesis. Consistent across all my projects. Free tier handles it easily.
2. **Simple session cookie + bcrypt password** — no third-party. Demonstrates "I can do auth myself." Database has a `users` table with a hashed password, login form, signed cookie.

Both are reasonable. Clerk is faster; the DIY option contributes another "I can do this without a SaaS" data point for the portfolio. **Default to Clerk for speed; revisit if we want to lean harder into the no-SaaS story.**

## Storage and backups

- **Database:** Postgres 16 in Docker on the VPS (assumed; revisit if Phase 1 planning argues for Neon).
- **Backups:** Nightly `pg_dump` cron job. Output piped to `rclone` upload to Cloudflare R2 (S3-compatible, generous free tier). Restore process documented in `INFRASTRUCTURE.md`.
- **Encryption key for integration credentials:** stored in a single env var on the VPS, never in the repo, never logged. Rotation procedure documented in `INFRASTRUCTURE.md`.

## Environment configuration

Server env (`apps/server/src/lib/env.ts`):
- `DATABASE_URL`
- `INTEGRATIONS_ENCRYPTION_KEY` (32 bytes, base64)
- `CLERK_SECRET_KEY` (if using Clerk)
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (for alert emails)
- `LOG_LEVEL` (debug | info | warn | error)

Web env (`apps/web/lib/env.client.ts`):
- `NEXT_PUBLIC_API_URL` (https://api.beacon.thiluxan.com or whatever)
- `NEXT_PUBLIC_WS_URL` (wss://api.beacon.thiluxan.com/ws)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (if Clerk)

## Layers

### Presentation
- Server Components for reads.
- Server Actions for mutations.
- Client Components for WebSocket-subscribed real-time updates only.
- shadcn/ui as primitives. The dashboard density requires more custom composition than Wayfare or Investor Thesis — expect to build component variations on top of shadcn.

### Application
- HTTP routes in `apps/server/src/router.ts`.
- WebSocket handlers in `apps/server/src/ws/`.
- Workers in `apps/server/src/workers/`.
- Business logic in plain functions invoked from routes/workers.

### Data
- Drizzle is the only thing talking to Postgres.
- All queries through `apps/server/src/db/repositories/`.

### Integration layer
- One file per integration in `apps/server/src/integrations/`.
- Registry in `apps/server/src/integrations/registry.ts`.

## What we are *not* building

- No agent / AI loop (this project is deliberately not AI).
- No queue (Postgres is the queue).
- No Kubernetes (one VPS, Docker Compose).
- No GraphQL/tRPC (REST for HTTP, typed WebSocket messages for real-time).
- No frontend state library (Server Components + URL state + WebSocket subscriptions cover it).
- No public status pages.
- No log aggregation (use Docker logs and `docker logs -f` like a normal person).

## Extension seams

This architecture is designed to be extended, not rewritten, as the product evolves. Future features and where they plug in:

| Future feature | Where it plugs in |
|----------------|-------------------|
| New platform integrations (Railway, Fly, Render, AWS) | New file in `apps/server/src/integrations/`. Registry gets one line. No other changes. |
| Custom webhook receiver | New HTTP route + a generic "webhook" integration that stores events. UI renders generic event timeline. |
| SSH-based monitoring (self-hosted Docker hosts) | New integration type. Credentials are SSH keys; `fetchData` shells out to SSH commands. |
| Slack/Discord alerts | New file in `apps/server/src/notifications/` alongside email. Alert dispatcher takes a list of channels. |
| Public status pages | New `app/status/[slug]/page.tsx` route (no auth). Reads from existing tables. Add a `public` flag to services. |
| Multi-user support | The schema already has `user_id` on services etc. Add a session model and ACL checks; UI gets a team-switcher. |
| Anomaly detection | New worker `apps/server/src/workers/anomaly-worker.ts` reads check history, flags outliers, emits alerts. |
| AI-summarized weekly reports | New scheduled job that aggregates the week's events, calls Anthropic API, sends as enhanced digest email. |
| Mobile push notifications | New channel in `notifications/` (web push or APNs/FCM). Alert dispatcher iterates channels. |

The pattern is the same as Investor Thesis: **add files, not refactors.** When designing new features, ask "what new files would this require?" If the answer involves changing core code shape, pause and reconsider.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| The dashboard goes down silently | External UptimeRobot watching the dashboard's own URL. Free tier; pings every 5min. |
| VPS reboots / Docker restart loses background work | Workers are stateless; they pick up due work on restart from the DB. No work is lost, just briefly delayed. |
| Postgres goes down on the VPS | Worker writes fail loudly; UI shows "data unavailable" not crash; nightly backup ensures recovery. |
| SSL cert renewal fails | Caddy logs the failure; UptimeRobot will catch the eventual outage; manual fix takes minutes. |
| Integration API changes (e.g., Vercel changes their API) | Integration's `testCredentials` fails next time it runs; UI flags the integration as broken; I fix the one file. |
| Credentials leak via logs | Centralized logging utility scrubs known sensitive fields; encrypted-at-rest credentials never decrypted into logs. |
| Cost overruns | Single Droplet, fixed monthly cost. Anthropic API not in v1. Backups to R2 free tier. Hard cap: $15/mo. |
| Worker thread blocks event loop on slow checks | All HTTP checks use `AbortController` with hard timeout. Workers iterate concurrently with `Promise.all` capped at N. |
