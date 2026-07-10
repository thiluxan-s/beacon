# Mobile + Accessibility Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Beacon screen usable at ~360px and meet WCAG 2.1 AA basics, per `docs/superpowers/specs/2026-07-10-mobile-a11y-pass-design.md`. No visual rebuild, no new dependencies.

**Architecture:** Add three shared primitives (a reduced-motion/focus-visible CSS layer, a `useFocusTrap` hook, an `aria-live` `StatusAnnouncer`), then apply a consistent responsive treatment + those primitives across the header, lists, detail views, dialogs, and settings. The two logic primitives are TDD'd (jsdom); the responsive/visual changes are verified by building and driving the app at mobile widths + keyboard.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, Tailwind v4, Vitest (jsdom for the primitives). Frontend only.

## Global Constraints

- **Frontend only.** Only files under `apps/web/` change. No server/infra changes.
- **Branch:** `mobile-a11y-pass` (already created; the spec is committed there).
- **No new dependencies** (no `eslint-plugin-jsx-a11y`, no Radix). Verification is manual.
- **Preserve the existing aesthetic** — zinc, mono eyebrows, hairlines, existing type scale. This pass makes it responsive/accessible; it does not restyle.
- **Target:** no horizontal overflow at 360px; primary info (name + status) always visible; visible keyboard focus on every interactive element; `prefers-reduced-motion` respected; ~44px touch targets on mobile.
- **"Done" per task:** `npm run typecheck` + `npm run lint` clean, and existing tests still pass.
- **Responsive list recipe** — every list task applies this exact pattern so rows and their column-headers stay aligned:
  - Primary cell (name/domain): keep `min-w-0 flex-1 truncate`.
  - Status cell: always visible.
  - Secondary cells (last-check, started, duration, SSL, registration): add `hidden sm:flex` (or `hidden sm:block` for a single `<span>`) so they disappear on phones and reappear at `sm`.
  - Any `w-[152px]`/action-spacer in a column-header row: add `hidden sm:block`.
  - Column-header rows: mirror the same `hidden sm:*` on each demoted column so headers align with rows at every breakpoint.
  - Hover-reveal action wrappers: change `opacity-0 ... group-hover:opacity-100` to `opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 focus-within:opacity-100` (always visible on touch; hover-reveal preserved on desktop).
  - Touch targets: interactive controls that fall below ~44px get `min-h-11 sm:min-h-0` (buttons/links) or a padded `<label>` (checkboxes) on mobile.

---

## Task 1: Global primitives (reduced-motion + focus-visible, useFocusTrap, StatusAnnouncer)

**Files:**
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/lib/use-focus-trap.ts`, `apps/web/lib/use-focus-trap.test.ts`
- Create: `apps/web/components/a11y/status-announcer.tsx`, `apps/web/components/a11y/status-announcer.test.tsx`

**Interfaces:**
- Produces: `wrapTabIndex(count: number, currentIndex: number, shiftKey: boolean): number | null` (pure, node-testable Tab-wrap core); `useFocusTrap(active: boolean): React.RefObject<HTMLDivElement>` — traps Tab within the ref'd container while `active`, restores focus to the previously-focused element on deactivate. `StatusAnnouncer({ message }: { message: string }): JSX.Element` — renders `<p role="status" aria-live="polite" class="sr-only">{message}</p>`.

**Testing note:** the web vitest environment is `node` and no DOM library (`jsdom`/`happy-dom`/`@testing-library`) is installed; adding one is out of scope (no new deps). So the DOM-attached behavior (focus move-in/return, event binding) is verified **manually** in Task 9; the unit test here covers the pure `wrapTabIndex` logic only. `StatusAnnouncer` is trivial JSX (no unit test; verified by rendering in the app).

- [ ] **Step 1: CSS — reduced motion + focus-visible fallback**

In `apps/web/app/globals.css`, append:
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

/* Visible keyboard focus for custom interactive elements that reset the native
   outline (shadcn Button already provides its own ring). */
a:focus-visible,
[role='button']:focus-visible,
input[type='checkbox']:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  border-radius: 2px;
}
```

- [ ] **Step 2: Write the failing test for the pure `wrapTabIndex` core**

