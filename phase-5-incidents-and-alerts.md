# Phase 5 — Incidents, Alerts, Domains

**Goal:** When a service goes down, an incident is recorded with a timeline. Email alerts fire (with debouncing). Domains are tracked separately for SSL/DNS/expiry. The dashboard feels complete and operational.

**Prerequisite:** Phase 4 complete.

## Deliverables (high level)

1. Schema additions: `incidents`, `incident_events`, `domains`, `domain_checks`, `alerts_sent`.
2. **Incident logic** in the check worker:
   - When a service transitions to a bad status (with 2-failure debouncing), open an incident.
   - When it recovers (with 2-success debouncing), close the incident.
   - Write incident_event rows at each step.
3. **Domain worker** — hourly checks for each domain: DNS resolution, SSL cert expiry, domain registration expiry (via WHOIS or registrar API).
4. **Email alerts via Resend**:
   - On incident open: send email to me (the only user). Include service name, status, error details, link to incident view.
   - Don't re-alert for the same incident.
   - On incident resolve: send a "resolved" follow-up.
5. **UI for incidents:**
   - `/incidents` — list of all incidents (current + recent), filterable by service.
   - `/incidents/[id]` — detail view with timeline of incident_events.
   - Service detail page links to the incident history for that service.
6. **UI for domains:**
   - `/domains` — list with SSL expiry, registration expiry, current status.
   - Warning banners at 30 days / 7 days from SSL expiry.
7. **Settings page:**
   - Toggle email alerts on/off (globally and per-service).
   - Configure alert email destination (default = Clerk user's email).
8. **First real incident captured.** Pick a service, take it down briefly, watch the system work. Capture screenshots for the README.

## Notes for when we get here

- Debouncing is critical. Two consecutive failed checks before opening an incident; two consecutive successful checks before closing. This avoids alert noise from transient blips.
- The alerts_sent table is for deduplication. Before sending an alert, check if one's already been sent for this incident on this channel.
- Domain WHOIS data has weird quirks per TLD. Pick one library and accept that some TLDs will return "unknown" expiry — that's fine for v1.
- This phase is when the project becomes genuinely useful. By the end, I should be using Beacon to monitor my real projects.

---

(More detail to be added before starting this phase.)
