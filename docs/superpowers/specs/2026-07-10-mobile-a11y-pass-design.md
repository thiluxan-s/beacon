# Mobile + Accessibility Pass — Design Spec

**Date:** 2026-07-10
**Type:** Frontend (Phase 6 — Polish, Demo, Ship; deliverables #6 mobile pass + #8 accessibility pass)

## Goal

Make every Beacon screen usable on a phone (down to ~360px) and meet WCAG 2.1 AA basics, without a visual rebuild. Beacon is desktop-first by design; this pass ensures "read-only checking from the couch" works and that the UI is keyboard- and screen-reader-navigable — a credible portfolio signal.

## Target

- **Mobile:** no horizontal overflow at 360px; primary info (name + status) always legible; all actions reachable on touch.
- **A11y (WCAG 2.1 AA basics):** visible keyboard focus everywhere; live status changes announced; dialogs trap focus and restore it; motion respects `prefers-reduced-motion`; adequate touch targets; status never conveyed by color alone (already satisfied — dot **+ text label**).

## Audit (current state, `main`)

Confirmed issues:
1. **Header nav overflows on phones** — wordmark + 4 nav links + connection indicator + `UserButton` in one non-wrapping `px-5` row.
2. **Dense list rows overflow** — fixed columns (`w-24`/`w-28`/`w-32` + a 152px action spacer) across services, incidents, domains, service detail, `/demo`, and the public lists.
3. **Row actions are hover-only** (`opacity-0 group-hover:opacity-100`) in `services-live-list` and the domains page → unusable on touch.
4. **Small touch targets** — buttons 28–32px tall; 11px mono nav links.
5. **No `prefers-reduced-motion`** — `animate-pulse` status dots run for everyone.
6. **No `aria-live`** — WS-driven status changes are silent to screen readers.
7. **Dialogs lack focus trap / focus-return** — the 3 hand-rolled modals have `role="dialog"`/`aria-modal` + Escape + autofocus, but Tab escapes the modal and focus isn't restored on close.
8. **Focus-visible** — shadcn `Button` has a ring; custom nav links, row `<Link>`s, and checkboxes need a verified visible ring.

Already good: landing page is responsive (hides the decorative panel `<lg`); status uses dot **+ text label**; `header`/`nav`/`main` landmarks present.

## Approach & file map

### A. Global primitives

- **`apps/web/app/globals.css`** — add:
  - `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` (neutralizes `animate-pulse`) and near-zero transition/scroll behavior.
  - A `:focus-visible` fallback ring for interactive elements that suppress the native outline (scoped so it doesn't double up on shadcn `Button`).
- **Create `apps/web/lib/use-focus-trap.ts`** — `useFocusTrap(active: boolean): RefObject<HTMLElement>`: on `active`, records the previously focused element, moves focus into the container (first focusable, or the container), traps Tab/Shift+Tab within the container's focusable set, and restores focus to the previous element on deactivate. (Escape handling stays in each dialog; this hook owns Tab-trap + focus-return only.)
- **Create `apps/web/components/a11y/status-announcer.tsx`** — an SR-only `aria-live="polite"` region: `<StatusAnnouncer message={string} />` renders `<p className="sr-only" aria-live="polite" role="status">{message}</p>`. Used by the live lists to announce changes.

### B. App shell — responsive header

- **`apps/web/app/(app)/layout.tsx`** — on mobile, the 4 nav links drop to their own full-width row beneath the top bar (wordmark + connection indicator + `UserButton` stay on the top row); the nav strip is horizontally scrollable if it exceeds width. Desktop (`sm+`) keeps the current single-row layout. No JS menu; all links remain present and keyboard-reachable. Give nav links a larger tap area on mobile (min-height ~44px) and a `focus-visible` ring.

### C. Dense lists → responsive + announced

Apply a consistent responsive pattern to each list: **name + status stay primary; secondary columns demote to a second line or `hidden sm:flex`/`sm:block` on phones; drop the fixed action-spacer on mobile.** Add the SR-only announcer where WS events already flow.

- **`apps/web/components/services/services-live-list.tsx`** — responsive rows; `StatusAnnouncer` fed from the existing `service.status_changed` handler ("<name> is now <status>"); make the hover-reveal actions always-visible on touch (`opacity-100`, `sm:opacity-0 sm:group-hover:opacity-100`); column-header row hides demoted columns on mobile.
- **`apps/web/components/incidents/incidents-live-list.tsx`** — responsive rows; `StatusAnnouncer` from the `incident.opened`/`incident.resolved` handler ("Incident opened/resolved for <service>").
- **`apps/web/app/(app)/domains/page.tsx`** — responsive rows; make the hover-reveal `DomainRowActions` always-visible on touch.
- **`apps/web/app/(app)/services/[serviceId]/page.tsx`** — responsive header + recent-checks list (demote secondary columns on mobile).
- **`apps/web/components/public/public-services-list.tsx`** — responsive rows + `StatusAnnouncer` (the `/demo` live surface).
- **`apps/web/components/public/public-incidents-list.tsx`**, **`public-domains-list.tsx`** — responsive rows.
- **`apps/web/app/demo/page.tsx`** — column-header rows hide demoted columns on mobile (must stay aligned with the row components' responsive widths).

### D. Dialogs — focus trap + return

- **`apps/web/components/services/service-form-dialog.tsx`**, **`apps/web/components/domains/domain-form-dialog.tsx`**, **`apps/web/components/services/integration-attach-dialog.tsx`** — attach `useFocusTrap(open)` to the dialog panel; keep existing Escape + backdrop-close + autofocus. Verify focus returns to the trigger button on close.

### E. Touch targets

- Row-action buttons (`ServiceRowActions`, `DomainRowActions`), the settings toggles (`ServiceAlertToggle`, `public-toggles`), and nav links get a ~44px interactive area on touch (min-height/padding), without changing the desktop density. Checkboxes get a larger hit area via a padded `<label>`.

## Verification

- **Manual, at mobile widths (360px + 390px):** load every screen (landing, `/demo`, services, service detail, incidents, incident detail, domains, settings, sign-in) — confirm no horizontal overflow, name+status legible, actions tappable.
- **Keyboard:** Tab through each screen — visible focus ring on every interactive element, sensible order; open each dialog — Tab stays trapped, Escape closes, focus returns to the trigger.
- **Reduced motion:** with `prefers-reduced-motion: reduce` set, confirm status dots don't pulse.
- **Screen-reader smoke:** confirm the `aria-live` region announces a forced status change.
- Run `npm run typecheck && npm run lint` clean.

## Out of scope

- Adding `eslint-plugin-jsx-a11y` or any new dependency (would need explicit approval per the no-new-deps rule). Verification is manual this pass.
- Migrating the dialogs onto a Radix/shadcn Dialog primitive (the `useFocusTrap` hook is the minimal fix; a primitive migration is a larger, separate change).
- A bottom tab-bar mobile nav (the two-row header is the chosen approach).
- Visual redesign — this pass preserves the existing aesthetic; it only makes it responsive and accessible.
- The CSP header (tracked separately as its own PR).

## Success criteria

- No horizontal overflow on any screen at 360px; primary info always visible.
- Every interactive element is keyboard-focusable with a visible ring; dialogs trap and restore focus.
- Live status changes are announced via `aria-live`.
- `prefers-reduced-motion` disables the pulse animations.
- `typecheck` + `lint` clean; existing tests still pass.
