# CSP (Report-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a nonce-based `Content-Security-Policy-Report-Only` header on the Beacon web app via Clerk's middleware, validated against the running app, without enforcing yet.

**Architecture:** CSP is emitted from the existing `apps/web/middleware.ts` through `clerkMiddleware`'s native `contentSecurityPolicy` option. Clerk generates the per-request nonce and merges its own directives; a small pure helper (`apps/web/lib/csp.ts`) supplies only Beacon's non-Clerk directives, with `connect-src` derived from the two public env URLs. This PR emits the `Report-Only` header (`reportOnly: true`); enforcement is a separate follow-up.

**Tech Stack:** Next.js 16.2.9 (App Router), `@clerk/nextjs` 7.5.9, TypeScript strict, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-07-11-csp-report-only-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any`. Prefer `type` over `interface`.
- No new dependencies. No new env vars — reuse `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`.
- CSP mechanism is Clerk's `clerkMiddleware({ contentSecurityPolicy })`. Do **not** add a CSP to the Caddyfile. Do **not** hand-specify `script-src` or `frame-src` — `strict: true` + Clerk own those.
- This PR ships `reportOnly: true` only. Do not flip to enforcing. Do not add a `reportTo` / report-collection endpoint.
- Report-Only cannot block content by construction; keep it that way (no enforcing header this PR).
- Keep the change in `apps/web/middleware.ts`. The Next 16 `middleware`→`proxy` file rename is a pre-existing deprecation and is **out of scope** — do not rename the file in this PR.
- Absolute imports via `@/` within the web package. External → workspace → relative import groups, blank line between.
- Conventional commits. Pause for the user's approval before every `git add` / `git commit` (project rule).

---

### Task 1: `buildCspDirectives` helper + unit tests

**Files:**
- Create: `apps/web/lib/csp.ts`
- Test: `apps/web/lib/csp.test.ts`

**Interfaces:**
- Consumes: nothing (pure, depends only on the two URL strings and the global `URL`).
- Produces: `buildCspDirectives(apiUrl: string, wsUrl: string): CspDirectives`, where `CspDirectives` is a map of CSP directive name → array of source-expression strings. `connect-src` contains `'self'` plus the parsed origin of each of the two URLs (invalid/empty URLs are skipped, never throw). Consumed by Task 2's middleware.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/csp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCspDirectives } from './csp';

describe('buildCspDirectives', () => {
  it('puts self plus the API and WS origins in connect-src (production URLs)', () => {
    const d = buildCspDirectives(
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    );
    expect(d['connect-src']).toEqual([
      "'self'",
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    ]);
  });

  it('parses localhost dev URLs to their origins', () => {
    const d = buildCspDirectives(
      'http://localhost:3001',
      'ws://localhost:3001',
    );
    expect(d['connect-src']).toEqual([
      "'self'",
      'http://localhost:3001',
      'ws://localhost:3001',
    ]);
  });

  it('skips an invalid or empty URL instead of throwing', () => {
    const d = buildCspDirectives('', 'wss://api.beacon.thiluxan.com');
    expect(d['connect-src']).toEqual([
      "'self'",
      'wss://api.beacon.thiluxan.com',
    ]);
  });

  it('sets the static hardening directives', () => {
    const d = buildCspDirectives(
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    );
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:']);
    expect(d['font-src']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/csp.test.ts`
Expected: FAIL — `Failed to resolve import './csp'` / `buildCspDirectives is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/web/lib/csp.ts`:

