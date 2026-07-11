# Content-Security-Policy (Report-Only) — Design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan
**Closes (partially):** `docs/SECURITY_REVIEW.md` finding #2 ("No Content-Security-Policy header" — Low). This PR ships **Report-Only**; enforcement is a tracked follow-up PR.

## Problem

The web host (`beacon.thiluxan.com`) sets HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`, but no Content-Security-Policy — the largest remaining header-hardening item from the Phase 6 security review. A CSP interacts with Next.js hydration scripts and Clerk's scripts and can silently break the app, so the review deferred it to its own PR to be validated against the running application, shipped in `Content-Security-Policy-Report-Only` mode first, then enforced.

## Decision summary

- **Mechanism:** CSP is emitted from `apps/web/middleware.ts` via `clerkMiddleware`'s native `contentSecurityPolicy` option (Clerk `@clerk/nextjs` 7.5.9). Clerk generates a per-request nonce, injects it into Next's and its own scripts, and merges its own required directives. **Not** in Caddy — Caddy cannot inject per-request nonces, so a static Caddy CSP would require `script-src 'unsafe-inline'` (near-useless) or brittle hashes.
- **Rollout:** This PR ships `reportOnly: true` (emits `Content-Security-Policy-Report-Only`). A separate one-line follow-up PR flips to enforcing after the live app has been observed clean.
- **No report-collection endpoint.** `reportTo` is not set. For a single-user portfolio app, violations visible in browser devtools during validation are sufficient; a report-ingest route is unauthenticated write-surface and monitoring infrastructure we don't need. Revisit only if it earns its place.

## Architecture

CSP lives in the existing `apps/web/middleware.ts`, which already wraps the app in `clerkMiddleware`. We pass the `contentSecurityPolicy` option. Caddy's existing security headers on both hosts are unchanged. The `config.matcher` is unchanged — it already runs middleware on all HTML document routes (excluding `_next` and static assets), which is exactly the surface a CSP should cover.

### The configuration

Passed to `clerkMiddleware`:

- `strict: true` — adds `strict-dynamic` + the per-request nonce to `script-src`. Clerk owns `script-src` and `frame-src`; we do not hand-specify them.
- `reportOnly: true` — emit `Content-Security-Policy-Report-Only` for this PR.
- `directives` — only our non-Clerk needs, merged over Clerk's defaults:
  - `default-src 'self'`
  - `connect-src` — `'self'` + the API origin + the WS origin, **derived at module load from `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`** (no hardcoded hosts, so dev/localhost/prod all work). Clerk adds its own.
  - `style-src 'self' 'unsafe-inline'` — required for `next/font`'s injected `<style>` and React's SSR'd inline `style` attributes. Style-based XSS risk is negligible; nonce-ing all library styles is not worth it.
  - `img-src 'self' data:` — favicon/data-URI icons. Clerk adds `img.clerk.com`.
  - `font-src 'self'` — Geist is self-hosted by `next/font`; no Google Fonts host needed.
  - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` (CSP-native mirror of the existing `X-Frame-Options: DENY`).
  - `form-action 'self'` — Clerk augments for OAuth redirects.

### The one extracted unit

A small pure helper (e.g. `buildCspDirectives(apiUrl, wsUrl)`) that returns the `directives` object with the API and WS origins folded into `connect-src`. Extracted so it is unit-testable in isolation. The middleware wires it into `clerkMiddleware`. What it does: turns two URLs into a CSP directives map. How you use it: call with the two public env URLs. What it depends on: nothing but the URL strings (parses origins via `URL`).

## Data flow / rendering

Reading the nonce forces dynamic rendering on affected routes. This app is already fully dynamic (live Clerk-gated dashboard, nothing statically cached), so there is no regression. Implementation must confirm `npm run build` shows no route unexpectedly flipping static→dynamic and no build error.

## Environment

No new env vars. `connect-src` reuses `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`, already validated in `apps/web/lib/env.client.ts`. The middleware reads them from `process.env` directly (build-time-inlined public vars, available in the middleware runtime).

## Error handling / rollback

Report-Only cannot break the app by construction — it only reports violations, never blocks. Rollback is a one-line middleware revert; no infra change, no Caddy reload. The later enforce flip is a separate PR with its own review gate.

## Testing

- **Unit:** test `buildCspDirectives` — assert the API origin and WS origin both land in `connect-src`, and that both a localhost dev URL and a prod `https://`/`wss://` URL parse to the expected origins. Clerk's header assembly is Clerk's tested code and is not re-tested here.
- **No E2E** for a Report-Only header.

## Validation (the point of Report-Only)

1. **Local build:** `npm run build` — no build error; no unexpected static→dynamic route shift.
2. **Local runtime:** `npm run dev`, then drive dashboard, service detail (WebSocket), incidents, and sign-in with devtools open — confirm **zero** Report-Only violations in the console and that the WSS connection is permitted by `connect-src`.
3. **Header shape:** `curl -I` the dev server — confirm `Content-Security-Policy-Report-Only` is present and well-formed.
4. **Post-deploy (user action):** repeat the click-through on the live app — prod Clerk domains differ from dev, so this is the authoritative check. Only once clean does the enforce follow-up proceed.

## Docs

Update `docs/SECURITY_REVIEW.md` finding #2 status → "Report-Only shipped (this PR); enforce tracked as follow-up," referencing this design doc.

## Out of scope

- Flipping to the enforcing `Content-Security-Policy` header (separate follow-up PR).
- Any CSP violation-report collection endpoint.
- Changes to Caddy or the API host headers.
