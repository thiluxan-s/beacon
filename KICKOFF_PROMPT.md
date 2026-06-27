# Kickoff prompt for Claude Code

Copy-paste this into the first Claude Code session in the empty repo.

---

We're starting a new project called **Beacon**. It's a self-hosted, real-time monitoring dashboard for services I run. Tagline: "Monitor anything you ship." Architecture is platform-agnostic — services are monitored at the HTTP layer with optional per-platform integrations (Vercel and GitHub in v1; Railway, Fly, AWS, custom webhooks designed-for-but-not-built).

This is my third portfolio project. The first two:
- **Wayfare** (https://github.com/thiluxan-s/TravelApp) — travel "second brain" with one-shot AI extraction.
- **Investor Thesis** — agentic-AI thesis tracker.

Both are on Next.js + Vercel + serverless. Beacon is deliberately **different**: long-running Node/Bun server (Hono), WebSockets for real-time, self-hosted on a DigitalOcean Droplet with Docker Compose, Caddy reverse proxy, real deploy pipeline via GitHub Actions. The contrast is the point — I'm demonstrating systems engineering, not another serverless AI project. **No AI in v1.**

I have **Superpowers**, **Context7**, and **frontend-design** plugins installed. Use them. Brainstorm before coding, plan before implementing, TDD during implementation, Context7 for library docs, frontend-design for UI work. Don't ask permission to use them — they're the workflow.

**Important workflow rule (same as Investor Thesis):** pause for my explicit approval before staging or committing any code. Every commit. No exceptions. See `CLAUDE.md` for details. This rule is especially important here because infrastructure mistakes compound — a bad firewall rule or Caddy config can take the server offline.

I've placed reference documents in `docs/` along with a root `CLAUDE.md`. **Before you write any code, read all of these in order:**

1. `CLAUDE.md` — conventions, anti-patterns, approval workflow, frontend quality bar.
2. `docs/PRD.md` — what we're building, who it's for, what's explicitly out of scope.
3. `docs/ARCHITECTURE.md` — system design. **Pay extra attention to the Integration Layer section** — it's the core abstraction of this project, the same way the agent loop was for Investor Thesis.
4. `docs/INFRASTRUCTURE.md` — VPS setup, deploy pipeline, networking, backups, runbook. **This is a first-class document on this project** — Beacon is as much about how it's deployed as what's deployed. Don't skim.
5. `docs/DATA_MODEL.md` — schema with rationale.
6. `docs/DESIGN.md` — dashboard density, status color discipline, motion conventions. Required reading before UI work.
7. `docs/phases/phase-1-foundation.md` — exactly what we're doing this phase.

After reading, before you touch any code, summarize back to me in 5-10 bullets:

- The one-line goal of the project.
- The locked-in tech stack.
- The Integration Layer abstraction in one sentence.
- The deploy story in one sentence (and why this differs from Wayfare/Investor Thesis).
- Three conventions from `CLAUDE.md` you'll be especially careful to follow.
- Two anti-patterns you'll specifically avoid.
- How the approval workflow changes how you work.
- The Phase 1 deliverables (high level).
- Any contradictions, ambiguities, or things you want me to clarify before starting.

Then wait for me to confirm before you start.

---

## Starting subsequent phases

For phase 2 and beyond, start a fresh session and say:

> We're starting Phase N. Read `CLAUDE.md`, then re-skim `docs/ARCHITECTURE.md` and `docs/INFRASTRUCTURE.md` for any changes since last session. Then read `docs/phases/phase-N-*.md` in full. Summarize the phase deliverables and flag anything ambiguous before starting.

This forces re-anchoring every session.

## Reference: Wayfare and Investor Thesis

When questions come up about "how did we handle X before?", references:
- Wayfare: https://github.com/thiluxan-s/TravelApp
- Investor Thesis: <link TBD>

Conventions, file structure, and workflow should feel like a coherent successor to those projects — unless this project's docs explicitly differ (which they do, deliberately, in several places — see "Tech stack" in `CLAUDE.md`).
