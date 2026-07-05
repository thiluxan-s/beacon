# Phase 4 (part 2) — GitHub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship GitHub as the second concrete integration — a repo's CI (workflow-run) health + recent commits, attached from the service detail page and rendered by a purpose-built card.

**Architecture:** Extend the `testCredentials` contract to `(credentials, config)` so repo access is validated at attach time; add `integrations/github.ts` + register it (the "drop a file" payoff); add `attachGithubAction`, a two-kind attach dialog (dropdown launcher), and a GitHub card. No DB migration, no new route, no new env var, no worker change.

**Tech Stack:** Node + Hono, Drizzle + Postgres, Zod, native `fetch`, GitHub REST API (`2022-11-28`), Next.js 16 (App Router), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-phase-4-github-integration-design.md`

## Global Constraints

- TypeScript strict; no `any` (use `unknown` + narrow). Prefer `type` over `interface` except the integration contract.
- Zod schemas are the source of truth; derive types with `z.infer`.
- All DB access through `apps/server/src/db/repositories/` — but this plan adds **no** DB access (attach/list/remove routes and repo are already generic).
- **Credentials (the GitHub token) are never logged and never returned to the client.** Only `config`/`snapshot`/`lastError` metadata leaves the server.
- Background workers never crash on a single failure — `fetchData` throwing is caught by the existing worker, recorded as `last_error`, and the batch continues (Phase 4a behavior, unchanged).
- No new env var. The registry is the only wiring change on the server beyond the new file + contract edit.
- GitHub REST: base `https://api.github.com`; every call sends headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- Confirmed API shapes (verified against docs.github.com while writing this plan):
  - `GET /repos/{owner}/{repo}/actions/runs?per_page=5` → `{ workflow_runs: [{ name, status, conclusion, event, created_at, head_sha, html_url }] }`.
  - `GET /repos/{owner}/{repo}/commits?per_page=5` → top-level array `[{ sha, html_url, commit: { message, author: { name, date } } }]`.
  - `GET /repos/{owner}/{repo}` → 200 if the token can see the repo; 404 if not found / no access; 401 if the token is invalid.
- Server test/typecheck env prefix (vitest.config.ts injects these for tests, so most commands don't need the inline prefix). Local Postgres must be up for any server test that touches the DB: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`. (This plan's new server test — `github.test.ts` — stubs `fetch` and touches no DB.)
- Conventional commits; run `npm run typecheck` before each commit; **pause for the user's approval before every `git add` / `git commit`** (CLAUDE.md).
- Per `apps/web/AGENTS.md`, read the relevant Next.js 16 docs in `node_modules/next/dist/docs/` before writing the web dialog changes.

## File Structure

- **Create** `apps/server/src/integrations/github.ts` — the GitHub `IntegrationDefinition` (schemas, `testCredentials`, `fetchData`, snapshot mapping). One responsibility: talk to GitHub, return a snapshot.
- **Create** `apps/server/src/integrations/github.test.ts` — unit tests with stubbed `fetch`.
- **Create** `apps/web/components/services/github-integration-card.tsx` — server component rendering the GitHub snapshot.
- **Modify** `apps/server/src/integrations/types.ts` — extend `testCredentials` to `(credentials, config)`.
- **Modify** `apps/server/src/router.ts` — pass parsed `config.data` to `testCredentials`.
- **Modify** `apps/server/src/integrations/vercel.test.ts` — add the second arg at two call sites.
- **Modify** `apps/server/src/integrations/registry.ts` — register `githubIntegration`.
- **Modify** `apps/web/app/(app)/services/actions.ts` — add `attachGithubAction`.
- **Modify** `apps/web/components/services/integration-attach-dialog.tsx` — dropdown launcher + two hardcoded kinds.
- **Modify** `apps/web/app/(app)/services/[serviceId]/page.tsx` — render `GithubIntegrationCard` for `integrationId === 'github'`.

---

### Task 1: Extend the `testCredentials` contract to `(credentials, config)`

