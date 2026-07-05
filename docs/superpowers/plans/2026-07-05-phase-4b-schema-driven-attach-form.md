# Phase 4b (part 1) — Schema-Driven Attach Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the integration attach form schema-driven — field metadata moves from the hardcoded client `KINDS` map onto the server's `IntegrationDefinition`, is exposed via a catalog endpoint, and is rendered generically by the dialog, so adding an integration never touches the web attach dialog or its server actions again.

**Architecture:** Add a `fields` descriptor to `IntegrationDefinition` (Zod 3.25 has no `.meta()`, so presentation metadata lives beside the schemas, guarded by a drift test); expose it via `GET /internal/integrations`; the detail page fetches the catalog server-side and passes it to the dialog; the dialog renders fields generically and a single `attachIntegrationAction` replaces the two per-kind actions. The attach/remove Hono routes, crypto, worker, and DB schema are unchanged.

**Tech Stack:** Node + Hono, Drizzle + Postgres, Zod 3.25, Next.js 16 (App Router), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-phase-4b-schema-driven-attach-form-design.md`

## Global Constraints

- TypeScript strict; no `any` (use `unknown` + narrow). Prefer `type` over `interface` except the integration contract.
- Zod schemas remain the validation source of truth; `fields` is presentation metadata only (the attach route re-validates on submit).
- **The catalog endpoint exposes only `id`/`name`/`fields` — never `credentialsSchema`, `configSchema`, or any credential value.** Credentials remain encrypted at rest and unlogged by our code.
- Server Actions must never throw across the boundary — try/catch returning `{ ok: true } | { ok: false; error: string }`.
- No new env var, no DB migration, no change to the attach/list/remove route contract, no worker change.
- The web dialog and `actions.ts` must contain **zero** integration-specific string literals (`'vercel'`, `'github'`) after this work.
- Web components/actions are not unit-tested (existing convention) — verified by typecheck + lint + manual smoke.
- Local Postgres must be up for server route tests: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`.
- Monorepo, npm workspaces (`-w @beacon/server`, `-w @beacon/web`, `-w @beacon/shared`).
- Per `apps/web/AGENTS.md`: this is Next.js 16 (may differ from training data) — read the relevant docs in `node_modules/next/dist/docs/` before web changes.
- Conventional commits; run `npm run typecheck` before each commit; **pause for the user's approval before every `git add` / `git commit`** (CLAUDE.md).

## File Structure

- **Modify** `apps/server/src/integrations/types.ts` — add `IntegrationFieldDef` type + `readonly fields` on the interface.
- **Modify** `apps/server/src/integrations/vercel.ts`, `github.ts` — add the `fields` array.
- **Create** `apps/server/src/integrations/registry.test.ts` — generic drift test (fields ↔ schema keys) over the whole registry.
- **Modify** `apps/server/src/router.ts` — add `GET /internal/integrations` + a `toCatalogDto` serializer.
- **Modify** `apps/server/src/router.integrations.test.ts` — add catalog-route tests.
- **Modify** `apps/web/lib/services-api.ts` — add `IntegrationField`/`AvailableIntegration` types + `fetchAvailableIntegrations`.
- **Modify** `apps/web/app/(app)/services/actions.ts` — replace `attachVercelAction`/`attachGithubAction` with one `attachIntegrationAction`.
- **Modify** `apps/web/components/services/integration-attach-dialog.tsx` — render from the `available` prop; remove `KINDS`/`LABELS`/`Kind`.
- **Modify** `apps/web/app/(app)/services/[serviceId]/page.tsx` — fetch the catalog server-side, pass as prop.

---

### Task 1: Server — `fields` descriptor on the integration contract + drift test

**Files:**
- Modify: `apps/server/src/integrations/types.ts`
- Modify: `apps/server/src/integrations/vercel.ts`
- Modify: `apps/server/src/integrations/github.ts`
- Create: `apps/server/src/integrations/registry.test.ts`

**Interfaces:**
- Produces:
  - `type IntegrationFieldDef = { name: string; label: string; type: 'text' | 'password'; section: 'credentials' | 'config'; placeholder?: string; optional?: boolean }` (in `types.ts`).
  - `IntegrationDefinition.fields: readonly IntegrationFieldDef[]` (new required member).
  - `vercelIntegration.fields`, `githubIntegration.fields` populated.

- [ ] **Step 1: Write the failing drift test**