```ts
// Builds Beacon's own CSP directives. Clerk's clerkMiddleware merges its
// required directives on top of these (the script-src nonce + strict-dynamic,
// its Frontend API in connect-src, img.clerk.com, Turnstile frame-src, OAuth
// form-action), so we supply only what the app itself needs. connect-src is
// derived from the two public URLs so dev/localhost/prod all work without
// hardcoded hosts. This is passed as `directives` to the CSP option; it is
// never emitted as an enforcing header on its own (Report-Only this PR).

type CspDirectives = {
  'default-src': string[];
  'connect-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'object-src': string[];
  'base-uri': string[];
  'frame-ancestors': string[];
  'form-action': string[];
};

// Parse a URL to its origin (scheme://host[:port]). ws/wss are special
// schemes, so URL.origin returns a usable value for the WS URL too. Returns
// null (rather than throwing) for an empty or malformed value so a
// misconfigured env degrades connect-src instead of crashing middleware.
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCspDirectives(apiUrl: string, wsUrl: string): CspDirectives {
  const origins = [safeOrigin(apiUrl), safeOrigin(wsUrl)].filter(
    (o): o is string => o !== null,
  );
  const connectSrc = Array.from(new Set(["'self'", ...origins]));

  return {
    'default-src': ["'self'"],
    'connect-src': connectSrc,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run lib/csp.test.ts`
Expected: PASS — 4 passing.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: no errors.

- [ ] **Step 6: Commit (after user approval)**

```bash
git add apps/web/lib/csp.ts apps/web/lib/csp.test.ts
git commit -m "feat(web): CSP directive builder for report-only header"
```

---

### Task 2: Wire the Report-Only CSP into `clerkMiddleware`

**Files:**
- Modify: `apps/web/middleware.ts`

**Interfaces:**
- Consumes: `buildCspDirectives(apiUrl, wsUrl)` from Task 1.
- Produces: middleware that emits `Content-Security-Policy-Report-Only` on document responses. No new exported symbols.

- [ ] **Step 1: Add the CSP option to the middleware**

Replace the `export default clerkMiddleware(...)` block in `apps/web/middleware.ts`. The current file is:

```ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Routes under (app) require authentication.
// /api/clerk/webhook is intentionally excluded — it authenticates via Svix HMAC (Task 9).
const isProtectedRoute = createRouteMatcher([
  '/services(.*)',
  '/domains(.*)',
  '/incidents(.*)',
  '/settings(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static assets.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico)).*)',
    '/(api|trpc)(.*)',
  ],
};
```

Change the imports line and the `export default clerkMiddleware(...)` call to:

```ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

import { buildCspDirectives } from '@/lib/csp';

// Routes under (app) require authentication.
// /api/clerk/webhook is intentionally excluded — it authenticates via Svix HMAC (Task 9).
const isProtectedRoute = createRouteMatcher([
  '/services(.*)',
  '/domains(.*)',
  '/incidents(.*)',
  '/settings(.*)',
]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) await auth.protect();
  },
  {
    // Report-Only for now: observe violations against the running app before
    // enforcing (tracked as a follow-up PR). `strict` adds the per-request
    // nonce + strict-dynamic to script-src; Clerk merges its own directives.
    contentSecurityPolicy: {
      strict: true,
      reportOnly: true,
      directives: buildCspDirectives(
        process.env.NEXT_PUBLIC_API_URL ?? '',
        process.env.NEXT_PUBLIC_WS_URL ?? '',
      ),
    },
  },
);
```

Leave the `export const config = { matcher: [...] }` block unchanged.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @beacon/web`
Expected: no errors. (The `directives` object from Task 1 is structurally assignable to Clerk's `Partial<Record<ContentSecurityPolicyDirective, string[]>>`.)

- [ ] **Step 3: Lint**

Run: `npm run lint -w @beacon/web`
Expected: clean.

- [ ] **Step 4: Build — confirm no breakage and no unexpected static→dynamic shift**

Run: `npm run build -w @beacon/web`
Expected: build succeeds. Note the route table — this app is already fully dynamic (Clerk-gated live dashboard), so reading the nonce should not flip any previously-static route in a surprising way. If the build errors or a route unexpectedly changes rendering mode, stop and investigate before proceeding.

- [ ] **Step 5: Runtime header check**

Ensure `apps/web/.env.local` has `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, and the Clerk keys set (a missing `NEXT_PUBLIC_WS_URL` is a known recurring gotcha — see the project memory note; re-add and restart dev if the client throws a ZodError).

