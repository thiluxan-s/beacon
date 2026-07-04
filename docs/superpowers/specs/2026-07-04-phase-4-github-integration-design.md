# Phase 4 (part 2) — GitHub Integration Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-04
**Depends on:** Phase 4a (integration engine + Vercel), merged to `main` as PR #8.

## Goal

Add **GitHub** as the second concrete integration, proving the "drop a file + register it" abstraction from Phase 4a. A service can attach a GitHub repo and see its CI (workflow-run) health and recent commits on the service detail page, fetched by the existing integration worker and rendered by a purpose-built card.

This is the second half of Phase 4 (Vercel + GitHub). The generic Zod-driven attach form and the full integration design pass remain deferred to **4b** — this work does the minimal, well-scoped thing that ships GitHub cleanly and sets 4b up.

## Non-goals (YAGNI / deferred)

- The dynamic Zod-schema-driven attach form (4b). The attach dialog is generalized only enough to support two hardcoded integration kinds via a per-kind field descriptor.
- Open-PR counts / issues / release data (the brainstorm chose **CI runs + commits** as the card's content; PRs deferred to 4b if wanted).
- Webhook-driven push updates for GitHub (the polling worker is the mechanism, same as Vercel).
- Any change to credential-encryption or the worker loop. **One deliberate, minimal contract change is in scope:** `IntegrationDefinition.testCredentials` is extended from `(credentials)` to `(credentials, config)` so an integration can validate resource access — not just token validity — at attach time (see "Server → testCredentials"). This is a generic improvement (every integration receives config at test time), not GitHub specifics leaking into core.

## Architecture fit

Phase 4a established: `IntegrationDefinition` interface (`integrations/types.ts`), a registry `Map` (`registry.ts`), one file per integration, a worker that decrypts credentials and calls `fetchData` on a cadence persisting `last_snapshot`, generic ownership-scoped attach/list/remove routes, and per-integration React cards on the detail page. GitHub slots into all of this with **one deliberate contract extension** and otherwise no core changes:

- **New server files:** `apps/server/src/integrations/github.ts`, `apps/server/src/integrations/github.test.ts`.
- **One-line register:** add the GitHub entry to `IntegrationRegistry` in `registry.ts`.
- **Contract extension (generic):** `testCredentials(credentials)` → `testCredentials(credentials, config)` in `types.ts`; the attach route (`router.ts`) passes the already-parsed `config.data` to it. `vercel.ts` needs no change — an object-literal method declared with fewer parameters (`testCredentials(credentials)`) remains assignable to the 2-parameter interface type; only its **test** call sites add the second argument.
- **No** DB migration, **no** new API route, **no** new env var, **no** worker change.

The contract extension is the only core edit, and it is generic — it strengthens every integration's attach-time validation rather than special-casing GitHub. If GitHub required any *further* changes outside `integrations/` (beyond this and the per-integration UI), the abstraction would be wrong. It does not.

## Server: the GitHub integration

File: `apps/server/src/integrations/github.ts`, exporting `githubIntegration: IntegrationDefinition<GithubCredentials, GithubConfig>` with `id: 'github'`, `name: 'GitHub'`.

Endpoints and field names to be confirmed against current GitHub REST docs via Context7 before coding (per CLAUDE.md). Shapes below reflect the documented API as of this spec.

### Credentials & config

- `credentialsSchema`: `z.object({ token: z.string().min(1) })` — a GitHub Personal Access Token.
  - Documented requirement: a PAT with repo **read** access — classic `repo` scope, or a fine-grained token with **Contents: read** + **Actions: read**. Public repos work with any valid token; private repos need the scopes above.
- `configSchema`: `z.object({ owner: z.string().min(1), repo: z.string().min(1) })`.

### Request headers (all calls)

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### `testCredentials(credentials, config)`

The interface is extended so `testCredentials` receives the parsed `config` (see "Architecture fit"). GitHub uses it to validate **both** token validity and repo access at attach time:

- `GET https://api.github.com/repos/{owner}/{repo}` with the auth headers above.
  - `200` → `{ ok: true }` (token is valid **and** can see the repo).
  - `404` → `{ ok: false, error: 'Repo not found or token lacks access' }` (GitHub returns 404 rather than 403 for repos a token cannot see, so this message covers both the typo and the missing-scope case).
  - `401` → `{ ok: false, error: 'Invalid GitHub token' }`.
  - other non-OK → `{ ok: false, error: 'GitHub returned <status>' }`.
  - network error → `{ ok: false, error: 'Could not reach GitHub' }`.
  - Never leak the token in any message.
- Result: a typo'd `owner/repo` or an under-scoped token is **rejected at attach and saves nothing** (the route's `testCredentials` gate), rather than surfacing only later on the card.

