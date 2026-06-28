# Phase 2 — How It All Plugs Together (study walkthrough)

A ground-up explanation of the Phase 2 production-deploy architecture: how the repo, CI, image registry, VPS, networking, SSH, and environment variables wire together into a live site at `https://beacon.thiluxan.com`. Written as a study aid — read it top to bottom, then use the request trace in §9 to test your understanding.

---

## 1. The mental shift: from "Vercel does it" to "I own the machine"

On Wayfare and Investor Thesis, you pushed to GitHub and Vercel magically turned your code into a running website. You never thought about *where* it ran, *how* it got there, or *what served HTTPS*. Phase 2 is **rebuilding that magic yourself**, out of explicit parts, on a server you rent.

So the whole phase answers four questions Vercel used to answer for you:

1. **How does my code become a runnable artifact?** → Docker images
2. **Where does it run, and how do the parts talk?** → a VPS running Docker Compose
3. **How does the internet reach it securely?** → DNS + Caddy (TLS) + a reverse proxy
4. **How does new code get from `git push` to live?** → GitHub Actions + SSH + a deploy script

Everything below is one of those four.

---

## 2. The cast of characters (the "places" things live)

There are **four locations**, and a lot of confusion dissolves once you keep them straight:

| Place | What it is | What lives there |
|---|---|---|
| **The repo** (GitHub) | Source of truth | App code + the *recipes*: Dockerfiles, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, the CI workflow |
| **GitHub Actions** | A temporary build robot | Runs on every push; builds images, ships them |
| **ghcr.io** | An image warehouse | The built images, tagged by commit SHA |
| **The droplet** (`165.22.238.85`) | The always-on machine | The 4 running containers + `/opt/beacon/.env` (the real secrets) |

The repo holds *recipes*; the droplet holds *running things*; Actions and ghcr are the *conveyor belt* between them.

---

## 3. Containers & images — your app as a shippable box

A **Docker image** is a frozen, self-contained filesystem: your code + Node + every dependency, packaged so it runs identically anywhere. A **container** is a running instance of an image. The image is the *recipe baked into a tin*; the container is the *meal*.

Beacon has **two images**, because it's two processes:

- `ghcr.io/thiluxan-s/beacon-web` — the Next.js frontend, runs `node apps/web/server.js` on port **3000**
- `ghcr.io/thiluxan-s/beacon-server` — the Hono API, runs via `tsx` on port **3001**

The **Dockerfiles** (`apps/web/Dockerfile`, `apps/server/Dockerfile`) are the recipes for building those images. They're *multi-stage*: one stage installs dependencies and builds, a final slim stage copies just what's needed to run — so the shipped image is small and doesn't contain build tools.