Create `apps/server/src/integrations/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { IntegrationRegistry } from './registry';

// Zod 3.25: a z.object(...) exposes its `.shape` (a record of key → ZodType);
// each ZodType has `.isOptional()`. Integrations declare object schemas, so the
// cast is safe at runtime.
function shapeKeys(schema: z.ZodType): { key: string; optional: boolean }[] {
  const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
  return Object.keys(shape).map((key) => ({ key, optional: shape[key]!.isOptional() }));
}

describe('integration field descriptors match their Zod schemas', () => {
  for (const def of IntegrationRegistry.values()) {
    describe(def.id, () => {
      const credKeys = shapeKeys(def.credentialsSchema);
      const configKeys = shapeKeys(def.configSchema);
      const credFieldNames = def.fields.filter((f) => f.section === 'credentials').map((f) => f.name);
      const configFieldNames = def.fields.filter((f) => f.section === 'config').map((f) => f.name);

      it('declares at least one field', () => {
        expect(def.fields.length).toBeGreaterThan(0);
      });

      it('every credentials field maps to a credentials schema key', () => {
        const keys = credKeys.map((k) => k.key);
        for (const name of credFieldNames) expect(keys).toContain(name);
      });

      it('every config field maps to a config schema key', () => {
        const keys = configKeys.map((k) => k.key);
        for (const name of configFieldNames) expect(keys).toContain(name);
      });

      it('every required schema key has a corresponding field', () => {
        const fieldNames = def.fields.map((f) => f.name);
        for (const { key, optional } of [...credKeys, ...configKeys]) {
          if (!optional) expect(fieldNames).toContain(key);
        }
      });
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- registry`
Expected: FAIL — `def.fields` is `undefined` at runtime → `.filter` throws (fields not yet on the definitions).

- [ ] **Step 3: Add the type + interface member**

In `apps/server/src/integrations/types.ts`, add the field-descriptor type and the new interface member:

```ts
import type { z } from 'zod';

/** Loose per-integration payload; stored as JSONB and rendered by per-integration UI. */
export type IntegrationDataSnapshot = Record<string, unknown>;

/** Presentation metadata for one attach-form field. Zod stays the validation
 *  source of truth; this drives the generic attach form (labels, masking, order). */
export type IntegrationFieldDef = {
  name: string; // must match a key in the section's Zod schema
  label: string;
  type: 'text' | 'password'; // 'password' renders masked
  section: 'credentials' | 'config'; // which Zod schema this field feeds
  placeholder?: string;
  optional?: boolean; // false/absent → required
};

export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  readonly fields: readonly IntegrationFieldDef[];
  testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
```

- [ ] **Step 4: Populate `fields` on Vercel**

In `apps/server/src/integrations/vercel.ts`, add a `fields` member to the `vercelIntegration` object literal (place it right after `configSchema`):

```ts
  fields: [
    { name: 'apiToken', label: 'API token', type: 'password', section: 'credentials', placeholder: '••••••••••••' },
    { name: 'projectId', label: 'Project ID', type: 'text', section: 'config', placeholder: 'prj_abc123' },
    { name: 'teamId', label: 'Team ID', type: 'text', section: 'config', placeholder: 'team_abc123', optional: true },
  ],
```

- [ ] **Step 5: Populate `fields` on GitHub**

In `apps/server/src/integrations/github.ts`, add a `fields` member to the `githubIntegration` object literal (right after `configSchema`):

```ts
  fields: [
    { name: 'token', label: 'Personal access token', type: 'password', section: 'credentials', placeholder: '••••••••••••' },
    { name: 'owner', label: 'Owner', type: 'text', section: 'config', placeholder: 'thiluxan-s' },
    { name: 'repo', label: 'Repository', type: 'text', section: 'config', placeholder: 'beacon' },
  ],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- registry vercel github`
Expected: PASS — drift test green for both integrations (4 checks each); the existing vercel/github tests still pass.

- [ ] **Step 7: Typecheck + commit** (pause for approval)

Run: `npm run typecheck -w @beacon/server`
Expected: exit 0.

```bash
git add apps/server/src/integrations/types.ts apps/server/src/integrations/vercel.ts apps/server/src/integrations/github.ts apps/server/src/integrations/registry.test.ts
git commit -m "feat(server): field descriptors on IntegrationDefinition + schema-drift test"
```

---

