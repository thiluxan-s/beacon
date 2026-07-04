# Phase 3b — Real-Time WebSockets (study walkthrough)

A ground-up explanation of the Phase 3b real-time layer: how a background check on the server ends up **pushing a live status change into a recruiter's browser with no refresh** — and an honest account of the bugs and environment hurdles we hit taking it from "merged" to "verified working in a browser." Read §1–§6 for how the system works, §7 for the debugging odyssey (the fixes), and §8 for the mental model.

This plugs into the exact frame from Phase 2 (`docs/PHASE_2_WALKTHROUGH.md`): the WebSocket is just another route Caddy proxies to `server:3001`, at `wss://api.beacon.thiluxan.com/ws`.

---

## 1. The mental shift: from "ask and wait" to "be told"

Everything you've built before Beacon was **request/response**: the browser asks, the server answers, the connection closes. To show fresh data you either refresh or poll on a timer. Polling is wasteful (most requests find nothing changed) and laggy (you only learn on the next tick).

Phase 3b inverts it. The browser opens **one long-lived connection** and then *waits to be told*. When a background worker notices a service's status changed, the news is **pushed** down that open connection and the UI updates itself. Nobody asked; the server volunteered.

The whole phase answers one question: **how does an event that happens deep inside the server (a health check flipping `up→down`) travel, in real time, to exactly the right open browser tabs — and only those allowed to see it?**

---

## 2. The cast of characters (the live path)

Six pieces form a chain. Keep them straight and the rest is easy:

| Piece | File | Job |
|---|---|---|
| **The worker** | `apps/server/src/workers/check-worker.ts` | Every 5s, checks each due service; writes the result |
| **The notify seam** | `apps/server/src/db/repositories/services.ts` (`applyCheckResult`) | On a *status change*, emits `pg_notify('beacon_events', …)` **inside the same DB transaction** |
| **The LISTEN relay** | `apps/server/src/ws/listener.ts` | One dedicated Postgres connection running `LISTEN beacon_events`; forwards each notification into the in-process hub |
| **The connection hub** | `apps/server/src/ws/connections.ts` | Tracks every open socket, its user, and its topic subscriptions; fans out events |
| **The WS server** | `apps/server/src/ws/server.ts` + `auth.ts` | Accepts `/ws` upgrades, authenticates with Clerk, routes subscribe messages |
| **The browser client** | `apps/web/lib/ws-client.ts`, `use-ws.tsx`, `services-live-list.tsx` | One reconnecting socket; patches the DOM when events arrive |

Postgres is the quiet hero: it's both the **database** and the **message bus**. We didn't add Redis — `LISTEN/NOTIFY` gives us pub/sub for free (per CLAUDE.md, "don't reach for Redis until we have a measured reason").

---

## 3. The pipeline, traced end to end (the payoff)

A service you're monitoring goes down. Here's every hop from the failing HTTP check to the pulsing red dot in your browser:

```
[worker] fetch(service.url) fails or times out
   │
   ▼
applyCheckResult(...)  ── in ONE transaction:
   1. write the service_check row + new currentStatus
   2. if status changed:  pg_notify('beacon_events', {serviceId, userId, status, …})
   │   (NOTIFY is delivered by Postgres at COMMIT — so the row is already durable
   │    when anyone hears about it. This atomicity is load-bearing; see §7.)
   ▼
[Postgres]  delivers the notification on channel beacon_events
   │
   ▼
[listener.ts]  the dedicated LISTEN client receives it, Zod-validates the payload,
               hands it to the hub
   │
   ▼
[connections.ts] hub.broadcast(event):
   for each open socket:
       if socket.userId !== event.userId       → skip   (tenant isolation, FIRST)
       if subscribed to 'global' or 'service:<id>' → socket.send(event)
   │
   ▼
[browser]  BeaconSocket receives the message, dispatches to handlers
   │
   ▼
[services-live-list.tsx]  setServices(prev => patch the matching row's currentStatus)
   → React re-renders that row: dot turns red, label flips to "down"
```

Worker polls every 5s (`POLL_INTERVAL_MS = 5_000`), so a change surfaces within a few seconds — no refresh, no polling from the browser.

---

## 4. Auth & tenant isolation — the socket is a door, so it's guarded

A WebSocket is a long-lived authenticated channel, and Beacon is (for now) single-user but built multi-tenant. Three layers of defense, so a socket can never see another user's data:

1. **Connect-time auth (fails closed).** The upgrade to `/ws` carries a Clerk token; `auth.ts` verifies it with `@clerk/backend`'s `verifyToken` **before the handshake completes**. Any failure → no socket. The connection is bound to a `userId`.
2. **Subscribe-time ACL.** A client can ask to subscribe to `global` or `service:<id>`. For a specific service, the hub checks ownership (`getService(userId, id) !== null`) — you can't subscribe to a service that isn't yours.
3. **Broadcast-time gate (userId first).** In `hub.broadcast`, the `conn.userId !== event.userId` check runs **before** the topic check — so even a bug in subscription bookkeeping can't leak an event across tenants.