### `fetchData(credentials, config)`

Two authenticated calls:

1. `GET /repos/{owner}/{repo}/actions/runs?per_page=5` → `{ workflow_runs: [...] }`.
   - Each run maps to `{ name, status, conclusion, event, createdAt, headSha, url }` from `name`, `status`, `conclusion`, `event`, `created_at`, `head_sha`, `html_url`.
2. `GET /repos/{owner}/{repo}/commits?per_page=5` → an array.
   - Each commit maps to `{ sha, message, author, committedAt, url }` from `sha`, `commit.message` (first line only for `message`), `commit.author.name`, `commit.author.date`, `html_url`.

If either call is not `res.ok`, throw `Error('GitHub <resource> returned <status>')` so the worker records `last_error` and retries next cycle. A repo with **no** Actions returns an empty `workflow_runs` array — that is a success, not an error (`ciStatus: null`).

### Snapshot shape (JSONB, `IntegrationDataSnapshot`)

```ts
{
  ciStatus: 'passing' | 'failing' | 'running' | null,   // derived from the latest workflow run
  workflowRuns: Array<{
    name: string;
    status: string;              // e.g. 'completed', 'in_progress', 'queued'
    conclusion: string | null;   // e.g. 'success', 'failure', 'cancelled', null while running
    event: string | null;        // e.g. 'push', 'pull_request'
    createdAt: string | null;    // ISO
    headSha: string | null;
    url: string | null;
  }>;
  commits: Array<{
    sha: string;
    message: string;             // first line
    author: string | null;
    committedAt: string | null;  // ISO
    url: string | null;
  }>;
  fetchedAt: string;             // ISO
}
```

**`ciStatus` derivation** (from the most recent run, index 0):
- `conclusion === 'success'` → `'passing'`
- `conclusion ∈ { 'failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required' }` → `'failing'`
- no `conclusion` yet and `status ∈ { 'in_progress', 'queued', 'requested', 'waiting', 'pending' }` → `'running'`
- otherwise (`neutral`, `skipped`, unknown, or no runs) → `null`

### Registry

`apps/server/src/integrations/registry.ts` gains one import and one map entry alongside `vercelIntegration`.

## Web UI

Files: modify `apps/web/app/(app)/services/actions.ts`, `apps/web/components/services/integration-attach-dialog.tsx`, `apps/web/app/(app)/services/[serviceId]/page.tsx`; create `apps/web/components/services/github-integration-card.tsx`. Add `attachGithubAction` to `services-api.ts`-backed actions (reuses the existing generic `attachIntegration` client fn — no new client fn needed). `removeIntegrationAction` is already generic (`integrationId`) — unchanged.

> Per `apps/web/AGENTS.md`: read the relevant Next.js 16 docs in `node_modules/next/dist/docs/` before writing the dialog changes (client interactivity / the dropdown).

### Server action

`attachGithubAction(serviceId, { token, owner, repo })` in `actions.ts` — mirrors `attachVercelAction`: builds `config = { owner, repo }`, calls `attachIntegration(user.id, serviceId, { integrationId: 'github', config, credentials: { token } })`, `revalidatePath` on success, same try/catch and `{ ok } | { ok:false, error }` Result shape.

### Attach dialog — light generalization (not 4b)

The current `IntegrationAttachDialog` is Vercel-only. Generalize it to support two **hardcoded** kinds:

- A dropdown launcher: an `Attach ▾` button that opens a small menu (Vercel / GitHub). Selecting a kind opens the dialog with that kind active.
- A `kind` state: `'vercel' | 'github'`.
- A per-kind descriptor: `{ title, fields: Array<{ name, label, type: 'text' | 'password', placeholder, optional?: boolean }>, submit: (serviceId, input) => Promise<Result> }`. The Vercel entry reproduces today's fields (apiToken/projectId/teamId → `attachVercelAction`); the GitHub entry is token (password) / owner / repo → `attachGithubAction`.
- The dialog body renders the active kind's fields and calls its `submit`. Validation errors surface inline exactly as today; the dialog closes on success.

This keeps types explicit and avoids pulling 4b's schema-driven rendering forward, while removing the single-integration hardcoding so the dropdown scales.

### GitHub card

`github-integration-card.tsx` — a server component `{ integration: IntegrationDto }`, matching the Vercel card's density/typography and token usage:

- **Header:** "GitHub" + a `ciStatus` badge (`passing`→status-up, `failing`→status-down, `running`→status-degraded; dot + mono label). No badge when `ciStatus` is null.
- **`parseSnapshot` guard:** narrows `integration.snapshot` (`Record<string, unknown> | null`) into the typed shape; anything non-conforming is treated as "no usable snapshot" (same pattern as the Vercel card).
- **Body:**
  - Latest workflow run line: ✓/✗/• glyph by conclusion, workflow `name`, relative `createdAt`.
  - Recent commits: message (truncated) + short `sha` (7 chars) + relative `committedAt`.
- **States:** error line ("Couldn't reach GitHub — retrying") when `lastError` and no parsed snapshot; empty state ("No activity yet.") when snapshot parses but has no runs and no commits.

### Detail page

Extend the integrations render map: `integrationId === 'vercel'` → `VercelIntegrationCard`; `=== 'github'` → `GithubIntegrationCard`; else null. The existing per-row Remove control (bound to `removeIntegrationAction`) already works for any integration id — reuse it for both.

## Error handling

- **Attach:** invalid body / unknown integration / invalid config or credentials → 400 (existing route logic); `testCredentials` gates the save. GitHub `testCredentials` failure returns a clear, token-free message.
- **Worker/`fetchData`:** any non-OK response throws; the worker catches per-row, records `last_error`, and continues — one repo's failure never stops the batch or crashes the process (Phase 4a behavior, unchanged).
- **Card:** degrades gracefully — error line when the last fetch failed and there's no snapshot; empty state when there's a snapshot but no activity; neutral (no badge) when CI status is unknown.
- **No credential leakage:** the token is encrypted at rest, never logged by our code, and never returned by any route (only `config`/`snapshot`/`lastError` metadata leaves the server). Same Next.js dev-mode Server-Action-arg logging caveat as Vercel applies to the manual smoke test → rotate the PAT after.

## Testing & Definition of Done

- **`github.test.ts`** (mirrors `vercel.test.ts`, `fetch` stubbed via `vi.stubGlobal`):
  - credentials/config schema validation (valid vs empty).
  - `testCredentials(creds, config)`: `{ ok: true }` on 200; `{ ok: false }` on 404 (repo not found / no access) and on 401 (bad token).
  - `fetchData`: maps a run + a commit into the snapshot; derives `ciStatus: 'passing'` from a `success` run.
  - empty-Actions repo (`workflow_runs: []`) → `ciStatus: null`, no throw.
- **`vercel.test.ts`** — update the two `testCredentials(creds)` call sites to `testCredentials(creds, config)` (the interface now takes two args; `vercel.ts`'s implementation is unchanged and ignores the second). Its assertions are otherwise unaffected.
- **Contract regression:** the existing `router.integrations.test.ts` already exercises the attach route's `testCredentials` gate (200 attaches, 401 rejects + saves nothing) — it now also proves config reaches `testCredentials`; no new route test needed, but it must stay green.
- Web components: no unit tests (existing pattern) — verified by typecheck + lint + manual smoke.
- **DoD (matches CLAUDE.md "done"):**
  1. `npm run typecheck` passes (both apps).
  2. `npm run lint` clean (both apps).
  3. Full server suite green (`npm run test -w @beacon/server`, Postgres up).
  4. **Real GitHub smoke test:** attach a real PAT + a real `owner/repo` (e.g. `thiluxan-s/beacon` or `thiluxan-s/TravelApp`) via the UI. A bad token/repo shows the error and saves nothing; a valid one attaches and the worker populates the card with real runs + commits within ~5 min (or sooner by restarting the worker).
  5. No new env var; registry updated; no schema change.
  6. Clear commits explaining *why*; approval before each commit.
  7. Flag PAT rotation after the smoke test (dev-log exposure).

## Files touched (summary)

**Create:** `apps/server/src/integrations/github.ts`, `apps/server/src/integrations/github.test.ts`, `apps/web/components/services/github-integration-card.tsx`.
**Modify:**
- `apps/server/src/integrations/types.ts` — `testCredentials(credentials)` → `testCredentials(credentials, config)`.
- `apps/server/src/router.ts` — pass `config.data` to `testCredentials` in the attach route.
- `apps/server/src/integrations/vercel.test.ts` — add the second arg at the two `testCredentials` call sites.
- `apps/server/src/integrations/registry.ts` — register `githubIntegration`.
- `apps/web/app/(app)/services/actions.ts`, `apps/web/components/services/integration-attach-dialog.tsx`, `apps/web/app/(app)/services/[serviceId]/page.tsx`.
**No change:** `vercel.ts` (fewer-param method stays assignable), DB schema/migrations, crypto, worker, attach/list/remove **route behavior** (only the internal `testCredentials` call gains an argument), env, `services-api.ts` client fns (generic `attachIntegration` reused).