`apps/web/lib/use-focus-trap.test.ts` (pure logic — runs in the existing `node` vitest env, no DOM):
```ts
import { describe, expect, it } from 'vitest';
import { wrapTabIndex } from './use-focus-trap';

describe('wrapTabIndex', () => {
  it('wraps shift+Tab from the first item to the last', () => {
    expect(wrapTabIndex(3, 0, true)).toBe(2);
  });
  it('wraps Tab from the last item to the first', () => {
    expect(wrapTabIndex(3, 2, false)).toBe(0);
  });
  it('does not wrap from the middle (returns null → browser handles it)', () => {
    expect(wrapTabIndex(3, 1, false)).toBeNull();
    expect(wrapTabIndex(3, 1, true)).toBeNull();
  });
  it('returns null for an empty focusable set', () => {
    expect(wrapTabIndex(0, -1, false)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it (RED)** — `npm run --workspace @beacon/web test -- use-focus-trap` → FAIL (not exported).

- [ ] **Step 4: Implement `wrapTabIndex` + `useFocusTrap`**

`apps/web/lib/use-focus-trap.ts`:
```ts
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * Pure Tab-wrap core. Given the focusable count, the current index, and whether
 * Shift is held, returns the index to focus when the trap must wrap around, or
 * null when no wrap is needed (let the browser move focus normally).
 */
export function wrapTabIndex(count: number, currentIndex: number, shiftKey: boolean): number | null {
  if (count === 0) return null;
  if (shiftKey && currentIndex <= 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}

export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? container).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = focusables();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const target = wrapTabIndex(items.length, currentIndex, e.shiftKey);
      if (target !== null) {
        e.preventDefault();
        items[target]!.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [active]);
  return ref;
}
```

- [ ] **Step 5: Run it (GREEN)** — `npm run --workspace @beacon/web test -- use-focus-trap` → PASS. (The DOM-attached focus move-in/return is verified manually in Task 9.)

- [ ] **Step 6: Implement `StatusAnnouncer` (no unit test — trivial JSX, verified in-app)**

`apps/web/components/a11y/status-announcer.tsx`:
```tsx
export function StatusAnnouncer({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}
```

- [ ] **Step 7: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add apps/web/app/globals.css apps/web/lib/use-focus-trap.ts apps/web/lib/use-focus-trap.test.ts apps/web/components/a11y
git commit -m "feat(web): a11y primitives — reduced-motion CSS, useFocusTrap, StatusAnnouncer"
```

---

## Task 2: Responsive app header

**Files:**
- Modify: `apps/web/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Make the header responsive**

Restructure the header so it is two rows on mobile, one row at `sm`. Keep the top row as wordmark (left) + `ConnectionIndicator` + `UserButton` (right). Move the `<nav>` so that on mobile it becomes a full-width second row below the top bar (horizontally scrollable via `overflow-x-auto`), and at `sm` it sits inline next to the wordmark as today.

Concretely: change the outer `<header>` from a fixed `h-11` single flex row to a container that stacks on mobile and is a row at `sm` (e.g. wrap the top-bar content in its own flex row, and render `<nav>` as a sibling with `flex sm:hidden` mobile styling + an `sm:` inline variant — or one `<nav>` with `flex overflow-x-auto ... sm:overflow-visible` and reflow via order/placement). Nav links get `flex min-h-11 items-center sm:min-h-0` for touch height on mobile and keep their existing mono styling. Ensure the header still `sticky top-0 z-10`.

Give each nav `<Link>` a `focus-visible` treatment (the global rule from Task 1 covers anchors, so no per-link change needed beyond confirming no `outline-none` is set).

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint` (PASS). Manually (Task 9 does the full sweep): at 360px the wordmark, connection indicator, and user button fit the top row and all four nav links are reachable (scroll if needed) with no page-level horizontal overflow.

- [ ] **Step 3: Commit**
```bash
git add "apps/web/app/(app)/layout.tsx"
git commit -m "feat(web): responsive app header (nav reflows on mobile)"
```

---

## Task 3: Services list — responsive + announcer + touch-reachable actions

**Files:**
- Modify: `apps/web/components/services/services-live-list.tsx`
- Modify: `apps/web/components/services/service-row-actions.tsx`

**Interfaces:**
- Consumes: `StatusAnnouncer` (Task 1); the Responsive list recipe (Global Constraints).

- [ ] **Step 1: Apply the responsive list recipe**

In `services-live-list.tsx`: apply the recipe to the summary strip, the column-header row, and each `<li>` row. Demote the "Last check" column (`hidden sm:block` on both the header cell and the row cell). Drop the header's `w-[152px]` action spacer on mobile (`hidden sm:block`). Change the row-actions wrapper from `opacity-0 ... group-hover:opacity-100 focus-within:opacity-100` to `opacity-100 sm:opacity-0 sm:transition-opacity ... sm:group-hover:opacity-100 focus-within:opacity-100`.

- [ ] **Step 2: Announce status changes**

Add an announcement state driven by the existing `onEvent` handler: on a `service.status_changed`, set a message like `` `${name} is now ${status}` `` (look up the name from current `services` state). Render `<StatusAnnouncer message={announcement} />` once in the returned tree.

- [ ] **Step 3: Touch targets on row actions**

In `service-row-actions.tsx`, give the ghost buttons a ~44px tap height on mobile without changing desktop density — add `className="min-h-11 sm:min-h-7"` (or equivalent) to each `Button` (they are `size="sm"` = `h-7`). Keep labels/variants as-is.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS). Manual mobile check deferred to Task 9.
```bash
git add apps/web/components/services/services-live-list.tsx apps/web/components/services/service-row-actions.tsx
git commit -m "feat(web): responsive services list + live-status announcer + touch actions"
```