"Don't trust client message origin — every subscription goes through an auth check" (CLAUDE.md WebSocket conventions), implemented as belt *and* suspenders.

---

## 5. The client half — one socket, many subscribers

The browser side is deliberately boring, which is the point:

- **`ws-client.ts` — `BeaconSocket`**: a single reconnecting WebSocket with exponential backoff (`nextBackoffMs = min(1000·2^n, 30_000)`). On (re)connect it fetches a fresh Clerk token and **re-subscribes** to its topics, so a dropped connection self-heals.
- **`use-ws.tsx` — `WsProvider`**: mounts exactly **one** `BeaconSocket` for the whole authenticated app (in `(app)/layout.tsx`), and exposes hooks: `useWsConnectionState()` and `useServiceStatusSubscription(topic, handler)`. Multiple components share the one socket by multiplexing topics over it.
- **`connection-indicator.tsx`**: the small dot by your avatar — `connected` / `reconnecting` / `disconnected`. It's the honest, visible proof the live channel is alive.
- **`services-live-list.tsx`** (dashboard) subscribes to `global`; **`service-status-live.tsx`** (detail page) subscribes to `service:<id>`. Each patches only what it owns.

---

## 6. Where it lives in production

Nothing new in the deploy frame from Phase 2 — that was the design goal:

