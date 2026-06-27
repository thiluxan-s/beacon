# Phase 4 — Integrations (Vercel + GitHub)

**Goal:** Services can have integrations attached. The integration layer is built around the `IntegrationDefinition` interface and the central registry. Vercel and GitHub are the two integrations shipped in v1. The pattern is proven, and adding more integrations later is "drop a file."

**Prerequisite:** Phase 3 complete.

> Read `docs/ARCHITECTURE.md` "Integration Layer" section carefully before planning. The abstraction is the differentiator.

## Deliverables (high level)

1. Schema additions: `service_integrations`. Encryption logic for credentials.
2. `apps/server/src/lib/crypto.ts` — `encrypt()` / `decrypt()` using AES-256-GCM and `INTEGRATIONS_ENCRYPTION_KEY` env var.
3. `apps/server/src/integrations/types.ts` — the `IntegrationDefinition` interface.
4. `apps/server/src/integrations/registry.ts` — the central registry.
5. `apps/server/src/integrations/vercel.ts` — the Vercel integration:
   - `credentialsSchema`: API token.
   - `configSchema`: `projectId`, `teamId` (optional).
   - `testCredentials`: hit `GET /v2/projects` to verify.
   - `fetchData`: most recent deployments + their build status.
6. `apps/server/src/integrations/github.ts` — the GitHub integration:
   - `credentialsSchema`: personal access token.
   - `configSchema`: `owner`, `repo`.
   - `testCredentials`: hit `GET /repos/{owner}/{repo}`.
   - `fetchData`: latest commits on default branch, open PRs, latest workflow runs.
7. **Integration worker** (`apps/server/src/workers/integration-worker.ts`) — polls for due integration fetches (e.g., every 5 minutes per service-integration), runs `fetchData`, persists `last_snapshot`.
8. **UI: attach integrations to a service.**
   - "Add integration" flow on the service detail page.
   - Dynamic form generated from the chosen integration's Zod credentials schema (this is the architectural payoff).
   - Validate credentials before saving via `testCredentials`.
9. **UI: render integration data.**
   - Per-integration React components — `<VercelIntegrationCard />`, `<GitHubIntegrationCard />` — read `last_snapshot` and render in their own way.
   - The service detail page lists all configured integrations as cards.
10. Documentation in `docs/ARCHITECTURE.md` updated with "how to add an integration" runbook so future-me can do it in one afternoon.

## Notes for when we get here

- The credentials-form-generation-from-Zod is the most interesting UI pattern in this project. Pick a Zod-to-form library (or build a small one) — `react-hook-form` + a custom adapter is one approach.
- For demo purposes, configuring at least ONE real Vercel integration (probably to Wayfare or Investor Thesis) before the phase ends is the success criterion. Same for GitHub.
- The integration cards on the service detail page are part of the dashboard's visual quality — spend design-pass time here. They're a major surface that recruiters will look at.

---

(More detail to be added before starting this phase.)