**Files:**
- Modify: `apps/server/src/integrations/types.ts`
- Modify: `apps/server/src/router.ts:150`
- Modify: `apps/server/src/integrations/vercel.test.ts:23,28`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IntegrationDefinition.testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>` — the second parameter is new. `vercel.ts`'s implementation (declared `testCredentials(credentials)`) stays assignable and is unchanged.

- [ ] **Step 1: Update the interface**

In `apps/server/src/integrations/types.ts`, change the `testCredentials` signature:

```ts
  testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>;
```

(Leave `fetchData` and everything else as-is.)

- [ ] **Step 2: Pass config at the call site**

In `apps/server/src/router.ts`, the attach route currently calls (line ~150):

```ts
    const test = await def.testCredentials(creds.data);
```

Change it to pass the already-parsed config (both are validated just above):

```ts
    const test = await def.testCredentials(creds.data, config.data);
```

- [ ] **Step 3: Update the Vercel test call sites**

In `apps/server/src/integrations/vercel.test.ts`, the file already defines `const config = { projectId: 'prj_1' };` at the top. Update the two `testCredentials` calls to pass it:

Line ~23:
```ts
    expect(await vercelIntegration.testCredentials(creds, config)).toEqual({ ok: true });
```
Line ~28:
```ts
    const r = await vercelIntegration.testCredentials(creds, config);
```

- [ ] **Step 4: Verify existing server suite stays green**

Run: `npm run test -w @beacon/server -- vercel router.integrations`
Expected: PASS — Vercel tests (4/4) and the integration route tests (5/5) unaffected; the route now passes config to `testCredentials` and the gate still behaves identically.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @beacon/server`
Expected: exit 0. (`vercel.ts` compiles unchanged — an object-literal method with fewer parameters is assignable to the wider interface type.)

- [ ] **Step 6: Commit** (pause for approval)

```bash
git add apps/server/src/integrations/types.ts apps/server/src/router.ts apps/server/src/integrations/vercel.test.ts
git commit -m "refactor(server): testCredentials receives config for attach-time resource checks"
```

---

### Task 2: GitHub integration file + registry

**Files:**
- Create: `apps/server/src/integrations/github.ts`
- Create: `apps/server/src/integrations/github.test.ts`
- Modify: `apps/server/src/integrations/registry.ts`

**Interfaces:**
- Consumes: `IntegrationDefinition`, `IntegrationDataSnapshot` from `./types` (with the Task 1 signature).
- Produces:
  - `githubIntegration: IntegrationDefinition<GithubCredentials, GithubConfig>` with `id: 'github'`, `name: 'GitHub'`.
  - `GithubCredentials = { token: string }`, `GithubConfig = { owner: string; repo: string }`.
  - Snapshot shape: `{ ciStatus: 'passing'|'failing'|'running'|null, workflowRuns: Array<{ name, status, conclusion, event, createdAt, headSha, url }>, commits: Array<{ sha, message, author, committedAt, url }>, fetchedAt: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/integrations/github.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubIntegration } from './github';

const creds = { token: 'ghp_abc' };
const config = { owner: 'thiluxan-s', repo: 'beacon' };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

describe('githubIntegration', () => {
  it('validates credentials and config schemas', () => {
    expect(githubIntegration.credentialsSchema.safeParse(creds).success).toBe(true);
    expect(githubIntegration.credentialsSchema.safeParse({}).success).toBe(false);
    expect(githubIntegration.configSchema.safeParse(config).success).toBe(true);
    expect(githubIntegration.configSchema.safeParse({ owner: 'x' }).success).toBe(false);
  });

  it('testCredentials ok on 200', async () => {
    stubFetch(() => new Response('{"full_name":"thiluxan-s/beacon"}', { status: 200 }));
    expect(await githubIntegration.testCredentials(creds, config)).toEqual({ ok: true });
  });

  it('testCredentials error on 404 (repo not found / no access)', async () => {
    stubFetch(() => new Response('{"message":"Not Found"}', { status: 404 }));
    const r = await githubIntegration.testCredentials(creds, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found|access/i);
  });

  it('testCredentials error on 401 (bad token)', async () => {
    stubFetch(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const r = await githubIntegration.testCredentials(creds, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/token/i);
  });

  it('fetchData maps runs + commits and derives ciStatus=passing', async () => {
    stubFetch((url) => {
      if (url.includes('/actions/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { name: 'CI', status: 'completed', conclusion: 'success', event: 'push', created_at: '2026-07-04T10:00:00Z', head_sha: 'abc1234', html_url: 'https://github.com/x/y/actions/runs/1' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          { sha: 'abc1234def', html_url: 'https://github.com/x/y/commit/abc1234def', commit: { message: 'ship it\n\nbody', author: { name: 'Thiluxan', date: '2026-07-04T09:00:00Z' } } },
        ]),
        { status: 200 },
      );
    });
    const snap = await githubIntegration.fetchData(creds, config);
    expect(snap.ciStatus).toBe('passing');
    expect((snap.workflowRuns as unknown[]).length).toBe(1);
    const commits = snap.commits as Array<{ message: string; sha: string }>;
    expect(commits[0]!.message).toBe('ship it'); // first line only
    expect(commits[0]!.sha).toBe('abc1234def');
  });

  it('fetchData with no workflow runs → ciStatus null, no throw', async () => {
    stubFetch((url) => {
      if (url.includes('/actions/runs')) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    const snap = await githubIntegration.fetchData(creds, config);
    expect(snap.ciStatus).toBeNull();
    expect(snap.workflowRuns).toEqual([]);
    expect(snap.commits).toEqual([]);
  });

  it('fetchData throws when a call is not ok (worker records last_error)', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(githubIntegration.fetchData(creds, config)).rejects.toThrow(/GitHub/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- github`