- The worker is a process inside the `server` image (`worker:dev` locally; a worker process in prod).
- The WebSocket is one more route Caddy reverse-proxies: `wss://api.beacon.thiluxan.com/ws` → `server:3001/ws`. Caddy upgrades the connection transparently.
- `NEXT_PUBLIC_WS_URL` is baked into the web image at **build time** (same `NEXT_PUBLIC_*` rule as Phase 2's Clerk key — see §7, it bit us again).

---

## 7. The verification odyssey — challenges & fixes

The branch merged green (server 49/49, web + shared passing). But "tests pass" ≠ "works in a browser." The first real smoke test — sign in, add a service, watch it flip — turned into a multi-hour debugging session. Here's every wall we hit and how we got over it. **Two were genuine code bugs; the rest were environment/tooling.**

### 7.1 `TypeError: adapterFn is not a function` on every page — CODE FIX
Signing in (and even plain `GET /`) 500'd. The error was a Next.js **internal** identifier, traced to `node_modules/next/dist/server/next-server.js:1186`:

```js
const adapterFn = middlewareModule.default || middlewareModule;
result = await adapterFn({ handler: …, request, page });   // ← threw
```

**Root cause.** Next 16 renamed the `middleware.ts` convention to **`proxy.ts`**, and — per Next's own docs — *"Proxy defaults to the Node.js runtime."* Our file was named `apps/web/proxy.ts`, which routed Clerk's middleware onto Next's **Node-runtime** loader. Under that loader with Turbopack, Clerk's `clerkMiddleware` default export wasn't wrapped into the adapter shape `next-server.js` expects, so `adapterFn` wasn't callable — on *every* request, because proxy/middleware runs on every route.

**The tell it wasn't ours:** the entire `GET /` render path (`layout.tsx`, `page.tsx`, `proxy.ts`, `next` + `@clerk/nextjs` versions) was **byte-identical to `main`**. This bug reproduced on `main` too — Phase 3b was simply the first time we loaded `/` in a browser.

**Fix (`f029b96`).** `git mv apps/web/proxy.ts apps/web/middleware.ts` — contents unchanged. The `middleware.ts` filename runs Clerk on the **Edge runtime**, the long-proven path, sidestepping the broken Node-Proxy loader entirely. Verified `GET / → 200`.

> ⚠️ **Trap for later:** Next nudges you with a "use proxy instead" deprecation warning, and ships a `middleware-to-proxy` codemod. **Do not run it** until Clerk + Turbopack support the Node-runtime Proxy path — it would reintroduce this exact crash.

### 7.2 New services didn't appear without a refresh — CODE FIX
After adding a service, the endpoint **count** bumped but the **row** didn't show until a manual refresh.

**Root cause.** `ServicesLiveList` seeded its state with `useState(initial)`, which only reads on mount. Adding a service triggers a server-action revalidation that re-renders the page and passes a *new* `initial` — but the client dropped it. The count updated because it's rendered by the **server** component (`page.tsx`); the list is a **client** component holding stale state.

**Fix (`12f1854`).** Adopt `initial` on change with React's adjust-state-during-render pattern:
```tsx
const [prevInitial, setPrevInitial] = useState(initial);
if (initial !== prevInitial) { setPrevInitial(initial); setServices(initial); }
```
Safe against clobbering live updates **because §3's `pg_notify` is transaction-atomic** — a fresh server read is never behind a WS event, so re-adopting server data can't regress a status. New rows now appear instantly (`pending`), then flip live.

### 7.3 The machine kept freezing — ENVIRONMENT
`next dev` (Turbopack) repeatedly froze the *entire* machine mid-compile, taking the Claude Code CLI down with it.

**Root cause.** Host RAM exhaustion on a 16 GB laptop: Chrome (~3.2 GB across 29 processes) + the WSL VM (Vmmem) + VS Code's in-WSL language servers (~1.6 GB) left too little free physical RAM. When Turbopack's compile tried to balloon Vmmem, Windows couldn't back it → swap thrash → the whole WSL distro (dev server **and** the CLI, which share the distro) froze at ~85% memory.

**Fixes/mitigations.** Free host RAM before compiling (close Chrome, close VS Code — its servers live *inside* WSL); run **web-only** (`npm run dev:web`) not the full 3-process stack; **verify via `curl`, not a browser** (a `200` proves the fix without a browser's memory cost); keep long-lived processes in the user's own terminal so a freeze can't kill the CLI's session.

### 7.4 Turbopack panic: `inner_of_uppers_lost_follower` — TOOLING
Once memory was under control, the compile panicked inside Turbopack's Rust engine (`turbo-tasks-backend/.../aggregation_update.rs:1677`).

**Root cause.** A **corrupted `.next` persistent cache** — Turbopack writes its task graph to disk (`✓ Finished writing to filesystem cache`), and the earlier freezes had killed a compile *mid-write*, leaving an inconsistent graph that the next start read and choked on.

**Fix.** `rm -rf apps/web/.next` + clean rebuild. The fresh compile finished `/` in ~5 s.

### 7.5 Browser `ZodError: NEXT_PUBLIC_WS_URL — Required` — ENVIRONMENT
After sign-in the dashboard shell rendered, then the client threw a Zod error from `apps/web/lib/env.client.ts`.

**Root cause.** `apps/web/.env.local` (gitignored) was missing `NEXT_PUBLIC_WS_URL`. `NEXT_PUBLIC_*` values are **inlined at compile time**, so an undefined value becomes `undefined` in the browser bundle, and the env schema's `.parse()` throws. `.env.example` documents it; the local file had lost it across an environment reset.

**Fix.** Add `NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws` to `.env.local` and **restart** `next dev` (a browser reload won't re-inline). Recorded as a memory so future sessions don't rediscover it. *(This is Phase 2's §3 build-time-vs-run-time gotcha, striking again — the #1 recurring trap of the whole stack.)*

### 7.6 Every service showed `down` — NOT A BUG
With the pipeline finally live, services appeared and flipped `pending → down` — correctly, in real time — but *all* of them, even `example.com`.

**Root cause.** WSL's DNS was broken: `dns.lookup('example.com') → ENOTFOUND` (resolver `172.27.208.1`), almost certainly Cloudflare WARP / NordVPN intercepting DNS. The browser had internet; **Node in WSL did not**. The worker was behaving *correctly* — a host it can't even resolve *is* down from a monitor's perspective.

**How to demo `up` anyway (no internet):** add `http://127.0.0.1:3001` with health path `/health` — an IP literal, no DNS — and watch it flip `pending → up`. **Real fix:** disconnect the VPN + `wsl --shutdown` to restore DNS. On the production VPS this is a non-issue.

### The bottom line
Despite all of the above, **the thing we built works.** The smoke test confirmed the real-time pipeline end-to-end: services appear on add and flip status **live, with no refresh**, exactly as §3 describes. The two code fixes (§7.1, §7.2) are committed and in PR #7; the rest were environment/tooling lessons now captured here and in project memory.

---

## 8. The mental model to carry forward

> **A background worker writes a status change and, in the same transaction, fires a Postgres `NOTIFY`. One dedicated `LISTEN` connection relays it into an in-process hub, which fans it out over authenticated, tenant-scoped WebSockets to exactly the browser tabs allowed to see it, where a single shared client patches the DOM. Postgres is both the database and the message bus; no Redis, no polling.**

And the meta-lesson from §7, worth as much as the architecture: **"tests pass" and "works in a browser" are different claims.** The gap between them was two real bugs and a stack of environment traps — and the discipline that closed it was refusing to guess (tracing `adapterFn` to a specific Next.js line before touching anything), separating *our* bugs from the *environment's* (proving the `down` was DNS, not the worker), and verifying each fix against reality (`curl → 200`, a row flipping live) before calling it done.

---

### Related docs
- `docs/PHASE_2_WALKTHROUGH.md` — the deploy/infra frame this plugs into.
- `docs/ARCHITECTURE.md` — full system design, including the integration layer.
- `docs/phases/phase-3-health-checks-and-realtime.md` — the phase spec.
- `.superpowers/sdd/progress.md` — the task-by-task build ledger + post-review fixes.
