import Link from "next/link";

import { UserButton } from "@clerk/nextjs";
import { ensureUserExists } from "@/lib/ensure-user-exists";
import { WsProvider } from "@/lib/use-ws";
import { ConnectionIndicator } from "@/components/services/connection-indicator";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await ensureUserExists();
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      {/*
       * App chrome — sticky header, 44px tall at `sm` and up.
       * "beacon" wordmark: same mono eyebrow treatment as landing + health pages.
       * No heavy border — a hairline rule at 60% opacity preserves air.
       *
       * Below `sm`, the nav wraps onto its own full-width scrollable row
       * beneath the top bar (order-3 on mobile, order-2 inline at `sm`) so
       * the wordmark + connection indicator + user button always stay on
       * one row and nothing overflows at narrow widths.
       *
       * WsProvider wraps the header + content so both the realtime connection
       * indicator and page children share one BeaconSocket context.
       */}
      <WsProvider>
        <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center border-b border-zinc-200/60 bg-zinc-50/95 backdrop-blur-md sm:h-11 sm:flex-nowrap">
          <span className="order-1 flex h-11 shrink-0 select-none items-center pl-5 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-800">
            beacon
          </span>
          {/* Nav cluster — mono, uppercase, same eyebrow treatment as the wordmark
              but lighter weight so the wordmark stays the visual anchor. Full-width
              scrollable row on mobile; inline next to the wordmark at `sm` and up. */}
          <nav className="order-3 flex w-full items-center gap-4 overflow-x-auto border-t border-zinc-200/60 px-5 py-2 sm:order-2 sm:ml-6 sm:w-auto sm:border-t-0 sm:px-0 sm:py-0">
            <Link
              href="/services"
              className="flex min-h-11 items-center font-mono text-[11px] uppercase tracking-[0.1em] text-zinc-500 transition-colors hover:text-zinc-800 sm:min-h-0"
            >
              Services
            </Link>
            <Link
              href="/incidents"
              className="flex min-h-11 items-center font-mono text-[11px] uppercase tracking-[0.1em] text-zinc-500 transition-colors hover:text-zinc-800 sm:min-h-0"
            >
              Incidents
            </Link>
            <Link
              href="/domains"
              className="flex min-h-11 items-center font-mono text-[11px] uppercase tracking-[0.1em] text-zinc-500 transition-colors hover:text-zinc-800 sm:min-h-0"
            >
              Domains
            </Link>
            <Link
              href="/settings"
              className="flex min-h-11 items-center font-mono text-[11px] uppercase tracking-[0.1em] text-zinc-500 transition-colors hover:text-zinc-800 sm:min-h-0"
            >
              Settings
            </Link>
          </nav>
          <div className="order-2 ml-auto flex h-11 shrink-0 items-center gap-3 pr-5 sm:order-3">
            {/* Subtle realtime status — dot + lowercase label, right-aligned */}
            <ConnectionIndicator />
            {/* UserButton — Clerk pre-built component, hydrates client-side */}
            <UserButton />
          </div>
        </header>

        {/* Page content fills remaining viewport height */}
        <div className="flex flex-1 flex-col">{children}</div>
      </WsProvider>
    </div>
  );
}
