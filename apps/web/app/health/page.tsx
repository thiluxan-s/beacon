import Link from "next/link";

import { fetchServerHealth } from "@/lib/api-client";

// Force a fresh server fetch on every request — no stale cached health state.
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const health = await fetchServerHealth();

  const statusColor = health
    ? "var(--color-status-up)"
    : "var(--color-status-down)";
  const statusLabel = health ? "ok" : "unavailable";
  const isUp = health !== null;

  // Format the ISO timestamp from the server into HH:MM:SS UTC for display.
  const checkedAt = health
    ? new Date(health.time).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "UTC",
      }) + " UTC"
    : null;

  return (
    <>
      <style>{`
        @keyframes beacon-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .pulse-dot { animation: beacon-pulse 2.4s ease-in-out infinite; }
        }
      `}</style>

      {/*
       * Status strip — same 3px bar as the landing page, but single-colour here:
       * the whole bar reflects the current server state at a glance.
       */}
      <div
        className="fixed inset-x-0 top-0 z-50 h-[3px] transition-colors"
        style={{ backgroundColor: statusColor }}
        aria-hidden="true"
      />

      <main className="flex min-h-screen flex-col justify-center px-10 py-24 lg:pl-20">
        {/* Eyebrow — same mono label style as landing page */}
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-400">
          Beacon / System status
        </p>

        {/* Headline — weight contrast, concise */}
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900">
          {isUp ? "All systems operational" : "Service unavailable"}
        </h1>

        {/*
         * Status row — deliberately styled like a single row from the dashboard
         * ghost panel on the landing page: dot · service name · status label.
         * Uses border instead of shadow to stay flat and information-dense.
         */}
        <div className="mt-8 inline-flex w-fit items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
          <span
            className={`h-2 w-2 flex-none rounded-full${isUp ? " pulse-dot" : ""}`}
            style={{ backgroundColor: statusColor }}
            aria-hidden="true"
          />
          <span className="font-mono text-sm text-zinc-700">
            {health?.service ?? "beacon-server"}
          </span>
          <span
            className="ml-6 font-mono text-sm tabular-nums"
            style={{ color: statusColor }}
          >
            {statusLabel}
          </span>
        </div>

        {/* Checked-at timestamp — only shown when we have a real server time */}
        {checkedAt ? (
          <p className="mt-3 font-mono text-[10px] tabular-nums text-zinc-400">
            checked {checkedAt}
          </p>
        ) : (
          <p className="mt-3 font-mono text-[10px] text-zinc-400">
            could not reach the server
          </p>
        )}

        {/* Back link — same understated mono style as other nav links */}
        <div className="mt-12">
          <Link
            href="/"
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-400 transition-colors duration-150 hover:text-zinc-900"
          >
            ← Back
          </Link>
        </div>
      </main>
    </>
  );
}
