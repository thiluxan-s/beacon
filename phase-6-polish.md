# Phase 6 — Polish, Demo, Ship

**Goal:** The dashboard feels finished. The README sells the infrastructure story hard (it's the differentiator). Everything is documented and verified.

**Prerequisite:** Phase 5 complete.

## Deliverables (high level)

1. **Landing page polish.** Brief, intentional. Explains Beacon, links to the live dashboard. The dashboard URL is the demo (no "Try the demo" path needed — the dashboard is mine, not a demo account).
2. **Demo decisions:** since the dashboard is live and personal, the URL itself becomes the demo. Decide:
   - Public read-only mode for the dashboard? OR
   - Public landing page only, dashboard behind auth (recruiter sees screenshots + video, not the live tool).
   - Lean toward: **public read-only mode of the dashboard at a specific URL** so recruiters see actual real-time updates happening. The risk is exposing internal status of my own projects — but for a portfolio piece showing me running real things, that's actually a feature, not a bug. Decide carefully.
3. **README rewrite — this is THE most important deliverable of the phase.** Sections:
   - Hero: what Beacon is, link to live dashboard.
   - Why this project exists (the systems-engineering story).
   - Architecture diagram (with the WebSocket layer and Integration Layer highlighted).
   - **Infrastructure decisions section** — VPS over serverless, Caddy over Nginx, Docker Compose over Kubernetes, self-hosted Postgres, with the reasoning for each. THIS is what differentiates Beacon. Make it the meatiest section.
   - Tech stack table.
   - Screenshots: main dashboard, service detail, incident timeline, integration card.
   - "How to add a new integration" — show off the architectural seam.
   - Live demo link.
   - Roadmap (v2 features from PRD).
   - Cost ledger.
4. **Architecture diagram.** Custom-drawn (not Mermaid, not screenshotted from the docs). Excalidraw or similar. Show: VPS, Docker network, Caddy, web/server/workers/postgres, external systems (Vercel, GitHub APIs), data flow arrows.
5. **Demo video.** 90-120 seconds: visit landing → dashboard with live status → service detail page → integration card → incident timeline → "here's the README for the architecture story." Embed in README.
6. **Mobile pass.** Beacon is desktop-first, but it should be at least usable on a phone (read-only checking from the couch).
7. **OG image and favicon.** Custom so link previews look good.
8. **Accessibility pass.**
9. **Custom domain.** `beacon.thiluxan.com` or whatever; finalize. Update Cloudflare, Caddy, all references.
10. **Final security review.**
    - Verify no secrets in commits (`git log --all -p | grep -E '(token|secret|key)='`).
    - Verify firewall rules.
    - Verify Caddy security headers.
    - Verify Clerk session security (if applicable).
    - Verify integration credentials are actually encrypted (decrypt one in dev and confirm round-trip).
11. **Verify the full runbook.** Walk through `INFRASTRUCTURE.md`'s runbook section. Can you actually rollback? Restore from backup? SSH in and diagnose a stopped container? If not, fix the runbook.
12. **Update the personal portfolio site** (https://thiluxan.com) to include Beacon as a project. The site already has the format — just add the entry with the right linking.

## Notes for when we get here

- **The README is the most important deliverable in this phase, by far.** Spend a full weekend on it. Treat it like writing — first draft, sleep on it, second draft.
- The infrastructure decisions section should read like a senior engineer's technical writing: opinionated, defended, with trade-offs acknowledged. Avoid "I used X because it's modern" — instead say "I used X because Y constraint mattered more than Z."
- The architecture diagram is worth getting right. Multiple revisions is normal.
- If you do public read-only mode, REALLY verify the read-only enforcement. Recruiters poking at the live tool shouldn't be able to delete your services, regardless of how trustworthy they look.

---

(More detail to be added before starting this phase.)
