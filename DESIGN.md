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
- **Accent:** Deep blue, lower saturation than `blue-600`. Specific hex decided in Phase 1.
- **Status colors:**
  - `up` / healthy: A muted green — not kelly green. Think `#3F7D58` not `#22C55E`.
  - `degraded`: A calibrated amber, leaning more golden than orange.
  - `down`: A dialed-down red — serious but not fire-engine. `#B23A48` rather than `#EF4444`.
  - `paused` / unknown: A neutral gray with presence.
- **Background:**
  - Primary: very light gray or off-white (`zinc-50` or `#FAFAFA`).
  - Dark mode candidate (post-v1): `zinc-950` background.

Finalize the accent and status palette before the end of Phase 1.

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

> Decisions go here once Phase 6 builds it. Consider: this might be a single-page README-style explanation linking to the live dashboard. Doesn't need to be elaborate — the *dashboard itself* is the demo.

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

### Incident view (`/incidents/[id]`)

**Goal:** Read a specific incident's timeline. What started it, what happened during it, when it resolved.

> Decisions go here when Phase 4 builds it. Considerations:
>
> - Timeline UI: vertical timeline with events as cards? Linear list?
> - How to present the trigger check vs. resolution check (they're the bookends of the incident).

### Service configuration / "Add service" / "Edit service"

**Goal:** Configure a service, including attaching integrations.

> Decisions go here when Phase 2 builds it. Considerations:
>
> - Multi-step or single form? Probably single form for v1 (simple service config) with integration attachment in a separate flow afterwards.
> - Integration UI: the registry-driven form is unique to this project. Each integration provides a Zod schema; the UI renders a form from that. The pattern is generic.

### Domain detail

**Goal:** SSL expiry, DNS health, domain registration expiry.

> Decisions go here when Phase 2 or 3 builds domains.

---

## Decisions log

Newest first. Capture meaningful choices with one-sentence rationale.

> Entries go here as the project develops. Examples of what to log:
>
> - "Status colors: `up` = `#3F7D58`, `degraded` = `#C18A1F`, `down` = `#B23A48`, `paused` = `#71717A`. Reason: dialed-down saturation reads as 'considered' rather than 'alarm-going-off,' which is the right tone for a dashboard I'll look at all day."
> - "Status dots are 6px on the main dashboard list, 10px on the service detail header. Reason: scale to the surface — readable at a glance on the list, prominent on the detail page."
> - "WebSocket connection indicator lives in the bottom-right corner, not the top. Reason: top-right corner is already crowded with the user menu; bottom-right is the spatial convention for status indicators (see Slack, Linear, VS Code)."
> - "Service list uses a dense table layout, not cards. Reason: tabular alignment makes status, uptime %, and response time visually comparable across rows — cards force the eye to refocus per item."

