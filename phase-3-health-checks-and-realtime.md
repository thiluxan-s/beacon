# Phase 3 — Health Checks & Real-Time Updates

**Goal:** Services can be added through the UI, the background worker runs HTTP health checks on schedule, status flips happen in the DB, and the dashboard updates live via WebSockets. The "real-time" part of the project becomes real.

**Prerequisite:** Phase 2 complete (production deploy works).

> Read `docs/ARCHITECTURE.md` "WebSocket layer" and "Background workers" sections carefully before planning.

## Deliverables (high level)

1. Schema additions: `services`, `service_checks`. Migration applied locally + production.
2. Repositories for services and service_checks.
3. Server Actions: `createService`, `listServices`, `getService`, `updateService`, `deleteService`, `pauseService`.
4. UI for adding/listing/editing services. The "Add service" dialog now functional.
5. **Check worker process** (`apps/server/src/workers/check-worker.ts`) — polls for due checks, runs HTTP requests, persists results.
   - Run as a separate process in `docker-compose.yml`: same image as server, different entrypoint.
   - Concurrency limit: don't run more than N checks in parallel.
   - Hard timeout per check via AbortController.
6. **WebSocket server** added to the Hono app (`apps/server/src/ws/`):
   - Connection management, topic subscriptions, fan-out helper.
   - Auth check on every subscription request.
   - Heartbeat protocol.
7. **Frontend WebSocket client** (`apps/web/lib/ws-client.ts`):
   - Singleton connection, reconnection with exponential backoff, resubscription on reconnect.
   - Connection state indicator component (corner dot).
8. **Live updates wired into UI:**
   - Dashboard subscribes to status changes for all visible services.
   - Service detail page subscribes to its specific service's updates.
9. Cleanup job: delete service_checks older than 30 days. Runs nightly via the existing worker process.

## Notes for when we get here

- The worker is just a loop. Don't reach for Inngest, BullMQ, or any queue library. Postgres is the queue.
- The fanout layer is in-memory and single-process. We're explicitly not scaling beyond one VPS. If we ever did, this is what would need to change first.
- The first status flip you observe in production (one of your real deployed services briefly returning a non-200) is the moment this project starts being useful. Celebrate it.

---

(More detail to be added before starting this phase.)
