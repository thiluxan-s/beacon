// Task 9 adds ensureUserExists() at the top of this component to upsert the
// Clerk user into the local Postgres users table on first sign-in.

import { UserButton } from "@clerk/nextjs";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      {/*
       * App chrome — sticky header, 44px tall.
       * "beacon" wordmark: same mono eyebrow treatment as landing + health pages.
       * No heavy border — a hairline rule at 60% opacity preserves air.
       */}
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center justify-between border-b border-zinc-200/60 bg-zinc-50/95 px-5 backdrop-blur-md">
        <span className="select-none font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-800">
          beacon
        </span>
        {/* UserButton — Clerk pre-built component, hydrates client-side */}
        <UserButton />
      </header>

      {/* Page content fills remaining viewport height */}
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