Expected: FAIL — `Cannot find module './github'`.

- [ ] **Step 3: Implement `github.ts`**

Create `apps/server/src/integrations/github.ts`:

```ts
import { z } from 'zod';
import type { IntegrationDataSnapshot, IntegrationDefinition } from './types';

const GithubCredentialsSchema = z.object({ token: z.string().min(1) });
const GithubConfigSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

export type GithubCredentials = z.infer<typeof GithubCredentialsSchema>;
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

const API = 'https://api.github.com';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);
const RUNNING = new Set(['in_progress', 'queued', 'requested', 'waiting', 'pending']);

function deriveCiStatus(run: { status: string; conclusion: string | null } | undefined): 'passing' | 'failing' | 'running' | null {
  if (!run) return null;
  if (run.conclusion === 'success') return 'passing';
  if (run.conclusion && FAILING.has(run.conclusion)) return 'failing';
  if (!run.conclusion && RUNNING.has(run.status)) return 'running';
  return null;
}

export const githubIntegration: IntegrationDefinition<GithubCredentials, GithubConfig> = {
  id: 'github',
  name: 'GitHub',
  credentialsSchema: GithubCredentialsSchema,
  configSchema: GithubConfigSchema,

  async testCredentials(credentials, config) {
    try {
      const res = await fetch(`${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`, {
        headers: ghHeaders(credentials.token),
      });
      if (res.ok) return { ok: true };
      if (res.status === 404) return { ok: false, error: 'Repo not found or token lacks access' };
      if (res.status === 401) return { ok: false, error: 'Invalid GitHub token' };
      return { ok: false, error: `GitHub returned ${res.status}` };
    } catch {
      return { ok: false, error: 'Could not reach GitHub' };
    }
  },

  async fetchData(credentials, config) {
    const base = `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    const headers = ghHeaders(credentials.token);

    const runsRes = await fetch(`${base}/actions/runs?per_page=5`, { headers });
    if (!runsRes.ok) throw new Error(`GitHub workflow runs returned ${runsRes.status}`);
    const runsBody = (await runsRes.json()) as { workflow_runs?: unknown[] };
    const rawRuns = Array.isArray(runsBody.workflow_runs) ? runsBody.workflow_runs : [];
    const workflowRuns = rawRuns.map((r) => {
      const run = r as Record<string, unknown>;
      return {
        name: typeof run.name === 'string' ? run.name : 'workflow',
        status: String(run.status ?? 'unknown'),
        conclusion: (run.conclusion as string | null) ?? null,
        event: (run.event as string | null) ?? null,
        createdAt: typeof run.created_at === 'string' ? run.created_at : null,
        headSha: (run.head_sha as string | null) ?? null,
        url: (run.html_url as string | null) ?? null,
      };
    });

    const commitsRes = await fetch(`${base}/commits?per_page=5`, { headers });
    if (!commitsRes.ok) throw new Error(`GitHub commits returned ${commitsRes.status}`);
    const rawCommits = (await commitsRes.json()) as unknown[];
    const commits = (Array.isArray(rawCommits) ? rawCommits : []).map((c) => {
      const commit = c as Record<string, unknown>;
      const inner = (commit.commit as Record<string, unknown> | undefined) ?? {};
      const author = (inner.author as Record<string, unknown> | undefined) ?? {};
      const message = typeof inner.message === 'string' ? inner.message.split('\n')[0]! : '';
      return {
        sha: typeof commit.sha === 'string' ? commit.sha : '',
        message,
        author: (author.name as string | undefined) ?? null,
        committedAt: (author.date as string | undefined) ?? null,
        url: (commit.html_url as string | null) ?? null,
      };
    });

    const snapshot: IntegrationDataSnapshot = {
      ciStatus: deriveCiStatus(workflowRuns[0]),
      workflowRuns,
      commits,
      fetchedAt: new Date().toISOString(),
    };
    return snapshot;
  },
};
```

> The two endpoints and field names were verified against docs.github.com for this plan; re-confirm with Context7/docs only if something looks off.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- github`
Expected: PASS (7/7).

