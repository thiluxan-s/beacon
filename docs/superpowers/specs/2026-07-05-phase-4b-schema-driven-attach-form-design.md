# Phase 4b (part 1) — Schema-Driven Attach Form Design

**Status:** Approved (brainstorm) — ready for implementation planning.
**Date:** 2026-07-05
**Depends on:** Phase 4 (Vercel + GitHub integrations), merged to `main` as PR #8 and PR #9.

## Goal

Make the integration attach form **schema-driven**: the field metadata that is currently hardcoded in the web dialog's `KINDS` descriptor moves onto the server's `IntegrationDefinition`, is exposed via a catalog endpoint, and is rendered generically by the dialog. After this, **adding an integration never touches the web attach dialog or its server actions** — only the integration's own server file, its registry entry, and its card. This is the architectural payoff Phase 4 named ("dynamic form generated from the chosen integration's schema").

## Non-goals (YAGNI / deferred)

- **Card consolidation.** The `relativeTime` helper (and the status-token maps) remain duplicated across `vercel-integration-card.tsx` and `github-integration-card.tsx`. Cards render integration-specific snapshots and are not part of "the attach form." Deferred to a later pass.
- **Suppressing Next dev-mode Server-Action credential logging.** The token-in-dev-log caveat from the smoke tests is a separate cross-cutting concern; not in this plan.
- **Deriving field metadata from Zod introspection.** Zod is 3.25 (no `.meta()`), so schemas cannot carry labels/masking hints. An explicit `fields` descriptor is used instead (see Design).
- **Moving DTO types into `packages/shared`.** The codebase currently redefines DTO types web-side (e.g. `IntegrationDto` in `services-api.ts`); this spec follows that existing pattern rather than introducing shared types.
- **Any change to the attach/remove Hono routes' contract, the credential crypto, the worker, or the DB schema.**

## Architecture fit

Today the web dialog (`apps/web/components/services/integration-attach-dialog.tsx`) hardcodes a `KINDS: Record<Kind, KindDef>` map — per-integration field lists, labels, and a `submit` fn that calls a per-integration server action (`attachVercelAction`, `attachGithubAction`). The server owns the `IntegrationRegistry` and the Zod schemas but does not expose field metadata. This spec inverts the ownership: the **server** becomes the single source of field metadata, and the **client** renders whatever the catalog describes.

The existing generic attach route (`POST /internal/services/:id/integrations`, body `{ integrationId, config, credentials }`, Zod-validated + `testCredentials`-gated) and the generic web client fn `attachIntegration(...)` are reused unchanged. Only the presentation layer and one new read endpoint change.

## Design

### Server: field descriptors on the integration definition

Add a field-descriptor type and a `fields` array to the integration contract.

`apps/server/src/integrations/types.ts`:

```ts
export type IntegrationFieldDef = {
  name: string;                        // must match a key in the section's Zod schema
  label: string;                       // human label, e.g. "API token"
  type: 'text' | 'password';           // display hint; 'password' renders masked
  section: 'credentials' | 'config';   // which Zod schema this field feeds
  placeholder?: string;
  optional?: boolean;                  // false/absent → required in the form
};

export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  readonly fields: readonly IntegrationFieldDef[];   // NEW
  testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
```

Populate `fields` for each integration, lifting the exact descriptors from today's client `KINDS`:

- **Vercel** (`vercel.ts`):
  - `{ name: 'apiToken', label: 'API token', type: 'password', section: 'credentials', placeholder: '••••••••••••' }`
  - `{ name: 'projectId', label: 'Project ID', type: 'text', section: 'config', placeholder: 'prj_abc123' }`
  - `{ name: 'teamId', label: 'Team ID', type: 'text', section: 'config', placeholder: 'team_abc123', optional: true }`
- **GitHub** (`github.ts`):
  - `{ name: 'token', label: 'Personal access token', type: 'password', section: 'credentials', placeholder: '••••••••••••' }`
  - `{ name: 'owner', label: 'Owner', type: 'text', section: 'config', placeholder: 'thiluxan-s' }`
  - `{ name: 'repo', label: 'Repository', type: 'text', section: 'config', placeholder: 'beacon' }`

**Separation of concerns:** Zod schemas remain the validation source of truth (the attach route re-validates on submit). `fields` is presentation metadata only — labels, masking, ordering, required-ness — which Zod 3 cannot express. A unit test guards against drift (see Testing).

### Server: catalog endpoint

`apps/server/src/router.ts` — add a read route:

- `GET /internal/integrations` → `200 { integrations: [{ id, name, fields }] }`, built by mapping `IntegrationRegistry.values()` through a serializer that returns only `id`, `name`, and `fields`. **Never** serializes `credentialsSchema`, `configSchema`, or any credential value.
- Auth: requires the internal-secret header and resolves a user (matches the existing internal-route pattern; 401 without). It is a global catalog, **not** service-scoped — no ownership check, no `:id` param.

### Web: catalog client fn + generic server action

`apps/web/lib/services-api.ts` — add the DTO and client fn (mirroring the existing web-side `IntegrationDto` pattern):

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

