# Design

This document is the source of truth for visual design decisions on Beacon. Read it before any UI work. Update it after making a meaningful design choice.

Beacon is a **dashboard product**, which means it has a different design challenge than Wayfare or Investor Thesis:

- Wayfare = consumer-facing, content-rich, generous spacing.
- Investor Thesis = mixed, with a dashboard surface that has to feel premium.
- Beacon = dense operational dashboard. Information at a glance is everything. Generous whitespace would *hurt* this product.

---

## Reference apps (the bar we're aiming for)

- **[Linear](https://linear.app)** — still the gold standard for product surfaces. Their density-and-typography balance is what every dashboard should aim for.
- **[Vercel dashboard](https://vercel.com/dashboard)** — directly relevant: deploys list, project list, monitoring. Look at how they present status (small dots, colors, typography). Don't copy; understand.
- **[Plain](https://plain.com)** — typography and information density, even though it's a different product space.
- **[Cron](https://cron.com)** — calendar product but the dashboard density and visual rhythm are exemplary.
- **[Pulse](https://pulse.is/)** — for status-page aesthetics.

What we are *not* aiming for:
- Tailwind admin templates. They all look the same.
- "AI-startup with gradient mesh and shader background." Not us.
- "Bootstrap with custom colors." Not us either.
- Grafana. Their density is high but their typography is poor.

---

## Design principles

These are the calls we made when the design comes under tension.

1. **Density is a feature, not a tradeoff.** This is an operational dashboard. The user wants to see everything at once. Default toward more information per screen, not less.
2. **Status uses color sparingly and deliberately.** Green/amber/red ARE the language of the dashboard — but they're tiny indicators (3-5px dots, narrow bars), never large blocks. A red card on a busy dashboard reads as panic; a red dot reads as a signal.
3. **Type does the work.** Sizes and weights create hierarchy. Borders almost never. Colors only for status.
4. **One accent color.** A deep blue or a graphite — decided in Phase 1. Status colors are a separate palette (green/amber/red, calibrated to read as serious not alarming).
5. **Real-time updates must be visible but not distracting.** When a status changes, the UI should *change* — but not flash, bounce, or yell. A subtle pulse, a smooth color transition, a number that updates. The user catches it in peripheral vision.
6. **Server Components by default is also a visual quality choice.** Pages that render instantly feel premium. Skeletons that match the layout are better than spinners.

---

## Visual tokens

> To be finalized in Phase 1 when the dashboard layout is built.

### Color palette

**Working assumptions:**

- **Neutrals:** Slate or Zinc, full range. Use real darks (`zinc-900`+) and real lights (`zinc-50`).
- **Accent:** **DECIDED — graphite `#27272a` (zinc-800).** Chosen over blue because the status palette (green/amber/red) already carries all the color meaning; a second hue would compete with signal. Monochrome chrome keeps attention on status, not chrome.
- **Status colors:**
  - `up` / healthy: A muted green — not kelly green. Think `#3F7D58` not `#22C55E`.
  - `degraded`: A calibrated amber, leaning more golden than orange.
  - `down`: A dialed-down red — serious but not fire-engine. `#B23A48` rather than `#EF4444`.
  - `paused` / unknown: A neutral gray with presence.
- **Background:**
  - Primary: very light gray or off-white (`zinc-50` or `#FAFAFA`).
  - Dark mode candidate (post-v1): `zinc-950` background.

**DECIDED (Phase 1):** Brand accent = graphite `#27272a`. Status palette locked — see color tokens above. Both are registered as `--color-brand` / `--color-status-*` in `apps/web/app/globals.css`. (`--color-brand` not `--color-accent` — shadcn's `@theme inline` already maps `--color-accent` to a light hover-gray; overriding it would break ghost/outline buttons.)

### Typography

- **Sans serif:** Inter or Geist. Single family for the app.
- **Monospace:** Geist Mono or JetBrains Mono — used for service URLs, status codes, response times, anywhere numbers/code appear.
- **Weights used:** 400 (body), 500 (subtle emphasis, labels, table headers), 600 (page headings, primary actions).
- **Line height:** Tighter than Wayfare. 1.3-1.4 on data, 1.5-1.6 on prose.
- **Numeric font features:** Enable `tabular-nums` everywhere numbers appear in lists (response times, uptime %, counts). This is non-negotiable; non-tabular numbers in tables look wrong.

### Spacing

- **4 / 8 / 12 / 16 / 24** as the primary scale on dashboards. Avoid 32+ on data surfaces.
- **48-64** spacing only on marketing-style surfaces (landing page, settings groups).
- **Use whitespace, not borders**, as the primary grouping mechanism. When borders ARE needed, they're hairline + low contrast (`zinc-200` at 1px).

### Motion

- **Transitions:** 150-200ms cubic-bezier(0.4, 0, 0.2, 1) is the default. Faster than Wayfare's tasteful spring — this is a dashboard, not a magazine.
- **Status changes:** When a service goes up→down, the color transitions over 300ms, optionally with a brief pulse to draw the eye. No bouncing. No flashing.
- **New data arriving:** Slide in from where it makes sense (top of a list, or in-place fade). Avoid layout shifts that move existing content unexpectedly.
- **WebSocket connection indicator:** A small dot in a corner. Color transitions when state changes (green→yellow→red). No motion that demands attention.
- **No hover animations on dense list items.** Hover changes the background subtly; that's it.

---

## Per-screen decisions

> Filled in as we build. Each screen gets a short block: layout choice, type choices, color choices, motion choices, and reasoning for non-default choices.

### Landing page (public)

**Goal:** Briefly explain what Beacon does and link to the dashboard. The dashboard URL is for me; the landing page is for recruiters.

**Decisions (Phase 1):**

- **Layout:** Asymmetric split — left 52%: primary content; right 52%: ghost dashboard preview (absolute-positioned, decorative, `opacity-0.22`). Recruiter sees what the product looks like before reading a word.
- **Status strip:** Fixed 3px horizontal bar at top, 4 segments in status colors (weighted up > degraded > down > paused). Product type is immediately legible.
- **Background:** `zinc-50` + subtle radial dot grid (CSS only, 24px spacing). Appropriate for a systems tool; zero visual noise.
- **Typography:** Eyebrow in Geist Mono, uppercase, `tracking-[0.2em]`, `text-[10px]`. H1 weight 600, `tracking-[-0.025em]`, tight leading. Body at `zinc-500`.
- **Ghost dashboard:** Static rows with real service names, status dots, uptime %, latency. Actual product data will replace this in production. `up` dots pulse via CSS animation — the page feels alive without JS.
- **Stack tags:** Mono, uppercase, `text-[10px]`, `zinc-400` — tech story told without paragraphs.
- **Footer:** Pulsing green dot + mono "Self-hosted · thiluxan.dev" — grounds the product without a footer section.
- **CTA:** Graphite `#27272a` rounded-md button. Ghost text link for system status with a `→` arrow. No icons, no decorations.

### Sign-in page

**Goal:** Get me in fast. Single user.

> Decisions go here once Phase 1 builds it.

### Main dashboard (`/`)

**Goal:** All services and domains at a glance. Status is instantly readable. Live updates feel seamless.

> Decisions go here once Phase 3 builds it. Considerations:
>
> - Layout: full-width, dense grid OR table OR card list — pick one and commit. Probably a hybrid: a primary table-like list with rich status cells.
> - Sidebar yes/no? If yes, what lives there (navigation? filters? service tree?)
> - How is the WebSocket connection state surfaced (corner dot? Top bar?)
> - "Add service" — prominent button or hidden in a menu?

### Service detail (`/services/[id]`)

**Goal:** Drill into one service. Live status, check history, integration data, related incidents.

> Decisions go here once Phase 3 builds it. Considerations:
>
> - Layout: sidebar with service nav + main content? Or full-width back-button navigation?
> - Check history: sparkline (last hour) + paginated table (further back) is one option. Vercel does something like this.
> - Integration sections: stacked or tabbed? If integrations vary across services, tabs feel right.

### Incidents list (`/incidents`)

**Goal:** See every recorded incident across all services at a glance, with ongoing incidents impossible to miss and live open/resolve updates streaming in without a refresh.

**Decisions (Phase 5a):**

- **Column order leads with Status, not Service.** The services list leads with the service name because identity is the primary scan key there. On the incidents list, severity/urgency is the primary scan key — a recruiter (or me, at 2am) needs to see "is anything ongoing right now" before "which service." The ongoing/resolved dot + label sits first, the service name second.
- **Summary strip mirrors `ServicesLiveList`'s pattern exactly** (ongoing/resolved counts on the left, a verdict string right-aligned) so the two list pages read as the same system. Red tint (`bg-red-50/40` + `border-red-100/80`) only appears when at least one incident is ongoing — otherwise it's the neutral `zinc-50/50` strip, same threshold logic as the services strip's `hasIssues`.
- **Ongoing incidents pulse** — same `animate-pulse` treatment as the "up" status dot elsewhere, applied to `bg-status-down` instead. Reuses the existing motion language (subtle pulse, no bounce/flash) rather than inventing a new "urgent" animation.
- **Resolved rows use a neutral gray dot (`bg-zinc-300`), not red.** Red (with the pulse) is reserved for *ongoing* incidents. The gray matches the summary strip's own "N resolved" dot sitting directly above the list, so the page reads as one system, and — reviewed with a recruiter's eyes — a closed incident labeled "resolved" never carries an alarm-red dot that could read as still-failing at a glance. (Superseded the initial build, where every row inherited the red severity dot; see the timeline's green-resolved note for how the two pages now differ.)
- **Placeholder service name (`'…'`) for a freshly-opened incident pushed over WS** is intentional, not a bug: the `incident.opened` WS payload carries no `serviceName`. The real name fills in on the next Server Component render of this route — i.e. when the user navigates away and back (or any future `revalidatePath('/incidents')`). There is **no** timed auto-refresh on `/incidents` in 5a, so a live-opened incident shows `…` until then; every other field (link, status, duration, time) is correct. This mirrors the `ServicesLiveList` adoption trick, which needs no placeholder only because `status_changed` already carries full data.
- **Top-level list is resilient to fetch failure**, matching `/services`: a caught error shows a neutral "Couldn't load incidents — retrying" banner instead of crashing the page, per the DB-outage resilience convention.
- **No skeleton/`loading.tsx` added.** `/services` doesn't have one either — the Server Component fetch is same-origin and fast enough in practice that a loading state would flash. Revisit both together if that stops being true.

### Incident view (`/incidents/[id]`)

**Goal:** Read a specific incident's timeline. What started it, what happened during it, when it resolved. This is the PRD's "wow" screen — a recruiter clicking into an incident should immediately understand the system did real work.

**Decisions (Phase 5a):**

- **Timeline is a plain vertical list, not cards.** Each event is a single line (event type + message, timestamp right-aligned) connected by a hairline rule with a status-colored dot — closer to a Linear activity log than a "card per event" pattern. Cards would add borders/shadows the density principle argues against; a list keeps many events scannable at once.
- **Dot + connecting-rule are built as a single self-contained flex column per row** (`w-2 flex-col items-center`, dot + an absolutely-positioned `w-px` rule both centered by flexbox alignment), not a single continuous `border-l` down the `<ol>` with hand-tuned negative-`left` offsets on each dot. The `border-l` approach positions each dot with a magic-number offset (e.g. `-left-[5px]`) chosen to sit the dot centered on the border — a hardcoded value that has to be re-tuned whenever the dot size, rule width, or row padding changes, and is easy to get pixel-wrong. The flex-column version needs no offset at all: flexbox guarantees the dot and the rule share the same horizontal center by construction, and the rule's `bottom: -16px` reaches exactly into the next row's `pb-4` gap regardless of how tall any given row's message text is (single line or wrapped).
- **Timeline dot semantics: opened = red (`status-down`), observed = amber (`status-degraded`), resolved = green (`status-up`), note = neutral gray.** The timeline is read chronologically as a sequence of steps, not scanned as a queue of items to triage — so its resolved dot reads as "this step went well" (green). This differs from the incidents *list*, where a resolved row is a neutral gray dot (see list decision above): the list signals "closed / no longer active," the timeline signals "recovered." Both are deliberately non-alarming — neither page shows red on a resolved incident.
- **The live header (`IncidentLiveHeader`) mirrors that same green-on-resolve logic**, not the brief's original baseline (dot always red, resolved text `zinc-500`). Once `resolvedAt` is set — either from the initial server fetch or from the `incident.resolved` WS event — both the dot and the label switch to `status-up` green. The header is a single-incident summary directly above a timeline that already ends on a green dot; leaving the header red after resolution would read as unresolved at a glance, undermining the timeline immediately below it. (The list page signals resolution differently — a neutral gray dot rather than green — but it, too, never leaves a resolved incident red; see its Phase 5a decision.)
- **Ongoing header pulses (`animate-pulse` on the dot) and ticks a live duration every second** via a client-only `setInterval`, cleared on unmount and the moment `resolvedAt` flips (no server polling — the tick is local UI state only). On `incident.resolved`, the header patches its own `resolvedAt`/`durationSeconds` from the WS payload immediately (no visible flash) and calls `router.refresh()` once to pull any interim `observed` events into the timeline below it, since `observed` events aren't pushed live in this phase.
- **No separate "trigger check vs. resolution check" bookend treatment.** The `opened` and `resolved` events already sit first/last in the list with distinct colors (red/green) and `font-medium` labels — that's enough visual distinction without a special-cased layout for just those two rows.

### Service configuration / "Add service" / "Edit service"

**Goal:** Configure a service, including attaching integrations.

> Decisions go here when Phase 2 builds it. Considerations:
>
> - Multi-step or single form? Probably single form for v1 (simple service config) with integration attachment in a separate flow afterwards.
> - Integration UI: the registry-driven form is unique to this project. Each integration provides a Zod schema; the UI renders a form from that. The pattern is generic.

### Settings (`/settings`)

**Goal:** Global email-alerts toggle + destination email, per-service alert toggles. The plainest screen in the app — a form, not a dashboard surface — so it borrows the section/eyebrow/hairline vocabulary rather than inventing anything new.

**Decisions (Phase 5b):**

- **Native `<input type="checkbox">` with `accent-status-up`, not a shadcn/custom Switch.** No Switch primitive exists in this project yet, and a settings page with two toggle types (global + per-row) isn't enough surface area to justify introducing one. `rounded-[3px] border-zinc-300` is added so the checkbox doesn't look like a stock OS control next to `rounded-lg` buttons/inputs elsewhere on the page — a one-line, zero-dependency polish.
- **Resilience banner ("Couldn't load settings — retrying") added to match `/services` and `/incidents`.** The baseline draft fetched settings + services with no `try/catch`, which would have crashed the page on a DB blip — inconsistent with the DB-outage resilience convention (CLAUDE.md) that every other data-backed page already honors. Same neutral-dot + mono-label treatment, same behavior (hide the data sections while the banner is up, not partial/stale content).
- **First section header (`Email alerts`) carries `pb-2` like every other section h2 in the app** (see `/services/[serviceId]`'s Integrations/Incidents/Recent-checks headers), with the content wrapper's top padding removed to match. The initial draft double-padded (h2 `pt-4` + form `py-4`), which would have left an oversized gap under the "Email alerts" eyebrow relative to "Per-service" below it.
- **Checkbox label text is `zinc-900`, not `zinc-800`.** `zinc-900` is the established color for primary 13px/medium row text (service names in `/services`, dialog headings) — `zinc-800` doesn't appear anywhere else at that weight/size.

### Domain detail

**Goal:** SSL expiry, DNS health, domain registration expiry.

> Decisions go here when Phase 2 or 3 builds domains.

---

## Decisions log

Newest first. Capture meaningful choices with one-sentence rationale.

- **Settings page reuses native checkboxes (`accent-status-up`, `rounded-[3px] border-zinc-300`) instead of introducing a Switch component**, and gets the same "couldn't load — retrying" resilience banner as `/services`/`/incidents` (the task's baseline draft had no `try/catch` around the settings/services fetch). Reason: no Switch primitive existed yet and two checkbox use-cases didn't justify adding one; every other data-backed page already has the DB-outage banner, so settings shouldn't be the one exception.

- **Incident timeline dot + connecting rule is a self-contained flex column per row (dot and rule both centered by `items-center`), not a continuous `border-l` with hand-computed negative-`left` dot offsets.** Reason: the border-l approach's dot offset depends on the containing `<li>`'s own margin, which is easy to get subtly pixel-wrong and doesn't self-correct if spacing changes later; the flex-column version is centered by flexbox construction, guaranteed correct regardless of row height.
- **Timeline event dots: opened=red, observed=amber, resolved=green, note=gray — resolved is green on the timeline, whereas the incidents list uses a neutral gray dot for a resolved row (red reserved for ongoing).** Reason: the list is scanned as a queue (gray = "closed, not active"), the timeline is read chronologically as a sequence of steps (green resolved = "the incident ended well"). Neither page shows red on a resolved incident.
- **`IncidentLiveHeader` turns its dot and label green (`status-up`) on resolve, not muted gray as the task brief's baseline snippet had it.** Reason: the header sits directly above a timeline whose final dot is green; leaving the header red after resolution would read as "still failing" one paragraph above a timeline that just said the opposite.
- **App header nav (Services / Incidents) is plain mono text links, no active-state styling.** Reason: with only two top-level routes, active state is low-value signal; keeping the header a Server Component (it already awaits `ensureUserExists`) avoids introducing a client-only `usePathname` wrapper for a two-item nav.
- **Incidents list leads its column order with Status, not Service name** (opposite of the services list). Reason: severity is the primary scan key for an incident list — "is anything ongoing" matters before "which service" — so the pulsing ongoing/resolved indicator sits first.
- **Landing page uses an asymmetric split with a ghost dashboard preview (right panel, ~22% opacity).** Reason: the product concept lands visually before any text is read — a recruiter sees service rows and status dots in their peripheral vision, which sets context instantly.
- **Status strip as a 3px fixed top bar with 4 weighted segments.** Reason: the most compressed possible encoding of "this product has four service states" — it reads as a status bar for the status-bar product.
- **Landing page background uses a CSS radial dot grid.** Reason: connects to the "graph paper / systems engineering" aesthetic; zero performance cost (pure CSS); subtler than a border grid.
- **CTA button uses `bg-brand` utility (resolves to `--color-brand: #27272a`).** Reason: shadcn's `--color-accent` maps to a light hover color in its component system; the brand token is now `--color-brand` to avoid the collision. `bg-brand` is generated by Tailwind v4 from the `@theme` block.
- **Stack tech tags (Node.js + Hono / WebSockets / DigitalOcean / Caddy) in mono, uppercase, zinc-400.** Reason: tells the tech story without a paragraph; hiring managers scanning for stack recognition catch it in two seconds.
- **Brand accent = graphite `#27272a` (zinc-800), registered as `--color-brand`, not blue.** Reason: the status palette (green/amber/red) already carries all the hue-based meaning in this UI; a blue accent would compete with status signals. Named `--color-brand` (not `--color-accent`) to avoid overriding shadcn's light-hover accent mapping.
- **Status colors: `up` = `#3F7D58`, `degraded` = `#C18A1F`, `down` = `#B23A48`, `paused` = `#71717A`.** Reason: dialed-down saturation reads as 'considered' rather than 'alarm-going-off,' which is the right tone for a dashboard I'll look at all day.