- [ ] **Step 5: Register the integration**

In `apps/server/src/integrations/registry.ts`, add one import and one map entry:

```ts
import type { IntegrationDefinition } from './types';
import { githubIntegration } from './github';
import { vercelIntegration } from './vercel';

// Add new integrations here — one import + one entry. That is the whole point.
export const IntegrationRegistry: Map<string, IntegrationDefinition> = new Map([
  [vercelIntegration.id, vercelIntegration as IntegrationDefinition],
  [githubIntegration.id, githubIntegration as IntegrationDefinition],
]);
```

- [ ] **Step 6: Typecheck + commit** (pause for approval)

Run: `npm run typecheck -w @beacon/server`
Expected: exit 0.

```bash
git add apps/server/src/integrations/github.ts apps/server/src/integrations/github.test.ts apps/server/src/integrations/registry.ts
git commit -m "feat(server): GitHub integration (CI runs + commits) + registry entry"
```

---

### Task 3: Web — `attachGithubAction` server action

**Files:**
- Modify: `apps/web/app/(app)/services/actions.ts`

**Interfaces:**
- Consumes: `attachIntegration` (already imported in `actions.ts`) — `attachIntegration(clerkUserId, serviceId, { integrationId, config, credentials })`.
- Produces: `attachGithubAction(serviceId: string, input: { token: string; owner: string; repo: string }): Promise<{ ok: true } | { ok: false; error: string }>`.

- [ ] **Step 1: Add the action**

In `apps/web/app/(app)/services/actions.ts`, after `attachVercelAction`, add (mirrors it exactly):

```ts
export async function attachGithubAction(
  serviceId: string,
  input: { token: string; owner: string; repo: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await currentUser();
    if (!user) return { ok: false, error: 'Not signed in' };
    const config: Record<string, unknown> = { owner: input.owner, repo: input.repo };
    const res = await attachIntegration(user.id, serviceId, { integrationId: 'github', config, credentials: { token: input.token } });
    if (res.ok) revalidatePath(`/services/${serviceId}`);
    return res;
  } catch (err) {
    console.error('[beacon-web] attachGithubAction failed', err);
    return { ok: false, error: 'Could not attach GitHub integration.' };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: exit 0.

- [ ] **Step 3: Commit** (pause for approval)

```bash
git add apps/web/app/\(app\)/services/actions.ts
git commit -m "feat(web): attachGithubAction server action"
```

---

### Task 4: Web — two-kind attach dialog (dropdown launcher)

**Files:**
- Modify: `apps/web/components/services/integration-attach-dialog.tsx`

**Interfaces:**
- Consumes: `attachVercelAction`, `attachGithubAction` from `@/app/(app)/services/actions`.
- Produces: `<IntegrationAttachDialog serviceId={string} />` — unchanged prop; now launches via a Vercel/GitHub dropdown and renders the chosen kind's fields.

> Read `node_modules/next/dist/docs/` for any Next 16 client-component guidance before editing (per `apps/web/AGENTS.md`). This is a `'use client'` component; no server-only APIs are used.

- [ ] **Step 1: Rewrite the dialog to be kind-driven**

Replace the contents of `apps/web/components/services/integration-attach-dialog.tsx` with a version that keeps the existing markup/styling but drives fields from a per-kind descriptor. The launcher becomes an `Attach ▾` button that opens a small menu; picking Vercel or GitHub opens the dialog for that kind.

```tsx
'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attachGithubAction, attachVercelAction } from '@/app/(app)/services/actions';