export async function fetchAvailableIntegrations(clerkUserId: string): Promise<AvailableIntegration[]>;
```

`fetchAvailableIntegrations` GETs `/internal/integrations` with the standard headers, `cache: 'no-store'`, throws on non-OK, returns `.integrations`.

`apps/web/app/(app)/services/actions.ts` — replace `attachVercelAction` and `attachGithubAction` with one generic action:

```ts
export async function attachIntegrationAction(
  serviceId: string,
  integrationId: string,
  body: { credentials: Record<string, unknown>; config: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }>;
```

It calls `currentUser()`, then `attachIntegration(user.id, serviceId, { integrationId, config: body.config, credentials: body.credentials })`, `revalidatePath` on success, wrapped in try/catch returning a Result (never throws across the boundary). `attachVercelAction` / `attachGithubAction` are deleted.

### Web: catalog-driven dialog

`apps/web/components/services/integration-attach-dialog.tsx` — accept the catalog as a prop and render from it. Remove the hardcoded `Kind` union, `KINDS`, and `LABELS`.

- New prop: `available: AvailableIntegration[]`. The component's other prop (`serviceId`) and export name (`IntegrationAttachDialog`) are unchanged.
- The `Attach ▾` dropdown lists `available.map(i => i.name)`; selecting one sets the active integration (by `id`) and opens the dialog.
- The dialog title is `Attach ${integration.name}`; the body maps `integration.fields` to inputs (label, `type`, `placeholder`, `required = !optional`, unique `id`s, `autoFocus` on the first) — same markup/styling as today.
- On submit, partition the flat form values by each field's `section` into `credentials` and `config`. Any `optional` field whose trimmed value is empty is omitted from its object entirely (preserving today's empty-`teamId`→`undefined` behavior); required fields pass through as-is. Then call `attachIntegrationAction(serviceId, integration.id, { credentials, config })` inside the existing `useTransition`; show the returned error inline on failure; close on success.
- The Escape/`pending` in-flight guard, backdrop, and dropdown-close behavior are preserved from the current implementation.

`apps/web/app/(app)/services/[serviceId]/page.tsx` — the Server Component additionally calls `fetchAvailableIntegrations(user.id)` and passes it as `<IntegrationAttachDialog serviceId={service.id} available={available} />`. No client-side fetch or loading state. The per-integration card rendering (Vercel/GitHub) and the Remove control are unchanged.

## Data flow

1. Detail page (Server Component) fetches the catalog server-side → prop to the dialog.
2. User picks an integration from the dropdown → dialog renders its `fields`.
3. Submit → dialog partitions values by `section` → generic `attachIntegrationAction` → existing `attachIntegration` client fn → existing Hono attach route → Zod-validates + `testCredentials` → encrypts + upserts.
4. Failure at any validation/credential step → route returns 400 with a token-free message → surfaced inline. Success → `revalidatePath` re-renders the page with the new card.

## Error handling

- **Client mis-sections a field:** harmless — the server's Zod `configSchema`/`credentialsSchema` parse rejects it with a 400; credentials are never returned. The client is not trusted for validation, only for rendering.
- **Catalog fetch fails** (server down): `fetchAvailableIntegrations` throws; the detail page's existing error boundary / data-unavailable handling applies (same as `fetchIntegrations` today). The attach control simply cannot be opened.
- **Server Action** never throws across the boundary — try/catch returning a Result, matching the actions it replaces.
- **No credential leakage:** the catalog endpoint serializes only `id/name/fields`; the attach route continues to return only metadata; credentials remain encrypted at rest and unlogged by our code.

## Testing & Definition of Done

- **Server — fields/schema drift guard** (per integration, vercel + github): assert every `field.name` in `section: 'credentials'` is a key of `credentialsSchema` and every `section: 'config'` field is a key of `configSchema`; and every **required** schema key (non-optional) has a corresponding field. This makes `fields` and the Zod schemas impossible to silently desync. (Introspect schema keys via the Zod object shape.)
- **Server — catalog route test** (`GET /internal/integrations`): returns both integrations with `id/name/fields`; the JSON contains no `credentialsSchema`/`configSchema` and no credential values; 401 without the internal secret.
- **Server — regression:** existing `router.integrations.test.ts` (attach/list/remove) stays green — the route contract is unchanged.
- **Web:** no component unit tests (existing convention) — typecheck + lint + manual smoke. The generic `attachIntegrationAction` gets no unit test (thin, like the actions it replaces).
- **Full regression:** `npm run test` (shared/server/web), `npm run typecheck`, `npm run lint` — all green.
- **Manual smoke (success criterion):** dev stack up; open a service → `Attach ▾` lists both integrations **sourced from the server catalog**; attach Vercel and attach GitHub each still work end-to-end (bad creds rejected + saved nothing, good creds populate the card). Then grep the dialog file for `'vercel'` / `'github'` — **zero** integration-specific literals must remain. That absence is the proof the form is schema-driven.
- **DoD (matches CLAUDE.md "done"):** typecheck + lint clean both apps; server suite green incl. the two new tests; the attach dialog and `actions.ts` contain no per-integration code; no new env var; no DB/route-contract/worker change; approval before each commit; clear commit messages.

## Files touched (summary)

**Modify:**
- `apps/server/src/integrations/types.ts` — add `IntegrationFieldDef` + `fields` on the interface.
- `apps/server/src/integrations/vercel.ts`, `github.ts` — add the `fields` array.
- `apps/server/src/router.ts` — add `GET /internal/integrations` + its serializer.
- `apps/web/lib/services-api.ts` — add `IntegrationField`/`AvailableIntegration` + `fetchAvailableIntegrations`.
- `apps/web/app/(app)/services/actions.ts` — replace two per-kind actions with one `attachIntegrationAction`.
- `apps/web/components/services/integration-attach-dialog.tsx` — render from the `available` prop; remove `KINDS`/`LABELS`/`Kind`.
- `apps/web/app/(app)/services/[serviceId]/page.tsx` — fetch the catalog server-side, pass as prop.

**Create:**
- Server tests: a fields/schema-drift test (may live alongside each integration's existing `*.test.ts` or a single `registry.test.ts`) and a catalog-route test (in `router.integrations.test.ts` or a new `router.catalog.test.ts`).

**No change:** attach/list/remove route contract, `attachIntegration`/`removeIntegration` client fns, crypto, worker, DB schema, env, the per-integration cards.
