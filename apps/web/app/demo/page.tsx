import Link from 'next/link';

import { fetchPublicServices, fetchPublicIncidents, fetchPublicDomains } from '@/lib/public-api';
import { PublicWsProvider } from '@/lib/use-ws';
import { ConnectionIndicator } from '@/components/services/connection-indicator';
import { PublicServicesList } from '@/components/public/public-services-list';
import { PublicIncidentsList } from '@/components/public/public-incidents-list';
import { PublicDomainsList } from '@/components/public/public-domains-list';

export const metadata = {
  title: 'Beacon — live status',
  description: 'Live, read-only status of the services and domains I run. Self-hosted, no login required.',
};

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
      <h2 className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-400">{label}</h2>
      <span className="font-mono text-[10px] tabular-nums text-zinc-300">{count}</span>
    </div>
  );
}

export default async function DemoPage() {
  const [services, incidents, domains] = await Promise.all([
    fetchPublicServices(),
    fetchPublicIncidents(),
    fetchPublicDomains(),
  ]);

  // `services === null` means the server answered 404 — public mode is off.
  if (services === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
        <div className="text-center">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-300 select-none">
            beacon
          </p>
          <p className="text-[13px] font-medium text-zinc-700">The public demo isn’t enabled right now.</p>
          <p className="mt-1.5 text-[12px] text-zinc-400">Check back shortly.</p>
        </div>
      </main>
    );
  }

  return (
    <PublicWsProvider>
      <main className="flex min-h-screen flex-col items-center bg-zinc-50 px-6 py-12 sm:py-16">
        <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-zinc-200/70 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04),0_8px_24px_-12px_rgba(24,24,27,0.12)]">
          {/* ─── Hero header ─── */}
          <header className="border-b border-zinc-200/60 px-5 py-5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                read-only · live
              </span>
              <ConnectionIndicator />
            </div>
            <h1 className="mt-2.5 text-lg font-semibold tracking-tight text-zinc-900">Beacon</h1>
            <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-zinc-500">
              Live status of the services and domains I run — self-hosted on my own VPS, streamed
              over WebSockets. No login required.
            </p>
          </header>

          {/* ─── Services ─── */}
          <section className="border-b border-zinc-200/40">
            <SectionHeading label="Services" count={services.length} />
            {services.length > 0 && (
              <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
                <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Service</span>
                <span className="w-24 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Status</span>
                <span className="hidden w-24 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 sm:block">Last check</span>
              </div>
            )}
            <PublicServicesList initial={services} />
          </section>

          {/* ─── Incidents ─── */}
          <section className="border-b border-zinc-200/40">
            <SectionHeading label="Incidents" count={incidents?.length ?? 0} />
            {(incidents?.length ?? 0) > 0 && (
              <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
                <span className="w-24 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Status</span>
                <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Service</span>
                <span className="hidden w-24 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 sm:block">Duration</span>
                <span className="hidden w-28 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 sm:block">Started</span>
              </div>
            )}
            <PublicIncidentsList initial={incidents ?? []} />
          </section>

          {/* ─── Domains ─── */}
          <section>
            <SectionHeading label="Domains" count={domains?.length ?? 0} />
            {(domains?.length ?? 0) > 0 && (
              <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
                <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Domain</span>
                <span className="w-28 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Status</span>
                <span className="hidden w-20 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 sm:block">SSL</span>
                <span className="hidden w-20 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400 sm:block">Registration</span>
              </div>
            )}
            <PublicDomainsList initial={domains ?? []} />
          </section>
        </div>

        {/* ─── Footer ─── */}
        <p className="mt-5 max-w-2xl text-center font-mono text-[10px] leading-relaxed text-zinc-400">
          This is the real production dashboard, not a sandbox.{' '}
          <Link href="/" className="text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700">
            About Beacon
          </Link>
        </p>
      </main>
    </PublicWsProvider>
  );
}
