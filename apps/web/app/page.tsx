import Link from "next/link";

// Ghost dashboard rows — decorative preview of the product in the right panel.
// Static markup, no real data. Communicates the product before the description is read.
const GHOST_SERVICES = [
  { name: "wayfare.app", status: "up", uptime: "99.98", latency: "142" },
  { name: "investor-thesis.io", status: "up", uptime: "99.91", latency: "208" },
  { name: "thiluxan.dev", status: "up", uptime: "100.00", latency: "89" },
  {
    name: "api.wayfare.app",
    status: "degraded",
    uptime: "98.73",
    latency: "1204",
  },
  { name: "db.internal", status: "up", uptime: "99.99", latency: "4" },
  {
    name: "smtp.mg.wayfare.app",
    status: "paused",
    uptime: "—",
    latency: "—",
  },
  { name: "cdn.thiluxan.dev", status: "up", uptime: "100.00", latency: "31" },
  {
    name: "api.investor-thesis.io",
    status: "up",
    uptime: "99.86",
    latency: "176",
  },
] as const;

// Maps status strings to CSS token references. Tokens are defined in
// globals.css @theme block; no hex values duplicated in JS.
const STATUS_TOKEN: Record<string, string> = {
  up: "var(--color-status-up)",
  degraded: "var(--color-status-degraded)",
  down: "var(--color-status-down)",
  paused: "var(--color-status-paused)",
};

export default function LandingPage() {
  return (
    <>
      {/*
       * Inline keyframes for the status-dot pulse. Using a style tag here
       * so it's scoped to this page and avoids a globals.css dependency for
       * a single animation. Server-rendered so no hydration cost.
       */}
      <style>{`
        @keyframes beacon-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .pulse-dot {
            animation: beacon-pulse 2.4s ease-in-out infinite;
          }
        }
        .bg-dot-grid {
          background-image: radial-gradient(circle, rgba(39,39,42,0.05) 1px, transparent 1px);
          background-size: 24px 24px;
        }
      `}</style>

      {/* Status strip — 4px bar at the top. Signals the product before any text. */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-[3px]" aria-hidden="true">
        <div className="flex-[3]" style={{ backgroundColor: 'var(--color-status-up)' }} />
        <div
          className="flex-[1]"
          style={{ backgroundColor: 'var(--color-status-degraded)' }}
        />
        <div
          className="flex-[0.5]"
          style={{ backgroundColor: 'var(--color-status-down)' }}
        />
        <div
          className="flex-[0.5]"
          style={{ backgroundColor: 'var(--color-status-paused)' }}
        />
      </div>

      <main className="relative min-h-screen overflow-hidden bg-dot-grid">
        <div className="relative z-10 flex min-h-screen">
          {/* ── Left column: primary content ───────────────────────────────── */}
          <div className="flex flex-col justify-center px-10 py-24 lg:w-[52%] lg:pl-20 lg:pr-16">
            {/* Eyebrow */}
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-400">
              Beacon / v0.1.0
            </p>

            {/* Headline */}
            <h1 className="mt-4 max-w-sm text-[2.25rem] font-semibold leading-[1.15] tracking-[-0.025em] text-zinc-900">
              Monitor anything you ship.
            </h1>

            {/* Description */}
            <p className="mt-5 max-w-[26rem] text-[0.9375rem] leading-relaxed text-zinc-500">
              A self-hosted, real-time monitoring dashboard for the services I
              run — uptime, response times, and deploy health in one place,
              regardless of where each service is hosted.
            </p>

            {/* Meta tags — small facts about the stack, mono, subdued */}
            <div className="mt-7 flex flex-wrap gap-x-4 gap-y-1.5">
              {["Node.js + Hono", "WebSockets", "DigitalOcean", "Caddy"].map(
                (tag) => (
                  <span
                    key={tag}
                    className="font-mono text-[10px] uppercase tracking-wide text-zinc-400"
                  >
                    {tag}
                  </span>
                )
              )}
            </div>

            {/* CTAs */}
            <div className="mt-10 flex items-center gap-4">
              <Link
                href="/sign-in"
                className="rounded-md bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
              >
                Sign in
              </Link>
              <Link
                href="/health"
                className="text-sm font-medium text-zinc-500 transition-colors duration-150 hover:text-zinc-900"
              >
                System status
                <span className="ml-1.5 inline-block text-zinc-300">→</span>
              </Link>
            </div>

            {/* Footer metadata */}
            <div className="mt-20 flex items-center gap-1.5">
              {/* Live status dot — pulses to suggest the product is running */}
              <span
                className="pulse-dot inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: 'var(--color-status-up)' }}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] text-zinc-400">
                Self-hosted · thiluxan.com
              </span>
            </div>
          </div>

          {/* ── Right column: ghost dashboard (decorative) ──────────────────── */}
          <div
            className="pointer-events-none absolute inset-y-0 right-0 hidden w-[52%] select-none overflow-hidden lg:block"
            aria-hidden="true"
          >
            {/* Fade mask — left edge blends into the left column */}
            <div className="absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-zinc-50 to-transparent" />
            {/* Fade mask — right edge */}
            <div className="absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-zinc-50 to-transparent" />
            {/* Fade mask — top & bottom */}
            <div className="absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-zinc-50 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-zinc-50 to-transparent" />

            {/* Ghost dashboard panel */}
            <div className="flex h-full items-center justify-center px-16">
              <div className="w-full max-w-sm opacity-[0.22]">
                {/* Panel header */}
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                    Services
                  </span>
                  <span className="font-mono text-[9px] text-zinc-400">
                    {GHOST_SERVICES.filter((s) => s.status === "up").length}/
                    {GHOST_SERVICES.length} up
                  </span>
                </div>

                {/* Service rows */}
                <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white/80">
                  {GHOST_SERVICES.map((service) => (
                    <div
                      key={service.name}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      {/* Status dot */}
                      <span
                        className={`h-1.5 w-1.5 flex-none rounded-full${service.status === "up" ? " pulse-dot" : ""}`}
                        style={{
                          backgroundColor: STATUS_TOKEN[service.status],
                        }}
                      />
                      {/* Service name */}
                      <span className="flex-1 truncate font-mono text-[10px] text-zinc-700">
                        {service.name}
                      </span>
                      {/* Uptime */}
                      <span className="tabular-nums font-mono text-[10px] text-zinc-400">
                        {service.uptime !== "—" ? `${service.uptime}%` : "—"}
                      </span>
                      {/* Latency */}
                      <span className="tabular-nums w-10 text-right font-mono text-[10px] text-zinc-400">
                        {service.latency !== "—"
                          ? `${service.latency}ms`
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Last checked line */}
                <div className="mt-2 text-right">
                  <span className="font-mono text-[9px] text-zinc-400">
                    checked 12s ago
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