### Task 2: Server — `GET /internal/integrations` catalog endpoint

**Files:**
- Modify: `apps/server/src/router.ts`
- Modify: `apps/server/src/router.integrations.test.ts`

**Interfaces:**
- Consumes: `IntegrationRegistry` (already imported in `router.ts`), `IntegrationFieldDef` (Task 1), `resolveUserId` (existing in `createRouter`).
- Produces: `GET /internal/integrations` → `200 { integrations: [{ id, name, fields }] }`; `401` without the internal secret or without a resolvable user.

- [ ] **Step 1: Write the failing route tests**

In `apps/server/src/router.integrations.test.ts`, add these tests inside the top-level `describe('integration routes', ...)` block (the file already defines `app`, `H`, and seeds users via `upsertFromClerk`):

```ts
  it('GET /internal/integrations returns the catalog without schemas or credentials', async () => {
    await upsertFromClerk({ clerkUserId: 'u_cat', email: 'cat@e.com' });
    const res = await app.request('/internal/integrations', { headers: H('u_cat') });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.integrations.map((i: { id: string }) => i.id);
    expect(ids).toContain('vercel');
    expect(ids).toContain('github');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('credentialsSchema');
    expect(raw).not.toContain('configSchema');
    const vercel = body.integrations.find((i: { id: string }) => i.id === 'vercel');
    expect(vercel.fields.some((f: { name: string }) => f.name === 'apiToken')).toBe(true);
  });

  it('GET /internal/integrations is 401 without the internal secret', async () => {
    const res = await app.request('/internal/integrations', { headers: { 'x-clerk-user-id': 'u_cat' } });
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @beacon/server -- router.integrations`
Expected: FAIL — the catalog route does not exist yet (404, not 200/401 as asserted).

- [ ] **Step 3: Add the serializer + import**

In `apps/server/src/router.ts`, add the type import near the other integration imports (after line 8's `IntegrationRegistry` import):

```ts
import type { IntegrationDefinition } from './integrations/types';
```

Add a `toCatalogDto` helper next to `toIntegrationDto` (module scope, above `createRouter`):

```ts
function toCatalogDto(def: IntegrationDefinition) {
  return { id: def.id, name: def.name, fields: def.fields };
}
```

- [ ] **Step 4: Add the route**

In `apps/server/src/router.ts`, register the route inside `createRouter`, immediately after the `app.get('/internal/services/:id/integrations', ...)` handler (so it sits with the other integration routes). Note: the `/internal/services*` secret middleware does NOT cover `/internal/integrations`, so this route checks the secret inline (matching the `/internal/users/upsert` pattern):

```ts
  app.get('/internal/integrations', async (c) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json({ integrations: [...IntegrationRegistry.values()].map(toCatalogDto) });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @beacon/server -- router.integrations`
Expected: PASS — the two new tests plus the existing attach/list/remove tests all green.

- [ ] **Step 6: Full server suite + typecheck + commit** (pause for approval)

Run: `npm run test -w @beacon/server` then `npm run typecheck -w @beacon/server`
Expected: all green; exit 0.

```bash
git add apps/server/src/router.ts apps/server/src/router.integrations.test.ts
git commit -m "feat(server): GET /internal/integrations catalog endpoint"
```

---

### Task 3: Web — catalog-driven dialog (client fn + generic action + dialog + page)

**Files:**
- Modify: `apps/web/lib/services-api.ts`
- Modify: `apps/web/app/(app)/services/actions.ts`
- Modify: `apps/web/components/services/integration-attach-dialog.tsx`
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx`

**Interfaces:**
- Consumes: `GET /internal/integrations` (Task 2); the existing `attachIntegration` client fn; `IntegrationFieldDef` shape (mirrored web-side).
- Produces:
  - `type IntegrationField` + `type AvailableIntegration` + `fetchAvailableIntegrations(clerkUserId: string): Promise<AvailableIntegration[]>` (in `services-api.ts`).
  - `attachIntegrationAction(serviceId: string, integrationId: string, body: { credentials: Record<string, unknown>; config: Record<string, unknown> }): Promise<{ ok: true } | { ok: false; error: string }>` (in `actions.ts`).
  - `<IntegrationAttachDialog serviceId={string} available={AvailableIntegration[]} />`.

> This task changes four files that must land together for a green typecheck: removing the old per-kind actions requires the new dialog, which requires the new action and client fn. Do all four before running verification.
> Read `node_modules/next/dist/docs/` for Next 16 client-component / Server-Action guidance before editing (per `apps/web/AGENTS.md`). Only patterns already used on this page are involved (`'use client'`, `form action={fn}`, `useTransition`, a Server Component passing props).

- [ ] **Step 1: Add the catalog type + client fn**

In `apps/web/lib/services-api.ts`, append (after the existing `IntegrationDto` block / `fetchIntegrations`):

```ts
export type IntegrationField = {
  name: string;
  label: string;
  type: 'text' | 'password';
  section: 'credentials' | 'config';
  placeholder?: string;
  optional?: boolean;
};
export type AvailableIntegration = { id: string; name: string; fields: IntegrationField[] };

export async function fetchAvailableIntegrations(clerkUserId: string): Promise<AvailableIntegration[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/integrations`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchAvailableIntegrations failed: ${res.status}`);
  return (await res.json()).integrations as AvailableIntegration[];
}
```

- [ ] **Step 2: Replace the two per-kind actions with one generic action**

In `apps/web/app/(app)/services/actions.ts`, delete `attachVercelAction` and `attachGithubAction` entirely, and add in their place:

```ts
export async function attachIntegrationAction(
  serviceId: string,
  integrationId: string,
  body: { credentials: Record<string, unknown>; config: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await currentUser();
    if (!user) return { ok: false, error: 'Not signed in' };
    const res = await attachIntegration(user.id, serviceId, {
      integrationId,
      config: body.config,
      credentials: body.credentials,
    });
    if (res.ok) revalidatePath(`/services/${serviceId}`);
    return res;
  } catch (err) {
    console.error('[beacon-web] attachIntegrationAction failed', err);
    return { ok: false, error: 'Could not attach integration.' };
  }
}
```

(`currentUser`, `revalidatePath`, and `attachIntegration` are already imported for `removeIntegrationAction`; leave those imports. `removeIntegrationAction` is unchanged.)

- [ ] **Step 3: Rewrite the dialog to render from the catalog**

Replace the entire contents of `apps/web/components/services/integration-attach-dialog.tsx` with:

```tsx
'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attachIntegrationAction } from '@/app/(app)/services/actions';
import type { AvailableIntegration } from '@/lib/services-api';

