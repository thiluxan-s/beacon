import { Button } from "@/components/ui/button";

// Column definitions communicate what the table will look like once services exist.
// Honest empty state — no placeholder/fake data (CLAUDE.md anti-pattern).
const COLUMNS = [
  { label: "Service",    flex: "flex-1" },
  { label: "Status",     flex: "w-20" },
  { label: "Uptime",     flex: "w-16" },
  { label: "P50",        flex: "w-12" },
  { label: "Last check", flex: "w-28 text-right" },
] as const;

export default function ServicesPage() {
  return (
    <main className="flex flex-1 flex-col">
      {/*
       * Page header row — full width, tight vertical rhythm.
       * Small "0 endpoints" count communicates data-readiness at a glance.
       */}
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-sm font-semibold text-zinc-900">Services</h1>
          <span className="font-mono text-[10px] tabular-nums text-zinc-400">
            0 endpoints
          </span>
        </div>
        {/* Disabled until monitoring is wired up in a later phase */}
        <Button disabled size="sm">
          Add service
        </Button>
      </div>

      {/*
       * Column header row — mirrors what each data row will contain.
       * Uses mono, uppercase, letterspace to signal "this is a table".
       * Prevents the empty state from feeling formless.
       */}
      <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
        {COLUMNS.map(({ label, flex }) => (
          <span
            key={label}
            className={`font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 ${flex}`}
          >
            {label}
          </span>
        ))}
      </div>

      {/*
       * Empty state — centered in the remaining viewport space.
       * Deliberately minimal: two lines, no icon, no decorative card.
       * The column headers above already set context; the message only confirms emptiness.
       */}
      <div className="flex flex-1 items-center justify-center">
        <div className="py-16 text-center">
          <p className="text-[13px] font-medium text-zinc-700">
            No services yet
          </p>
          <p className="mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-zinc-400">
            Services you monitor will appear here with live status, uptime
            percentage, and response times.
          </p>
        </div>
      </div>
    </main>
  );
}
