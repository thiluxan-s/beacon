# Phase 6 — Security Review & Hardening (study walkthrough)

A ground-up account of how Beacon went from "it works and it's deployed" to "it's hardened, and every claim about that is **verified against the running system, not asserted from config**." Read §1 for the framing, §2 for the review that started it, §3 for the quick batch fixes, §4–§5 for the CSP (the centerpiece — a strict policy that shipped in report-only mode and caught a real defect before it could break sign-in), §6 for the header fix that exposed a whole deploy-pipeline gap, §7 for the ops verification on the box, and §8–§9 for the verification stories and the mental model.

Phase 6 also shipped the public read-only **demo mode** (6a, PR #15) and a **mobile + accessibility pass** (PR #20). This walkthrough is the *security thread* of Phase 6 — the longest and most instructive of the three — and it builds on the deploy frame from Phase 2 (`docs/PHASE_2_WALKTHROUGH.md`) and the integration/credentials frame from Phase 4 (`docs/PHASE_4_WALKTHROUGH.md`). The finding-by-finding register lives in `docs/SECURITY_REVIEW.md`; this is the narrative behind it.

The security thread shipped as seven merges:

- **#19** (`565e3a4`) — the review + the safe batch fixes (WS connection cap, constant-time internal-secret compare, `nosniff` into the Caddyfile)
- **#21** (`553e894`) — CSP in `Report-Only` mode
- **#22** (`b9d4b00`) — CSP flipped to enforcing, after prod validation
- **#23** (`3f280b8`) — CI syncs infra config to the VPS + a Caddy reload on deploy
- **#24** (`0675152`) — the reload was a no-op; recreate the proxy container instead
- **#25** (`eaac7fb`) / **#26** (`3ec5911`) — the review doc updated to "live in prod," then closed

---

## 1. The mental shift: "single-user" is not a threat model

Beacon has exactly one human user — me. The tempting conclusion is that security is mostly moot: there's no multi-tenant isolation to get wrong, no user-generated content, no privilege escalation between accounts. But that reasoning quietly swaps the real threat model for a convenient one. The dashboard is a **public HTTPS endpoint on a box I own**, reachable by the entire internet, holding **live third-party API credentials** (a Vercel token, a GitHub PAT) and terminating its own TLS. "Only I log in" says nothing about the attack surface an anonymous request already has.

So the phase answers a different question than the feature phases did. Not "how do I build X," but: **what does an unauthenticated request reach, what secrets exist and where do they touch, and — the part that turned out to matter most — is the hardening I *think* is in place actually in effect on the running system?** That last clause is the whole spine of this phase. Configuration is a claim; production behavior is the evidence. Almost every interesting moment below came from the gap between the two.

---

## 2. The review — a written audit, not a vibe

The work started with a whole-app audit against a written checklist, captured in `docs/SECURITY_REVIEW.md`: a static pass over the codebase, the infrastructure config, and the git history, plus the earlier live verification of the Phase 6a public-demo enforcement. The output was seven findings — **no Critical or High**, one Medium, the rest Low or Ops:

| # | Finding | Severity | Where it went |
|---|---------|----------|---------------|
| 1 | No connection cap on the anonymous WebSocket | Medium (availability) | Batch fix (#19) |
| 2 | No Content-Security-Policy header | Low | Its own PR (#21 → #22) |
| 3 | API host missing `X-Content-Type-Options: nosniff` | Low | Batch fix (#19) — but see §6 |
| 4 | Internal-secret compare not constant-time | Low | Batch fix (#19) |
| 5 | WS auth token passed as `?token=` query param | Low | **Accepted** |
| 6 | Firewall/SSH runtime state unverified | Ops | Verify on the box (§7) |
| 7 | Rotate two tokens leaked to dev logs | Ops | Revoke + recreate (§7) |

The triage is the interesting part. Three findings were **safe to batch** — small, self-contained, no risk of breaking the running app — and shipped together in #19. One (**the CSP**) was carved out into its own PR *specifically because it was the dangerous one*: a strict CSP interacts with Next.js's hydration scripts and Clerk's scripts and can **silently break the app**, so it could not ride along with the safe fixes. Two were **operational** — things that can only be confirmed on the VPS, not from the repo. And one (**#5**) was **accepted with a reason**, not fixed: browsers can't set custom headers on a `WebSocket`, so the auth token has to travel as a query param or subprotocol; the mitigation is that Caddy doesn't persist query strings to disk. Writing "accepted, here's why" is itself a security-review skill — not every finding is a bug to fix.

---

## 3. The batch — three safe fixes (#19)

These shipped together because none of them can break a working app:

- **#1 — a ceiling on anonymous WebSocket connections.** The public `?public=1` lane opens a receive-only socket with no auth, and each `subscribe` frame triggers a DB lookup. Nothing capped concurrent anonymous connections, so on a single 2 GB box an attacker could open many and exhaust memory or the DB pool. The fix is a **global ceiling enforced at the WS upgrade, before the handshake completes** — authenticated (owner) connections are unaffected. A heartbeat already reaped dead sockets; this bounds the live ones.
- **#4 — constant-time internal-secret compare.** The `/internal/*` guards compared the shared secret with `!==`, which short-circuits on the first differing byte and is therefore a (theoretical) timing oracle. Swapped for `crypto.timingSafeEqual` via a shared helper, applied to every guard. Practical risk was low — the endpoint isn't publicly reachable — but a timing-safe compare is cheap defense-in-depth, and "low risk" isn't "no fix."
- **#3 — `nosniff` on the API host.** Added `X-Content-Type-Options: nosniff` to the `api.beacon.thiluxan.com` header block in the Caddyfile. This is the one that *looked* trivial and turned out to be a whole story — see §6.

---

## 4. The CSP, done carefully — mechanism first (#21)

A Content-Security-Policy is the strongest remaining header, and the most dangerous to add. The design pinned three decisions:

**Where it lives — the app, not Caddy.** A genuinely strong CSP uses a **per-request nonce** with `strict-dynamic`, so only scripts the server explicitly blesses can run. Caddy can't inject a per-request value into the HTML, so a static Caddy CSP would be forced into `script-src 'unsafe-inline'` (which guts the protection) or brittle content hashes. The nonce has to be minted where the HTML is rendered — the Next.js middleware. And since the app already runs `clerkMiddleware`, Clerk's built-in `contentSecurityPolicy` option was the natural seam: it generates the nonce, injects it into Next's and its own scripts, merges Clerk's own required directives, and can emit either the enforcing or the `Report-Only` header from one boolean.

**What we contribute vs. what Clerk owns.** A small pure helper, `buildCspDirectives(apiUrl, wsUrl)`, returns only Beacon's non-Clerk needs — most importantly `connect-src` with the API and WebSocket origins **derived from the two `NEXT_PUBLIC_*` env URLs** so dev/localhost/prod all work with no hardcoded hosts. `script-src` is deliberately *not* hand-written: `strict: true` plus Clerk own it. The helper is extracted precisely so it's unit-testable in isolation (origins land in `connect-src`; malformed URLs are skipped, never thrown).

**Report-Only first — the whole point of the separate PR.** The review's instruction was explicit: ship `Content-Security-Policy-Report-Only` first, validate against the *running* app, then enforce. Report-Only cannot break anything — it only reports violations to the browser console. #21 shipped exactly that. The enforce flip was left for a follow-up, gated on observing the live app clean.

That caution was not ceremony. It immediately earned its keep.

---

## 5. The defect Report-Only caught — a debugging story (#22)

With Report-Only live, the browser console on the deployed app showed a real violation: **Clerk's own `clerk.browser.js` was being reported against `script-src`.** Clerk's script, violating Clerk's own generated policy. That's the kind of finding that only a runtime check surfaces — the config looked perfect.

The investigation followed the evidence rather than guessing:

1. **The tell.** In a single response, Next's own chunks carried the nonce (`nonce="R0bS…"` matching the header), but Clerk's `<script src=clerk.browser.js>` had **no `nonce` attribute at all**. Under `strict-dynamic`, host allowlists are *ignored* — an un-nonced external script is unauthorized no matter what's in `script-src`. So the report was correct, and under *enforcement* it would be a hard block.
2. **Refuting the comfortable theory.** The convenient explanation was "this is a Report-Only artifact; enforcing would behave differently." Tested it directly — flipped to enforce locally — and Clerk's script was *still* un-nonced. So enforcing this policy would have **blocked Clerk's script and broken sign-in for real users.** A genuine defect, not a mode artifact. (Testing the hypothesis instead of assuming it is the entire lesson of this step.)
3. **Rejecting the easy escape.** Clerk's non-strict mode (`strict: false`) *does* let its script load — but it emits `script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:`, i.e. scripts from *any* origin. That "works" while throwing away the reason to have a CSP at all. Rejected.
4. **The root cause.** Reading Clerk's compiled source: the nonce-aware `DynamicClerkScripts` component (which reads the `x-nonce` request header the middleware sets, and stamps it onto the script tag) is only rendered when `<ClerkProvider>` gets the **`dynamic`** prop. Our root layout used a plain `<ClerkProvider>`, so Clerk took a static script path that never reads the nonce. One missing prop.
5. **The fix, verified.** `<ClerkProvider dynamic>` in `app/layout.tsx` (with a comment pinning down *why* it must stay). Confirmed against the running app in both modes: header nonce and Clerk's script-tag nonce now match. The trade-off — `dynamic` reads request headers, so the previously-static `/` and `/_not-found` render dynamically — is a non-issue for a live, Clerk-gated dashboard.

Only *then* did #22 flip `reportOnly` off. And the enforce flip was itself validated against **production**, not just merged: the prod Clerk instance uses a different domain than dev (`clerk.beacon.thiluxan.com` vs `*.clerk.accounts.dev`), so the deployed check is the authoritative one — prod header nonce matching the prod script nonce, zero violations while signing in and adding a service.

The lesson, echoing Phase 4's verification discipline: **"the config is correct" and "the running app is correct" are different claims, and only the second one ships safely.** Report-Only exists precisely to make the difference observable before it can hurt anyone.

---

## 6. The `nosniff` that wouldn't apply — a header fix that exposed the deploy pipeline (#23 → #24)

Finding #3 was a one-liner: add `nosniff` to the API host. It merged in #19. Weeks later, a check found the header **still absent** in production. The one-line fix had quietly done nothing — and unwinding *why* uncovered a real gap in how the box gets updated.

**Layer one: config was never shipping.** `curl -sI https://api.beacon.thiluxan.com/health` showed only HSTS. The repo's Caddyfile clearly had the `nosniff` line. The deploy pipeline, it turned out, only ever ran `docker compose pull`/`up -d` for the app *images* — it **never synced `Caddyfile`, `docker-compose.yml`, or `deploy.sh` to `/opt/beacon`**. Those files had been hand-copied at setup and were only ever updated manually. So the merged Caddyfile change was stranded in git, never reaching the running Caddy. #23 fixed *that*: a CI step (`scp`) syncs the config files to the box before the SSH deploy (never `.env` — secrets stay VPS-only), and `deploy.sh` reloads Caddy afterward.

**Layer two: even the reload was a no-op.** After #23 deployed, `nosniff` was *still* absent — but the Actions run was green. The evidence pinned it precisely: on the box, the on-disk `/opt/beacon/Caddyfile` now had the `nosniff` line, but `caddy adapt` of the *running container's* config showed only HSTS on the API host. Same logical file, different content. The cause is a **single-file Docker bind mount** (`./Caddyfile:/etc/caddy/Caddyfile`): Docker binds a specific *inode* at container start, and `scp` replaces the file atomically (write-temp + rename → a **new inode**). The host now pointed at the new file; the running container still held the old one. So `caddy reload` dutifully re-read `/etc/caddy/Caddyfile` *inside the container* — the stale copy — and applied nothing. A green deploy that changed nothing.

**The fix.** A single-file bind mount can't be refreshed by reload; the container has to be **recreated** to re-resolve the mount. #24 changes `deploy.sh` to validate the new config in a *throwaway* container first (a fresh container mounts the current inode; the running one can't), then `docker compose up -d --force-recreate --no-deps caddy`. TLS certs survive — they live in the `caddy_data` volume, not the container. The next deploy self-healed, and `nosniff` finally went live, confirmed by curl.

Two findings collapsed into one root behavior here: a security header that "was fixed" but wasn't live, because **config-as-code isn't code-as-code until it actually ships and actually applies.** The header was the symptom; the pipeline was the bug.

---

## 7. The operational items — verified on the box (§6/§7 of the review)

Two findings could only be closed on the VPS, not from the repo.

**#6 — firewall & SSH.** The hardening was documented but unconfirmed at runtime. The SSH half was settled *without* root: the drop-in `sshd_config.d/00-beacon-hardening.conf` sets `PermitRootLogin no` + `PasswordAuthentication no`, but the stock `sshd_config` still carried an uncommented `PermitRootLogin yes`. Which wins comes down to two SSH rules — **first-match-wins**, and where the `Include …/sshd_config.d/*.conf` line sits. A no-sudo grep settled it: the `Include` is at line 12, the stray `yes` at line 42, so the drop-in's `no` is read first and wins. The firewall half needed root — and the honest snag was that the box's `sudo` password was unknown, so the path was DigitalOcean's web console (Reset Root Password → Launch Console, which bypasses SSH entirely, so `PermitRootLogin no` doesn't lock you out). `ufw status verbose` then confirmed the target state: **`active`, default-deny on incoming *and* routed, only 22/80/443 allowed in** (v4 + v6).

**#7 — rotate the leaked tokens.** During Phase 4's integration smoke tests, Next.js dev-mode Server-Action logging had echoed a real Vercel token and GitHub PAT into the dev log (never into git — see Phase 4 §8.2). Both were revoked and recreated at their providers and the integrations re-attached in-app; because credentials are stored AES-256-GCM-encrypted and entered through the deployed app, nothing had to be redeployed. The *leak vector itself* was already closed back in Phase 4 (`logging: { serverFunctions: false }` in `next.config.ts`), so re-entering the fresh tokens couldn't repeat the exposure. The distinction from Phase 4 still holds: encryption at rest protected the database; it did nothing for a secret in transit through a framework's debug log. A leaked secret doesn't un-leak when you delete the log — it un-leaks when you rotate it.

---

## 8. The verification stories — the bottom line

The through-line of the whole phase is that **nothing was called done on the strength of a merge.** Each fix was checked against the running system:

- **CSP** — Report-Only validated in the browser (which is what caught the Clerk defect); the fix confirmed by header-nonce-matches-script-nonce; the enforce flip validated against *production*, where the Clerk domain differs from dev. `curl` confirms the enforcing `content-security-policy` header with a live nonce, and the app signs in and streams over the WebSocket under it.
- **`nosniff`** — chased from "merged" through "config never synced" through "reload is a no-op on a stale inode" to an actual `x-content-type-options: nosniff` in a prod response.
- **Firewall/SSH** — read off the box itself (`ufw status verbose`, the sshd include-ordering), not inferred from the setup script.
- **Tokens** — revoked at the provider and the integrations re-attached, with the leak vector already structurally closed.

The one Medium and every Low is fixed or explicitly accepted; both Ops items are confirmed on the VPS. `docs/SECURITY_REVIEW.md` carries the closed register (#25/#26).

---

## 9. The mental model to carry forward

> **Security posture is a runtime property, not a config property.** A header in the Caddyfile, a directive in the middleware, a rule in the setup script — each is a *claim*. The claim is only true when the running system exhibits it, and the gap between the two is where the real defects live: a CSP that's perfect on paper but blocks your own auth script, a header that's committed but never shipped, a firewall rule that's documented but unverified. So the discipline is: **ship the dangerous change in a mode that reports instead of breaks, validate against the deployed app (not dev, not the merge), and treat "the config says so" as a hypothesis to test, never a conclusion.**

The meta-lesson rhymes with Phase 4's: the value wasn't only the fixes, it was the **refusal to let "merged" stand in for "in effect."** Report-Only turned a policy that would have broken sign-in into a caught bug. A single `curl` turned a "fixed" header into a two-layer deploy-pipeline repair. And a no-sudo grep plus a console session turned "documented hardening" into confirmed hardening. Owning the machine means owning the proof that it's configured the way you think it is.

---

### Related docs
- `docs/SECURITY_REVIEW.md` — the finding-by-finding register (the audit this narrative is the story of).
- `docs/INFRASTRUCTURE.md` — the deploy pipeline, the Caddyfile, and the config-sync + proxy-recreate mechanics from §6.
- `docs/PHASE_4_WALKTHROUGH.md` — credential encryption at rest and the original dev-log leak (§8.2), which §7 closes out.
- `docs/PHASE_2_WALKTHROUGH.md` — the deploy/infra frame the pipeline fixes in §6 extend.
- `docs/superpowers/specs/2026-07-11-csp-report-only-design.md` + `docs/superpowers/plans/2026-07-11-csp-report-only.md` — the CSP design spec and implementation plan, including the `<ClerkProvider dynamic>` discovery.