export function IntegrationAttachDialog({
  serviceId,
  available,
}: {
  serviceId: string;
  available: AvailableIntegration[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const active = activeId ? (available.find((i) => i.id === activeId) ?? null) : null;

  function close() {
    if (pending) return;
    setActiveId(null);
    setError(null);
  }

  // Re-register on `active`/`pending` so the in-flight guard is never stale.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || pending) return;
      setActiveId(null);
      setError(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, pending]);

  function onSubmit(formData: FormData) {
    if (!active) return;
    setError(null);
    const credentials: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};
    for (const f of active.fields) {
      const value = String(formData.get(f.name) ?? '').trim();
      if (f.optional && value === '') continue; // omit blank optional fields
      (f.section === 'credentials' ? credentials : config)[f.name] = value;
    }
    start(async () => {
      const res = await attachIntegrationAction(serviceId, active.id, { credentials, config });
      if (res.ok) setActiveId(null);
      else setError(res.error);
    });
  }

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
              {available.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-50"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    setActiveId(i.id);
                  }}
                >
                  {i.name}
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
          aria-label={`Attach ${active.name}`}
        >
          <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />
          <form
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">Attach {active.name}</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">Beacon will validate before saving.</p>
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

              {error && <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">{error}</p>}
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

- [ ] **Step 4: Wire the catalog into the detail page**

In `apps/web/app/(app)/services/[serviceId]/page.tsx`:

Add `fetchAvailableIntegrations` to the existing import from `@/lib/services-api` (line 6 imports `fetchIntegrations, fetchService, fetchServiceChecks`):

```tsx
import { fetchAvailableIntegrations, fetchIntegrations, fetchService, fetchServiceChecks } from '@/lib/services-api';
```

After the existing `const integrations = await fetchIntegrations(user.id, serviceId);` (line ~45), add:

```tsx
  const available = await fetchAvailableIntegrations(user.id);
```

Update the dialog usage (line ~102) to pass the prop:

```tsx
          <IntegrationAttachDialog serviceId={service.id} available={available} />
```

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck -w @beacon/web && npm run lint -w @beacon/web`
Expected: exit 0. (If typecheck flags a leftover reference to `attachVercelAction`/`attachGithubAction`, you missed a call site — the dialog is the only consumer and Step 3 replaced it.)

- [ ] **Step 6: Verify zero integration-specific literals remain**

Run: `grep -nE "'vercel'|'github'|\"vercel\"|\"github\"" apps/web/components/services/integration-attach-dialog.tsx apps/web/app/\(app\)/services/actions.ts`
Expected: **no matches** (exit 1). This proves the form is schema-driven — the client no longer names any integration.

- [ ] **Step 7: Commit** (pause for approval)

```bash
git add apps/web/lib/services-api.ts apps/web/app/\(app\)/services/actions.ts apps/web/components/services/integration-attach-dialog.tsx apps/web/app/\(app\)/services/\[serviceId\]/page.tsx
git commit -m "feat(web): render attach form from server integration catalog"
```

---

### Task 4: Full regression + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Full suites**

Ensure Postgres is up: `docker compose -f infrastructure/docker-compose.dev.yml up -d postgres`
Run: `npm run test -w @beacon/shared && npm run test -w @beacon/server && npm run test -w @beacon/web`
Expected: all green (server includes the new `registry.test.ts` + catalog route tests).

- [ ] **Step 2: Root typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0 across all workspaces.

- [ ] **Step 3: Manual smoke — schema-driven attach (success criterion)**

With the dev stack running (`npm run dev`) and outbound internet:
1. Open a service detail page → `Attach ▾`. The dropdown lists **Vercel** and **GitHub**, sourced from the server catalog (not client hardcoding).
2. Pick **Vercel** → the form shows API token / Project ID / Team ID (optional). Attach a real Vercel integration (bad creds must error and save nothing; good creds populate the card).
3. Pick **GitHub** → the form shows Personal access token / Owner / Repository. Attach a real GitHub integration (same bad/good behavior).
4. Confirm the rendered fields, labels, masking, and optional marker match what each integration declares server-side.

> Reuse the tokens flagged for rotation if convenient, or fresh ones — either way, note that the dev-log credential exposure still applies (that suppression is a separate, deferred item). Do not commit any real token.

- [ ] **Step 4: Confirm the abstraction claim**

Verify (by inspection) that adding a hypothetical third integration would require only: its `apps/server/src/integrations/<name>.ts` (with `fields`), one `registry.ts` entry, and its card — and **no** edit to `integration-attach-dialog.tsx` or `actions.ts`. This is the deliverable.

---

## Self-Review

**Spec coverage:**
- Field descriptors on `IntegrationDefinition` + populated for vercel/github → Task 1.
- Drift guard (fields ↔ schema keys) → Task 1 `registry.test.ts`.
- `GET /internal/integrations` catalog (id/name/fields only; no schemas/creds; 401 without auth) → Task 2.
- Web catalog client fn + type → Task 3 Step 1.
- Single generic `attachIntegrationAction` replacing both per-kind actions → Task 3 Step 2.
- Catalog-driven dialog (dropdown from `name`s, fields from catalog, section-partitioned submit, preserved Escape/pending guard) → Task 3 Step 3.
- Detail page fetches catalog server-side, passes as prop → Task 3 Step 4.
- "Zero integration-specific literals" success criterion → Task 3 Step 6 (grep) + Task 4.
- Full regression + manual smoke (both integrations still attach) → Task 4.
- Non-goals (card consolidation, dev-log suppression, shared-types move, Zod introspection) → not present in any task. ✓

**Placeholder scan:** No TBD/TODO-as-code. Every code step shows complete, copyable code. The Zod `.shape`/`.isOptional()` introspection is spelled out with the runtime-safety note.

**Type consistency:** `IntegrationFieldDef` (Task 1) and the web `IntegrationField` (Task 3) carry identical members (`name/label/type/section/placeholder?/optional?`). `AvailableIntegration { id, name, fields }` (Task 3) matches `toCatalogDto`'s `{ id, name, fields }` (Task 2). `attachIntegrationAction(serviceId, integrationId, { credentials, config })` (Task 3 Step 2) matches its caller in the dialog's `onSubmit` (Task 3 Step 3) and feeds the unchanged `attachIntegration(..., { integrationId, config, credentials })` client fn. The catalog route's response `{ integrations: [...] }` matches `fetchAvailableIntegrations` reading `.integrations`.