**The single most important concept here** (it bit us live, so it'll stick): there are **two moments** in an image's life, and env vars behave differently in each —

- **Build time** — when Actions runs `docker build`. This is when Next.js "bakes in" any `NEXT_PUBLIC_*` variable *as a literal string into the JavaScript*. After this, that value is frozen into the code.
- **Run time** — when the container starts on the droplet and reads its environment.

That's why a missing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` at *build* time gave us "Missing publishableKey" 500s even though it was correctly in `/opt/beacon/.env` at *run* time — Next had already baked in an empty string. This is the #1 gotcha of the whole stack.

---

## 4. The droplet at rest — what's actually running

SSH into the box and the running system is **four containers**, orchestrated by **Docker Compose** (`/opt/beacon/docker-compose.yml`):

```
            ┌──────────── DigitalOcean droplet ────────────┐
 internet → │  caddy  ──→  web (Next.js :3000)             │
   :443     │    │    ──→  server (Hono :3001) ──→ postgres │
            │    └─ TLS                              :5432  │
            └───────────────────────────────────────────────┘
```

Three things make this work:

**(a) The internal Docker network.** Compose puts all four containers on a private virtual network where **each service is reachable by its name**. So `server` reaches the database at hostname `postgres`, and `web` reaches the API at hostname `server`. These names only exist *inside* the droplet — that's the point. This is why `DATABASE_URL` is `postgresql://beacon:…@postgres:5432/beacon` — `postgres` is a *service name*, not a public address.

**(b) `expose` vs `ports`.** The web and server containers `expose` their ports (3000/3001) — "visible to other containers, but **not** to the public internet." Only Caddy *publishes* ports (`80:80`, `443:443`) to the outside world. **Postgres has neither** — reachable only at `postgres:5432` inside the network, never from the internet. The database has no public door at all.

**(c) Postgres persistence.** The database's data lives in a Docker **volume** (`beacon_postgres_data`), which survives container restarts and redeploys. Containers are disposable; the volume is the durable part.

---

## 5. Networking — how a request gets in, and the two "doors"

The path from a recruiter's browser to your code:

1. **DNS** (at Namecheap): the names `beacon.thiluxan.com` and `api.beacon.thiluxan.com` are **A records**, both pointing at `165.22.238.85`. DNS is just the phonebook: name → IP. (This is where a `168` vs `165` typo bit us — one wrong digit and the name pointed at a stranger's server.)

2. The browser connects to `165.22.238.85:443`. **Caddy** answers — the only thing listening publicly. Caddy does three jobs:
   - **TLS termination**: it automatically obtained Let's Encrypt certificates and serves HTTPS. (What Vercel did invisibly; Caddy does it with zero config beyond listing your domains in the `Caddyfile`.)
   - **Reverse proxy + routing by hostname**: both subdomains resolve to the same IP and the same Caddy, so Caddy decides where to send each request **by which hostname was requested**:
     - `beacon.thiluxan.com` → forward to `web:3000`
     - `api.beacon.thiluxan.com` → forward to `server:3001`
   - **A security rule**: on the API host it returns 404 for `/internal/*`, so internal-only endpoints can never be hit from outside.

3. **Two ways the frontend talks to the backend** — the subtle bit:
   - When *your browser* needs data, it could go out through the public `api.beacon.thiluxan.com` door.
   - But when the **web container itself** (doing server-side rendering) needs the API, it shouldn't go out to the internet and back — it talks *directly across the internal network*. That's what `INTERNAL_API_URL=http://server:3001` is: "for server-to-server calls, use the internal hostname, skip Caddy entirely." The `serverApiBaseUrl()` helper picks this internal URL when it's set. The live `/health` page rendering "All systems operational" was the proof this internal hop works.

So: **public traffic** goes browser → Caddy → container. **Internal traffic** goes container → container by service name. Same code, two paths, chosen by an env var.

---

## 6. SSH — what it's for and why all the key drama

SSH (Secure Shell) is how you get a remote terminal on the droplet, and how CI deploys. It matters in three ways:

**(a) Two kinds of keys, and the public/private split.** SSH uses *keypairs*: a **private** key (kept secret) and a **public** key (handed out). You put the *public* key in the server's `authorized_keys`; anyone holding the matching *private* key can log in. No passwords. We use two keypairs:

- `~/.ssh/id_ed25519` — *your personal* key (for you to log in)
- `~/.ssh/beacon_deploy` — the *CI deploy* key (so GitHub Actions can log in unattended)

Both public halves are in `thiluxan`'s `authorized_keys` on the droplet. GitHub holds the *private* half of `beacon_deploy` as the secret `SSH_PRIVATE_KEY`. (The early "Permission denied" was just your laptop offering a key the droplet didn't recognize.)

**(b) Host keys & fingerprints — the *reverse* direction.** Your keys prove *you* to the *server*. A **host key** proves the *server* to *you* — it stops you being tricked into logging into an impostor. The first time you connected, SSH showed `SHA256:d1Tf…` and asked "trust this?" For CI there's no human to click "yes," so we *pin* the expected fingerprint in the secret `SSH_HOST_FINGERPRINT`. The wrinkle: a server has *several* host keys (RSA, ECDSA, ed25519), and the Go SSH library CI uses prefers the **ECDSA** one — so we pin the ECDSA fingerprint, not the ed25519 one.

**(c) Hardening.** `bootstrap-vps.sh` disabled root login and password auth (key-only), so the only way in is holding one of those private keys. That's why, after bootstrap, even *you* log in as `thiluxan`, never `root`.

---

## 7. Environment variables — the three buckets

Env vars are the glue, and they live in **three different places for three different reasons**:

| Bucket | Where it lives | When it's used | Examples |
|---|---|---|---|
| **CI secrets** | GitHub repo secrets | During the Actions run | `SSH_HOST`, `SSH_PRIVATE_KEY`, `SSH_HOST_FINGERPRINT`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| **Build-time** | passed as `--build-arg` from a CI secret | When `docker build` bakes the web image | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| **Run-time** | `/opt/beacon/.env` on the droplet | When containers start | `DATABASE_URL`, `INTERNAL_API_SECRET`, `CLERK_SECRET_KEY`, `INTERNAL_API_URL`, `POSTGRES_PASSWORD`, … |

Connections worth seeing explicitly:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` appears in **two** buckets — it's a CI secret *and* gets baked in at build time. That dual nature is exactly the trap from §3.
- `INTERNAL_API_SECRET` is a **shared secret** between the two apps: the web app's Clerk webhook sends it as a header, and the server checks it before accepting an internal user-upsert. If they don't match, 401. It's how the server knows a call really came from *your* web app, not a random internet request.
- `POSTGRES_PASSWORD` appears *both* as its own var (so the postgres container sets that password) *and* embedded inside `DATABASE_URL` (so the server connects with it) — they must match, which is why we generated it once and reused it.
- The `.env` file is **never in the repo** — only `.env.production.example` (placeholders) is committed. The real file lives only on the droplet at `chmod 600`. Compose reads it via `env_file` and injects those vars into the containers at startup.

---

## 8. The deploy pipeline — `git push` to live, step by step

The conveyor belt that ties repo → droplet (`.github/workflows/deploy.yml`):

```
git push to main
   │
   ▼
GitHub Actions ── checks job: postgres + migrate + typecheck + lint + test
   │                (gate — if this fails, nothing deploys)
   ▼
   deploy job:
     1. docker build web image  (bakes in NEXT_PUBLIC_* from secrets)
     2. docker build server image
     3. push both to ghcr.io, tagged with the commit SHA
     4. SSH into the droplet (using SSH_PRIVATE_KEY, host pinned by fingerprint)
     5. run /opt/beacon/deploy/deploy.sh <that SHA>
```

`deploy.sh`, on the droplet, is the careful part:

1. Sources `/opt/beacon/.env` and sets `BEACON_VERSION=<sha>` (the tag Compose uses to pick *which* images to pull).
2. `docker compose pull` — fetches the freshly built images from ghcr.
3. **Runs migrations** — and *aborts before touching traffic* if they fail.
4. `docker compose up -d` — swaps the containers to the new images.
5. **Health-checks** both `beacon.` and `api.beacon.` — and if they fail, **rolls back** to the previous SHA (recorded in `.deployed_version`).
6. Only on success does it write the new SHA to `.deployed_version` — so the "known good" pointer never advances to a broken deploy.

`BEACON_VERSION` is the quiet linchpin: it's how a single static `docker-compose.yml` can run *any* version — the SHA is substituted into the image tag at deploy time.

---

## 9. One request, traced end to end (the payoff)

A recruiter visits **https://beacon.thiluxan.com** and signs in:

1. **DNS** resolves `beacon.thiluxan.com` → `165.22.238.85` (Namecheap).
2. Browser → `165.22.238.85:443`. **Caddy** terminates TLS, sees the hostname is the web host, forwards to **`web:3000`** over the internal network.
3. The **web container** renders the page server-side. It needs API data, so it calls **`http://server:3001`** (via `INTERNAL_API_URL`) — straight across the internal network, never out to the internet.
4. The **server container** handles it, queries **`postgres:5432`** (using `DATABASE_URL`), gets data, responds.
5. Caddy streams the rendered page back over HTTPS.
6. The recruiter signs in via **Clerk**. Clerk fires a **webhook** to `https://beacon.thiluxan.com/api/clerk/webhook` → Caddy → web container → which calls the server's internal upsert endpoint (authenticated with `INTERNAL_API_SECRET`) → server writes a row to `postgres`. That's the user row that appears.

Every arrow in that trace is something Phase 2 built: DNS, TLS, the reverse proxy, the internal network, the shared secret, the database.

---

## 10. The mental model to carry into Phase 3

If you keep one picture, keep this:

> **The repo holds recipes; Actions bakes them into SHA-tagged images in ghcr; `deploy.sh` pulls those onto the droplet where Compose runs four containers behind Caddy; env vars in three buckets wire it together; SSH is the trusted tunnel CI uses to trigger it all.**

Phase 3 (background workers + WebSockets) plugs into *exactly this frame*: a worker is just another long-running process in the `server` image (or a new Compose service), and the WebSocket connection is another route Caddy proxies to `server:3001` — `wss://api.beacon.thiluxan.com/ws`. You won't be re-learning the plumbing; you'll be adding pipes to a system you already understand.

---

### Related docs
- `docs/INFRASTRUCTURE.md` — the operational runbook and provisioning steps.
- `docs/ARCHITECTURE.md` — the full target system design (including the integration layer).
- `README.md` — the architecture diagram and current status.