Start dev in the background: `npm run dev -w @beacon/web`
Then: `curl -sI http://localhost:3000/ | grep -i 'content-security-policy'`
Expected: a single `content-security-policy-report-only:` header is present, containing `default-src 'self'`, a `script-src` with `'strict-dynamic'` and a `'nonce-...'`, and a `connect-src` listing `'self'` plus your API and WS origins. There must be **no** enforcing `content-security-policy:` header.

- [ ] **Step 6: Browser validation (the point of Report-Only)**

With dev running, open the app in a browser with devtools console open and exercise: dashboard, a service detail view (confirm the WebSocket connects — it must not be reported against `connect-src`), incidents, and the sign-in page (Clerk scripts). Confirm **zero** CSP Report-Only violations in the console. If a legitimate resource is reported, add its origin to the correct directive in `apps/web/lib/csp.ts` (updating Task 1's test to match) — do **not** loosen with `'unsafe-inline'`/`*` for scripts. Re-run the affected test and the header check.

- [ ] **Step 7: Commit (after user approval)**

```bash
git add apps/web/middleware.ts
git commit -m "feat(web): emit Content-Security-Policy-Report-Only via clerkMiddleware"
```

---

### Task 3: Record status in the security review

**Files:**
- Modify: `docs/SECURITY_REVIEW.md` (finding #2, lines ~14 and ~41-45)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the status table row**

In the status summary table, change finding #2's Status cell from:

```
| 2 | No Content-Security-Policy header | Low | Deferred → own PR (needs runtime validation) |
```

to:

```
| 2 | No Content-Security-Policy header | Low | Report-Only shipped (own PR); enforce tracked as follow-up |
```

- [ ] **Step 2: Update the finding #2 body**

At the end of the "### 2. No Content-Security-Policy header — Low" section, append a status line:

```
**Status:** A nonce-based CSP now ships in `Content-Security-Policy-Report-Only` mode via `clerkMiddleware`'s `contentSecurityPolicy` option (see `docs/superpowers/specs/2026-07-11-csp-report-only-design.md`). Validated locally; the enforcing flip (`reportOnly: false`) is a tracked follow-up PR to run once the live app is observed clean.
```

- [ ] **Step 3: Commit (after user approval)**

```bash
git add docs/SECURITY_REVIEW.md
git commit -m "docs(security): mark CSP finding #2 report-only shipped"
```

---

## Self-Review

**Spec coverage:**
- Mechanism (Clerk middleware, no Caddy) → Task 2. ✓
- Helper deriving connect-src from env URLs → Task 1. ✓
- `strict` + `reportOnly`, no `reportTo`, no report endpoint → Task 2 (option object), Global Constraints. ✓
- Directive set (default/connect/style/img/font/object/base-uri/frame-ancestors/form-action; script-src/frame-src left to Clerk) → Task 1 helper + Task 2. ✓
- No new env vars → Global Constraints; reuse in Task 2. ✓
- Dynamic-render check → Task 2 Step 4. ✓
- Validation (build, dev, curl header shape, browser click-through incl. WSS) → Task 2 Steps 4-6. ✓
- Unit test of helper (origins in connect-src; localhost + prod parse) → Task 1. ✓ (added an invalid-URL and a static-directives case.)
- Docs update to SECURITY_REVIEW #2 → Task 3. ✓
- Out of scope (enforce flip, report endpoint, Caddy, proxy.ts rename) → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; all code and commands are concrete.

**Type consistency:** `buildCspDirectives(apiUrl, wsUrl)` signature and the `connect-src` shape are identical across Task 1 (definition/tests) and Task 2 (call site). `CspDirectives` keys match the assertions in Task 1's tests.