---

## Task 4: Incidents list + Domains page — responsive + announcer + touch actions

**Files:**
- Modify: `apps/web/components/incidents/incidents-live-list.tsx`
- Modify: `apps/web/app/(app)/domains/page.tsx`
- Modify: `apps/web/components/domains/domain-row-actions.tsx`

**Interfaces:**
- Consumes: `StatusAnnouncer` (Task 1); Responsive list recipe.

- [ ] **Step 1: Incidents list**

Apply the recipe to `incidents-live-list.tsx`: demote "Duration" and "Started" columns (`hidden sm:block` on header + rows); keep Status + Service visible. Add a `StatusAnnouncer` fed by the existing `incident.opened`/`incident.resolved` handler (`` `Incident opened for ${serviceName}` `` / `` `Incident resolved for ${serviceName}` ``; use the row's serviceName where available).

- [ ] **Step 2: Domains page**

Apply the recipe to the domain rows in `domains/page.tsx`: demote SSL + registration columns on mobile (`hidden sm:block` on header + rows); keep domain + status visible. Change the `DomainRowActions` hover-reveal wrapper to the always-visible-on-touch form.

- [ ] **Step 3: Domain row-action touch targets**

In `domain-row-actions.tsx`, apply the same `min-h-11 sm:min-h-7` treatment to its buttons.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add apps/web/components/incidents/incidents-live-list.tsx "apps/web/app/(app)/domains/page.tsx" apps/web/components/domains/domain-row-actions.tsx
git commit -m "feat(web): responsive incidents + domains lists, announcer, touch actions"
```

---

## Task 5: Service detail page — responsive

**Files:**
- Modify: `apps/web/app/(app)/services/[serviceId]/page.tsx`

**Interfaces:**
- Consumes: Responsive list recipe.

- [ ] **Step 1: Make the detail view responsive**

Read the file first (it has a header block, an integrations area, an incidents area, and a recent-checks list). Apply the recipe to the recent-checks list (demote secondary columns like response time / status code on mobile, keep timestamp + status). Ensure the header block and any two-column/grid sections stack on mobile (`grid-cols-1 sm:grid-cols-…` / `flex-col sm:flex-row`) with no fixed widths overflowing at 360px. Preserve the integration-attach trigger and controls (their dialog is handled in Task 7).

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add "apps/web/app/(app)/services/[serviceId]/page.tsx"
git commit -m "feat(web): responsive service detail view"
```

---

## Task 6: Public /demo lists + demo page — responsive + announcer

**Files:**
- Modify: `apps/web/components/public/public-services-list.tsx`, `apps/web/components/public/public-incidents-list.tsx`, `apps/web/components/public/public-domains-list.tsx`
- Modify: `apps/web/app/demo/page.tsx`

**Interfaces:**
- Consumes: `StatusAnnouncer` (Task 1); Responsive list recipe.

- [ ] **Step 1: Public list components**

Apply the recipe to all three public lists (they mirror the authed rows' widths). In `public-services-list.tsx`, add a `StatusAnnouncer` fed by its existing `service.status_changed` handler. Demote secondary columns (last-check on services; duration/started on incidents; SSL/registration on domains) with `hidden sm:block`.

- [ ] **Step 2: Demo page column headers**

In `apps/web/app/demo/page.tsx`, the section column-header rows must demote the SAME columns as the row components (mirror `hidden sm:block`) so headers and rows stay aligned at every breakpoint. Verify the contained panel (`max-w-2xl`) and hero fit at 360px (padding `px-` reduced on mobile if needed).

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add apps/web/components/public "apps/web/app/demo/page.tsx"
git commit -m "feat(web): responsive /demo public lists + live-status announcer"
```

---

## Task 7: Dialog focus trap

**Files:**
- Modify: `apps/web/components/services/service-form-dialog.tsx`, `apps/web/components/domains/domain-form-dialog.tsx`, `apps/web/components/services/integration-attach-dialog.tsx`

**Interfaces:**
- Consumes: `useFocusTrap` (Task 1).

- [ ] **Step 1: Apply the focus trap to each dialog**

In each dialog, call `const trapRef = useFocusTrap(open);` and attach `ref={trapRef}` to the dialog **panel** element (the `<form>`/panel `<div>` that carries `role="dialog"`, not the backdrop). Keep the existing Escape handler, backdrop click-to-close, and `autoFocus` on the first field. Confirm no duplicate/competing focus logic remains.

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS). (Task 9 verifies Tab-trap + focus-return manually.)
```bash
git add apps/web/components/services/service-form-dialog.tsx apps/web/components/domains/domain-form-dialog.tsx apps/web/components/services/integration-attach-dialog.tsx
git commit -m "feat(web): trap + restore focus in modal dialogs"
```

---

## Task 8: Settings page + toggle/checkbox touch targets

**Files:**
- Modify: `apps/web/app/(app)/settings/page.tsx`
- Modify: `apps/web/components/settings/service-alert-toggle.tsx`, `apps/web/components/settings/public-toggles.tsx`

**Interfaces:**
- Consumes: Responsive list recipe (for the per-row lists).

- [ ] **Step 1: Settings responsiveness**

Ensure the settings sections and their per-service / per-entity rows fit at 360px (the rows are `flex items-center justify-between` — confirm the name truncates and the toggle stays on-row; stack if needed). No fixed widths overflowing.

- [ ] **Step 2: Toggle/checkbox touch targets + focus**

In `service-alert-toggle.tsx` and `public-toggles.tsx`, give the checkbox a larger hit area on mobile by padding the wrapping `<label>` (e.g. `min-h-11 sm:min-h-0` on the label, keeping the checkbox visual size). The global `input[type=checkbox]:focus-visible` rule from Task 1 covers the focus ring.

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint` (PASS).
```bash
git add "apps/web/app/(app)/settings/page.tsx" apps/web/components/settings/service-alert-toggle.tsx apps/web/components/settings/public-toggles.tsx
git commit -m "feat(web): responsive settings + touch-friendly toggles"
```

---

## Task 9: Full verification pass

**Files:** none (verification; fix inline if a screen fails, on the relevant task's files).

- [ ] **Step 1: Static gates** — `npm run typecheck && npm run lint` (PASS) and `npm run --workspace @beacon/web test` (existing + new primitive tests PASS).

- [ ] **Step 2: Build** — `npm run --workspace @beacon/web build` completes clean (catches RSC/responsive class issues).

- [ ] **Step 3: Drive the app at mobile widths** — run the app (dev or built) and load, at **360px and 390px**: landing, `/demo`, `/services`, a service detail, `/incidents`, an incident detail, `/domains`, `/settings`, `/sign-in`. Confirm on each: no horizontal page overflow; name + status legible; row actions tappable (services/domains). Use the project run/verify skill or a headless viewport if available; otherwise document the exact widths checked.

- [ ] **Step 4: Keyboard + a11y** — Tab through `/services`, `/settings`, and one dialog: visible focus ring on every interactive element; sensible order; dialog traps Tab and restores focus to its trigger on close; Escape closes. With `prefers-reduced-motion: reduce` emulated, confirm the status dots do not pulse. Confirm the `aria-live` region announces a forced status change (e.g. pause/resume a service).

- [ ] **Step 5: Fix any failures inline** on the owning task's files and re-verify; commit fixes with a clear message.

- [ ] **Step 6: Finish the branch** — invoke `superpowers:finishing-a-development-branch`.

---

## Self-Review

- **Spec coverage:** primitives — reduced-motion + focus-visible + `useFocusTrap` + `StatusAnnouncer` (T1 ← spec A); responsive header (T2 ← spec B); dense lists responsive + announcer + touch actions across authed (T3/T4), detail (T5), and public/demo (T6) (← spec C); dialog focus trap (T7 ← spec D); touch targets across row actions (T3/T4), nav (T2), toggles/checkboxes (T8) (← spec E); verification incl. mobile widths + keyboard + reduced-motion + aria-live (T9 ← spec Verification). All spec sections mapped.
- **Placeholder scan:** the two logic primitives carry real test + implementation code; UI tasks carry concrete class recipes (Global Constraints) rather than "make it responsive" hand-waving.
- **Consistency:** `useFocusTrap(active)` signature is defined in T1 and consumed unchanged in T7; `StatusAnnouncer({ message })` defined in T1 and consumed in T3/T4/T6; the Responsive list recipe is defined once in Global Constraints and referenced by every list task; the same `min-h-11 sm:min-h-*` touch-target idiom is used across T2/T3/T4/T8.
- **Dependency note:** the web vitest env is `node` with no DOM library installed, and no new deps are allowed. T1 therefore unit-tests only the pure `wrapTabIndex` core (node-safe); the DOM-attached focus behavior and `StatusAnnouncer` render are verified manually in T9. No task adds a dependency.
