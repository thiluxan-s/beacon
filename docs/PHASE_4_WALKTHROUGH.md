# Phase 4 — The Integration Layer (study walkthrough)

A ground-up explanation of Beacon's integration layer: how "monitor anything with an HTTP endpoint" grows into "**and show deep, platform-specific insight wherever I've configured an integration**" — without the core codebase ever learning what "Vercel" or "GitHub" is. Read §1–§6 for how the system works, §7 for the schema-driven form (the architectural payoff), §8 for the verification stories, and §9 for the mental model.

This builds directly on the real-time frame from Phase 3b (`docs/PHASE_3B_WALKTHROUGH.md`) and the deploy frame from Phase 2 (`docs/PHASE_2_WALKTHROUGH.md`). Nothing here changes the deploy story — that's the point.

Phase 4 shipped in three merges plus two cleanups:
- **4a** — the engine + Vercel (PR #8, `7e8c77a`)
- **4 GitHub** — the second integration (PR #9, `8079cb5`)
- **4b** — the schema-driven attach form (PR #10, `b9f69b2`)
- **cleanups** — shared `relativeTime`/`STATUS_STYLE`, a rename, and silencing the dev-log credential echo (`8f6ad91`, `e8cea07`)

---

## 1. The mental shift: from "one kind of check" to "a plug-in system"

Phase 3 gave every service the same treatment: an HTTP health check, up/down/degraded. That's the floor, and it applies to *anything* with a URL.

Phase 4 adds a **ceiling that varies by platform**. A service that happens to be a Vercel deployment can also show its latest deployments and production build status. A service backed by a GitHub repo can show its CI health and recent commits. The catch: these are wildly different data shapes from wildly different APIs — and the whole design bet is that **adding the next one is "drop a file + register it,"** never a surgery on core code.

The phase answers one question: **how do you make a system deeply extensible by platform, while keeping the core (routes, worker, database, UI shell) completely ignorant of any specific platform?**

The answer is one interface, one registry, and one rule: *if a new integration forces you to change code outside `integrations/`, the abstraction is wrong.*

---

## 2. The cast of characters

Seven pieces, mirroring the shape of the real-time layer from 3b but for a different job:

| Piece | File | Job |
|---|---|---|
| **The contract** | `apps/server/src/integrations/types.ts` | The `IntegrationDefinition` interface every integration implements |
| **The registry** | `apps/server/src/integrations/registry.ts` | A `Map<id, IntegrationDefinition>` — the *one* place integrations are listed |
| **An integration** | `apps/server/src/integrations/vercel.ts`, `github.ts` | One file per platform: schemas, `testCredentials`, `fetchData` |
| **Credential crypto** | `apps/server/src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for secrets at rest |
| **The table** | `service_integrations` (`db/schema.ts` + repo) | Encrypted creds + config + the last fetched snapshot, one row per service+integration |
| **The fetch worker** | `apps/server/src/workers/integration-worker.ts` | A second loop: every minute, refresh any integration older than 5 min |
| **The UI** | catalog endpoint + attach dialog + per-integration cards | Attach an integration, render its snapshot |

The design rhyme with 3b is deliberate: 3b had a worker → notify → hub → socket chain; 4 has a worker → fetch → snapshot → card chain. Same instinct (background work feeding the UI), different mechanism.

---

## 3. The contract — the whole abstraction in one interface

Everything hinges on this (`types.ts`):

```ts
export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;   // secrets (a token)
  readonly configSchema: z.ZodType<Config>;       // non-secret pointers (projectId, owner/repo)
  readonly fields: readonly IntegrationFieldDef[]; // how to render the attach form (added in 4b)
  testCredentials(credentials, config): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials, config): Promise<IntegrationDataSnapshot>;
}
```

An integration is a plain **object literal** implementing this — not a class. Two Zod schemas (source of truth for validation), two async methods, and a bit of metadata. `testCredentials` proves the credentials work at attach time; `fetchData` returns a loose `Record<string, unknown>` snapshot the UI renders however it likes.

The registry is anticlimactic on purpose (`registry.ts`):

```ts
export const IntegrationRegistry: Map<string, IntegrationDefinition> = new Map([
  [vercelIntegration.id, vercelIntegration as IntegrationDefinition],
  [githubIntegration.id, githubIntegration as IntegrationDefinition],
]);
```

Adding GitHub in Phase 4-part-2 was, on the server, exactly this: a new `github.ts` file and **one line** here. The attach route, the worker, and the database never changed. That's the abstraction paying out.

---

## 4. Credentials — encrypted at rest, never returned, never logged

Integrations hold secrets (a Vercel token, a GitHub PAT). Three rules, each enforced in code:

1. **Encrypted at rest.** `crypto.ts` uses AES-256-GCM with a server-side master key (`INTEGRATIONS_ENCRYPTION_KEY`, base64 32 bytes, validated at startup). The stored blob is `base64(version(1) | iv(12) | authTag(16) | ciphertext)` — a **1-byte version prefix** so the scheme can evolve later, and the GCM auth tag means a tampered blob throws instead of silently decrypting to garbage.
2. **Never returned to the client.** Every DTO the API emits (`toIntegrationDto`, `toCatalogDto`) carries only metadata — `config`, `snapshot`, `lastError`, `enabled` — never the encrypted blob and never the plaintext. A route test literally asserts the token string never appears in the response body.
3. **Never logged.** No `console.log` of credentials anywhere; error messages carry HTTP status codes, not tokens. (Next.js dev-mode had its *own* opinion about this — see §8.)

The payoff you can verify by hand: after attaching, `SELECT credentials_encrypted FROM service_integrations` shows a 100-ish-char base64 blob, and a grep for `ghp_`/`vcp_` in it comes back empty.

---

## 5. The fetch worker — a second loop, contained failures

Phase 3b's process already runs a check-worker loop. Phase 4 adds a **second, independent loop** in the same worker process (`workers/index.ts` starts both; a crash in one can't take down the other):

```
[integration-worker]  every POLL_INTERVAL_MS (60s):
   findDueIntegrations(olderThanMs = 5min, limit = 20)   // enabled + never-fetched OR stale
   for each due row:
     ├─ def = registry.get(row.integrationId)             // unknown id → record error, continue
     ├─ creds  = decrypt(row.credentialsEncrypted)  → schema.parse
     ├─ config = schema.parse(row.config)
     ├─ snapshot = await def.fetchData(creds, config)      // the platform API call
     └─ recordFetchSuccess(row.id, snapshot)   // or recordFetchError on throw
```

The load-bearing discipline (CLAUDE.md: *"workers never crash the process on a single check failure"*): the whole per-row body is wrapped so **one integration's failure — a bad token, a 500 from Vercel, a network blip — records `last_error` and moves on.** The batch continues; the process stays up. A repo with no CI, an expired token, an API outage: all degrade to an error line on the card, never a crash.

Cadence: each integration is refreshed *at most* every 5 minutes, and the loop wakes every minute to find due work — so a freshly-attached integration (never fetched) is due immediately and populates within ~a minute.

---

## 6. Two integrations, two very different snapshots

The same interface produces completely different data — which is the whole point.

**Vercel** (`vercel.ts`): `testCredentials` hits `GET /v2/projects` (token valid?); `fetchData` hits `/v6/deployments` and maps to `{ deployments: [{ state, target, url, createdAt, commitSha, commitMessage }], productionStatus, fetchedAt }`. The card shows a production-status badge and a list of recent deployments.

**GitHub** (`github.ts`): `testCredentials` hits `GET /repos/{owner}/{repo}` — and note it validates **both** token *and* repo access at attach time (a typo'd repo is rejected up front, not discovered later). `fetchData` makes two calls — `/actions/runs` and `/commits` — and derives a `ciStatus` (`passing`/`failing`/`running`/`null`) from the latest workflow run, mapping to `{ ciStatus, workflowRuns, commits, fetchedAt }`. The card shows a CI badge, the latest run, and recent commits. A repo with no Actions cleanly shows commits and no badge.

> **The one deliberate core edit in the whole phase.** GitHub wanted to check repo access at attach time, but the original `testCredentials(credentials)` couldn't see the config. So the contract was widened to `testCredentials(credentials, config)` — a *generic* improvement (every integration now validates resource access at attach), not a GitHub special-case. `vercel.ts` didn't even need editing: an object method declared with fewer parameters is still assignable to the wider interface. That's the litmus test working — the only core change made the abstraction *better*, not platform-specific.

---

## 7. The schema-driven form (4b) — the architectural payoff, finished

Through 4a and the GitHub work, one embarrassing seam remained: the **web** app still hardcoded each integration. The attach dialog had a `KINDS` map naming Vercel and GitHub, with per-integration field lists and a `attachVercelAction` / `attachGithubAction` per platform. Adding an integration was "drop a file" on the server but "edit the dialog + add an action" on the client. Half-abstract.

4b closed it. The field metadata moved from the client onto the server contract (the `fields` descriptor in §3), and the client learned to render whatever the server describes:

```
[detail page, Server Component]
   fetchAvailableIntegrations()  ──►  GET /internal/integrations
                                        returns [{ id, name, fields }]   (id/name/fields ONLY —
                                        never schemas, never secrets)
   │  passes the catalog as a prop
   ▼
[attach dialog, Client Component]
   "Attach ▾" dropdown  = available.map(i => i.name)
   pick one → render i.fields as inputs (label, password-vs-text, optional)
   submit → partition values by field.section into { credentials, config }
          → attachIntegrationAction(serviceId, id, { credentials, config })   // ONE generic action
```

The proof it worked is a grep: after 4b, the attach dialog and `actions.ts` contain **zero** occurrences of `'vercel'` or `'github'`. The client names no integration. Adding a third one is now genuinely *server file + registry line + a card* — the form builds itself.

A subtle guard makes this safe to maintain: a **drift test** iterates the whole registry and asserts every `fields` entry maps to a real Zod schema key, within the right section, with matching optionality. Presentation metadata (`fields`) and validation (the Zod schemas) can never silently desync — if they do, the test goes red.

And a nice security property falls out for free: the client *partitions* fields into credentials vs config, but it isn't *trusted* to — the server re-validates each half against its own Zod schema on the attach route. A mis-sectioned or malformed submit becomes a clean 400, never a bad write.

---

## 8. The verification stories — challenges & fixes

Every integration was proven with a **real** credential against the **real** API — "the tests stub `fetch`" is not the same claim as "it fetched Wayfare's actual deployments." Two themes dominated: **outbound connectivity** and **a genuine credential leak.**

### 8.1 The deferred smoke test — outbound DNS (ENVIRONMENT)
4a merged with its real-Vercel smoke test **explicitly deferred**: at the time, WSL's DNS was being intercepted (the same VPN/WARP issue that made every service look `down` in Phase 3b's §7.6), so the integration worker couldn't reach `api.vercel.com`. The plan said so out loud rather than fake it. When we picked the branch back up, connectivity was restored (`curl api.vercel.com → 403`, i.e. *reached* it), and the deferred test ran for real: a live token fetched **5 real deployments**, `productionStatus: READY`, and the DB row showed the credential encrypted (no plaintext token). Lesson carried from 3b: **"tests pass" ≠ "works against the real API"** — and it's honest to defer a real-world check with a clear reason rather than claim it passed.

### 8.2 The credential leak — Next dev-mode logging (the one that mattered)
Both smoke tests exposed a real problem. Attaching an integration goes through a **Server Action**, and Next.js in dev logs every Server Function invocation *with its arguments*:

```
[web] └─ ƒ attachGithubAction("svc-id", {"owner":"…","repo":"…","token":"ghp_PvYJ…"}) in 602ms
```

The token — a genuine secret — landed in the dev terminal (and the session transcript). **Our** code never logs credentials and stores them encrypted; this was Next's own request logging. Two responses, in order:
- **Immediate:** flag the exposed tokens for **rotation** (recorded as a persistent memory so it resurfaces every session until done — a leaked secret doesn't un-leak because you deleted the log).
- **Structural (4b cleanup D):** `logging: { serverFunctions: false }` in `next.config.ts` — the documented Next 16 lever that disables exactly that arg-echoing line. Dev-only, zero production impact. Future smoke tests won't repeat the leak.

The distinction is the lesson: **encrypting at rest protected the database; it did nothing for a secret in transit through a framework's debug log.** Defense has to cover every surface a secret touches, not just the one you designed.

### 8.3 GitHub's "no Actions" repo — NOT A BUG
The GitHub smoke test attached `thiluxan-s/TravelApp`, which has no GitHub Actions workflows. The card showed commits and **no CI badge** (`ciStatus: null`, `workflowRuns: []`). That's correct — the `deriveCiStatus` function returns `null` for an empty run list, and the card renders accordingly. Worth noting because the reflex is to read "empty" as "broken"; here it's the designed graceful degradation.

### The bottom line
Both integrations were verified end-to-end against real APIs: bad credentials rejected and saved nothing, good credentials populating real cards within a minute, secrets encrypted at rest. The schema-driven form was verified by the zero-literals grep and by attaching both integrations through the *catalog-driven* dialog. The one real problem found (the dev-log leak) was fixed structurally and the exposed tokens flagged for rotation.

---

## 9. The mental model to carry forward

> **An integration is a single object implementing one interface — two Zod schemas, `testCredentials`, `fetchData` — registered in one `Map`. Credentials are encrypted at rest with a versioned AES-256-GCM blob, never returned, never logged. A background worker refreshes each integration on a cadence, containing any failure to a single `last_error`. The attach form renders itself from a server catalog of field descriptors, so the web app names no platform. Adding the next integration — Railway, Fly, a custom webhook — is a new file, one registry line, and a card. If it's ever more than that, the abstraction is wrong.**

The meta-lesson, echoing 3b's §8: the value wasn't just the code, it was the **discipline that kept the abstraction honest** — refusing to let "GitHub needs repo validation" leak platform specifics into core (widening the *generic* contract instead), and refusing to let "the tests pass" stand in for "a real token fetched real data, and the secret didn't leak anywhere." Extensibility is a claim you have to *keep* proving, one integration at a time.

---

### Related docs
- `docs/PHASE_3B_WALKTHROUGH.md` — the real-time layer this phase's worker/UI instinct mirrors.
- `docs/PHASE_2_WALKTHROUGH.md` — the deploy/infra frame (unchanged by this phase, by design).
- `docs/ARCHITECTURE.md` — full system design, including the "how to add an integration" runbook.
- `docs/phases/phase-4-integrations.md` — the phase spec.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — the 4a / GitHub / 4b design specs and implementation plans.
- `.superpowers/sdd/progress.md` — the task-by-task build ledgers + review outcomes.
