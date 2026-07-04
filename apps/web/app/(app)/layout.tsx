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
       * App chrome — sticky header, 44px tall.
       * "beacon" wordmark: same mono eyebrow treatment as landing + health pages.
       * No heavy border — a hairline rule at 60% opacity preserves air.
       *
       * WsProvider wraps the header + content so both the realtime connection
       * indicator and page children share one BeaconSocket context.
       */}
      <WsProvider>
        <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center justify-between border-b border-zinc-200/60 bg-zinc-50/95 px-5 backdrop-blur-md">
          <span className="select-none font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-800">
            beacon
          </span>
          <div className="flex items-center gap-3">
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