type Kind = 'vercel' | 'github';
type FieldDef = { name: string; label: string; type: 'text' | 'password'; placeholder: string; optional?: boolean };
type Result = { ok: true } | { ok: false; error: string };

type KindDef = {
  title: string;
  fields: FieldDef[];
  submit: (serviceId: string, values: Record<string, string>) => Promise<Result>;
};

const KINDS: Record<Kind, KindDef> = {
  vercel: {
    title: 'Attach Vercel',
    fields: [
      { name: 'apiToken', label: 'API token', type: 'password', placeholder: '••••••••••••' },
      { name: 'projectId', label: 'Project ID', type: 'text', placeholder: 'prj_abc123' },
      { name: 'teamId', label: 'Team ID', type: 'text', placeholder: 'team_abc123', optional: true },
    ],
    submit: (serviceId, v) =>
      attachVercelAction(serviceId, {
        apiToken: v.apiToken ?? '',
        projectId: v.projectId ?? '',
        teamId: (v.teamId ?? '').trim() || undefined,
      }),
  },
  github: {
    title: 'Attach GitHub',
    fields: [
      { name: 'token', label: 'Personal access token', type: 'password', placeholder: '••••••••••••' },
      { name: 'owner', label: 'Owner', type: 'text', placeholder: 'thiluxan-s' },
      { name: 'repo', label: 'Repository', type: 'text', placeholder: 'beacon' },
    ],
    submit: (serviceId, v) =>
      attachGithubAction(serviceId, { token: v.token ?? '', owner: v.owner ?? '', repo: v.repo ?? '' }),
  },
};

const LABELS: Record<Kind, string> = { vercel: 'Vercel', github: 'GitHub' };

export function IntegrationAttachDialog({ serviceId }: { serviceId: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function close() {
    if (pending) return;
    setKind(null);
    setError(null);
  }

  // Re-register on `pending` so the in-flight guard is never stale.
  useEffect(() => {
    if (!kind) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || pending) return;
      setKind(null);
      setError(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind, pending]);

  function onSubmit(formData: FormData) {
    if (!kind) return;
    setError(null);
    const def = KINDS[kind];
    const values: Record<string, string> = {};
    for (const f of def.fields) values[f.name] = String(formData.get(f.name) ?? '');
    start(async () => {
      const res = await def.submit(serviceId, values);
      if (res.ok) {
        setKind(null);
      } else {
        setError(res.error);
      }
    });
  }

  const active = kind ? KINDS[kind] : null;

  return (
    <>
      <div className="relative">
        <Button size="sm" variant="ghost" onClick={() => setMenuOpen((o) => !o)}>
          Attach ▾
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-1 w-32 overflow-hidden rounded-lg border border-zinc-200/80 bg-white py-1 shadow-lg shadow-zinc-950/10">
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-50"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    setKind(k);
                  }}
                >
                  {LABELS[k]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={active.title}
        >
          <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />
          <form
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">{active.title}</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
                Beacon will validate before saving.
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              {active.fields.map((f, i) => (
                <div key={f.name} className="space-y-1.5">
                  <label
                    htmlFor={`iad-${f.name}`}
                    className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                  >
                    {f.label}
                    {f.optional && <span className="normal-case text-zinc-300"> (optional)</span>}
                  </label>
                  <Input
                    id={`iad-${f.name}`}
                    name={f.name}
                    type={f.type}
                    required={!f.optional}
                    autoFocus={i === 0}
                    placeholder={f.placeholder}
                    className="h-8 font-mono text-[12px]"
                  />
                </div>
              ))}

              {error && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">{error}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3.5">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Attaching…' : 'Attach'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exit 0.

- [ ] **Step 3: Commit** (pause for approval)

```bash
git add apps/web/components/services/integration-attach-dialog.tsx
git commit -m "feat(web): two-kind attach dialog with Vercel/GitHub dropdown"
```

---

### Task 5: Web — GitHub integration card + detail-page render

**Files:**
- Create: `apps/web/components/services/github-integration-card.tsx`
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx`

**Interfaces:**
- Consumes: `IntegrationDto` (from `@/lib/services-api`); the GitHub snapshot shape from Task 2.
- Produces: `<GithubIntegrationCard integration={IntegrationDto} />` (server component).

- [ ] **Step 1: Build the card**

Create `apps/web/components/services/github-integration-card.tsx` (mirrors `vercel-integration-card.tsx`'s density, tokens, and `parseSnapshot` guard pattern):

```tsx
import type { IntegrationDto } from '@/lib/services-api';

// GitHub CI status → project --color-status-* tokens (globals.css @theme).
const CI_STYLE: Record<string, { text: string; dot: string; label: string }> = {
  passing: { text: 'text-status-up', dot: 'bg-status-up', label: 'passing' },
  failing: { text: 'text-status-down', dot: 'bg-status-down', label: 'failing' },
  running: { text: 'text-status-degraded', dot: 'bg-status-degraded', label: 'running' },
};

type WorkflowRun = {
  name: string;
  status: string;
  conclusion: string | null;
  event: string | null;
  createdAt: string | null;
  headSha: string | null;
  url: string | null;
};
type Commit = {
  sha: string;
  message: string;
  author: string | null;
  committedAt: string | null;
  url: string | null;
};

function parseSnapshot(snapshot: Record<string, unknown> | null): {
  ciStatus: string | null;
  workflowRuns: WorkflowRun[];
  commits: Commit[];
} | null {
  if (!snapshot) return null;
  const rawRuns = snapshot.workflowRuns;
  const rawCommits = snapshot.commits;
  if (!Array.isArray(rawRuns) || !Array.isArray(rawCommits)) return null;

  const workflowRuns: WorkflowRun[] = rawRuns.map((r) => {
    const run = (r ?? {}) as Record<string, unknown>;
    return {
      name: typeof run.name === 'string' ? run.name : 'workflow',
      status: typeof run.status === 'string' ? run.status : 'unknown',
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      event: typeof run.event === 'string' ? run.event : null,
      createdAt: typeof run.createdAt === 'string' ? run.createdAt : null,
      headSha: typeof run.headSha === 'string' ? run.headSha : null,
      url: typeof run.url === 'string' ? run.url : null,
    };
  });

  const commits: Commit[] = rawCommits.map((c) => {
    const commit = (c ?? {}) as Record<string, unknown>;
    return {
      sha: typeof commit.sha === 'string' ? commit.sha : '',
      message: typeof commit.message === 'string' ? commit.message : '',
      author: typeof commit.author === 'string' ? commit.author : null,
      committedAt: typeof commit.committedAt === 'string' ? commit.committedAt : null,
      url: typeof commit.url === 'string' ? commit.url : null,
    };
  });

  const ciStatus = typeof snapshot.ciStatus === 'string' ? snapshot.ciStatus : null;
  return { ciStatus, workflowRuns, commits };
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// ✓ for a successful conclusion, ✗ for a failing one, • otherwise (running/neutral).
function runGlyph(conclusion: string | null): string {
  if (conclusion === 'success') return '✓';
  if (conclusion && conclusion !== 'neutral' && conclusion !== 'skipped') return '✗';
  return '•';
}

export function GithubIntegrationCard({ integration }: { integration: IntegrationDto }) {
  const parsed = parseSnapshot(integration.snapshot);
  const ciStyle = parsed?.ciStatus ? (CI_STYLE[parsed.ciStatus] ?? null) : null;
  const latestRun = parsed?.workflowRuns[0] ?? null;

  return (
    <div className="rounded-lg border border-zinc-200/60">
      {/* Header */}
      <div className="flex items-center justify-between gap-2.5 border-b border-zinc-200/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-zinc-900">GitHub</span>
          {ciStyle && (
            <span className="flex items-center gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ciStyle.dot}`} aria-hidden="true" />
              <span className={`font-mono text-[10px] font-medium ${ciStyle.text}`}>{ciStyle.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      {integration.lastError && !parsed ? (
        <p className="px-4 py-3 text-[12px] text-status-down">Couldn&apos;t reach GitHub — retrying</p>
      ) : !parsed || (parsed.workflowRuns.length === 0 && parsed.commits.length === 0) ? (
        <p className="px-4 py-3 text-[12px] text-zinc-400">No activity yet.</p>
      ) : (
        <div>
          {latestRun && (
            <div className="flex items-center gap-3 border-b border-zinc-200/40 px-4 py-2 text-[11px]">
              <span className="w-3 shrink-0 text-center font-mono text-zinc-400" aria-hidden="true">
                {runGlyph(latestRun.conclusion)}
              </span>
              <span className="min-w-0 flex-1 truncate text-zinc-600">{latestRun.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-zinc-400">{relativeTime(latestRun.createdAt)}</span>
            </div>
          )}
          {parsed.commits.length === 0 ? (
            <p className="px-4 py-2 text-[11px] text-zinc-400">No commits.</p>
          ) : (
            <ul className="divide-y divide-zinc-200/40">
              {parsed.commits.map((commit, i) => (
                <li key={commit.sha || i} className="flex items-center gap-3 px-4 py-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-zinc-500">
                    {commit.message || '—'}
                    {commit.sha && <span className="ml-1.5 font-mono text-zinc-400">{commit.sha.slice(0, 7)}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-zinc-400">
                    {relativeTime(commit.committedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the card on the detail page**

In `apps/web/app/(app)/services/[serviceId]/page.tsx`:

Add the import next to the Vercel card import (line ~9):
```tsx
import { GithubIntegrationCard } from '@/components/services/github-integration-card';
```

The current render block (lines ~111-127) is a `vercel`-only ternary. Replace it so both kinds render (the Remove control markup is unchanged, just lifted so it wraps whichever card):

```tsx
            {integrations.map((integration) => {
              const card =
                integration.integrationId === 'vercel' ? (
                  <VercelIntegrationCard integration={integration} />
                ) : integration.integrationId === 'github' ? (
                  <GithubIntegrationCard integration={integration} />
                ) : null;
              if (!card) return null;
              return (
                <div key={integration.integrationId}>
                  <div className="flex items-center justify-end pb-1">
                    <form action={removeVercelIntegration.bind(null, service.id, integration.integrationId)}>
                      <button
                        type="submit"
                        className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400 transition-colors hover:text-status-down"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                  {card}
                </div>
              );
            })}
```

> `removeVercelIntegration` (the existing `'use server'` wrapper at the bottom of the file) is integration-agnostic — it already takes `integrationId` and calls `removeIntegrationAction`. Leave its name as-is (renaming is out of scope; it works for both). The 4b design pass can rename it.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exit 0.

- [ ] **Step 4: Commit** (pause for approval)

```bash
git add apps/web/components/services/github-integration-card.tsx apps/web/app/\(app\)/services/\[serviceId\]/page.tsx
git commit -m "feat(web): GitHub integration card on service detail page"
```

---

### Task 6: Full regression + real GitHub smoke test

**Files:** none (verification only).

- [ ] **Step 1: Full server + web + shared suites**

Ensure Postgres is up: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`
Run: `npm run test -w @beacon/shared && npm run test -w @beacon/server && npm run test -w @beacon/web`
Expected: all green (server includes the new `github.test.ts` 7/7 and the updated `vercel.test.ts`).

- [ ] **Step 2: Root typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0 across all workspaces.

- [ ] **Step 3: Manual smoke — real GitHub integration (success criterion)**

With the dev stack running (`npm run dev`) and outbound internet working (`api.github.com` reachable):
1. Open a service detail page → **Attach ▾ → GitHub**.
2. **Failure path:** enter a bad token or a non-existent `owner/repo` → must show the error inline and **save nothing** (no card appears; `GET /repos/{owner}/{repo}` → 404/401 gate).
3. **Success path:** enter a real PAT (classic `repo` scope, or fine-grained Contents:read + Actions:read) + a real `owner/repo` (e.g. `thiluxan-s/beacon` or `thiluxan-s/TravelApp`). The card appears; within ~5 min (or sooner by restarting the worker) it populates with real workflow runs + commits. A repo with no Actions shows commits with no CI badge.
4. Verify in the DB the credential is encrypted at rest and no plaintext token is stored:
   `docker exec beacon-postgres-dev psql -U beacon -d beacon -tAc "SELECT integration_id, (credentials_encrypted LIKE '%ghp_%' OR credentials_encrypted LIKE '%github_pat_%') AS leaks FROM service_integrations WHERE integration_id='github';"` → `leaks` must be `f`.

- [ ] **Step 4: Rotate the PAT + flag it**

⚠️ Next.js dev-mode logs Server Action arguments, so the PAT entered in the smoke test lands in the dev log (and any transcript). After a successful smoke test, **rotate the PAT** in GitHub (Settings → Developer settings → Tokens → revoke + recreate) and note it as a TODO the way the Vercel token was handled. Do NOT commit any real token.

- [ ] **Step 5: Update the "how to add an integration" runbook (Phase 4 deliverable #10)**

In `docs/ARCHITECTURE.md`, in/after the Integration Layer section, confirm or add a short runbook: (1) create `integrations/<name>.ts` implementing `IntegrationDefinition`, (2) add one line to `registry.ts`, (3) add a per-integration card + a kind entry in `integration-attach-dialog.tsx`, (4) add a render branch on the detail page. Keep it to the concrete steps GitHub just followed. If the section already covers this, leave it.

- [ ] **Step 6: Commit any doc change** (pause for approval)

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(phase-4): how-to-add-an-integration runbook"
```

---

## Self-Review

**Spec coverage:**
- Contract extension (`testCredentials(credentials, config)`) → Task 1.
- GitHub integration file (schemas, `testCredentials` via `/repos/{owner}/{repo}`, `fetchData` runs+commits, snapshot, `ciStatus` derivation) → Task 2.
- Registry entry → Task 2 Step 5.
- `attachGithubAction` → Task 3.
- Two-kind attach dialog (dropdown launcher) → Task 4.
- GitHub card + detail-page render + reused Remove control → Task 5.
- `github.test.ts` (schemas, 200/404/401, mapping, empty-Actions, throw) + `vercel.test.ts` call-site update + route regression → Tasks 1–2, 6.
- Error handling (attach gate, worker containment via throw, card degradation, no credential leakage) → Tasks 2, 5, 6.
- DoD (typecheck, lint, full suites, real smoke, PAT rotation) → Task 6.
- Runbook (Phase 4 deliverable #10) → Task 6 Step 5.

**Placeholder scan:** No TBD/TODO-as-code. All code steps show complete, copyable code (`const API = 'https://api.github.com';`).

**Type consistency:** Snapshot field names are identical across producer (Task 2: `ciStatus`, `workflowRuns`, `commits`, and per-item `name/status/conclusion/event/createdAt/headSha/url` and `sha/message/author/committedAt/url`) and consumer (Task 5 `parseSnapshot`). `attachGithubAction(serviceId, { token, owner, repo })` signature matches its caller in the dialog's `github.submit` (Task 4). `testCredentials(creds, config)` signature (Task 1) matches the Vercel test update (Task 1 Step 3), the GitHub impl (Task 2), and the route call site (Task 1 Step 2). `IntegrationDto` is the existing type reused unchanged.
