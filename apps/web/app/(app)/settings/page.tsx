import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchNotificationSettings, type NotificationSettingsDto } from '@/lib/notification-settings-api';
import { fetchServices, type ServiceDto } from '@/lib/services-api';
import { fetchDomains, type DomainDto } from '@/lib/domains-api';
import { AlertsSettingsForm } from '@/components/settings/alerts-settings-form';
import { ServiceAlertToggle } from '@/components/settings/service-alert-toggle';
import { ServicePublicToggle, DomainPublicToggle } from '@/components/settings/public-toggles';

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) notFound();

  let settings: NotificationSettingsDto | null = null;
  let services: ServiceDto[] = [];
  let domains: DomainDto[] = [];
  let loadError = false;

  try {
    [settings, services, domains] = await Promise.all([
      fetchNotificationSettings(user.id),
      fetchServices(user.id),
      fetchDomains(user.id),
    ]);
  } catch {
    loadError = true;
  }

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Page header ─── */}
      <div className="border-b border-zinc-200/60 px-5 py-3.5">
        <h1 className="text-sm font-semibold text-zinc-900">Settings</h1>
        <p className="mt-0.5 text-[12px] text-zinc-500">Email alerts for service incidents.</p>
      </div>

      {/* ─── Data unavailable banner — same resilience treatment as /services and /incidents ─── */}
      {loadError && (
        <div className="flex items-center gap-2 border-b border-zinc-200/40 bg-zinc-50/70 px-5 py-2.5">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
          <p className="font-mono text-[11px] text-zinc-500">
            Couldn&apos;t load settings — retrying
          </p>
        </div>
      )}

      {!loadError && settings && (
        <>
          <section className="border-b border-zinc-200/40">
            <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Email alerts</h2>
            <AlertsSettingsForm initial={settings} />
          </section>

          <section className="border-b border-zinc-200/40">
            <h2 className="px-5 pt-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Per-service</h2>
            {services.length === 0 ? (
              <p className="px-5 pb-4 text-[12px] text-zinc-400">No services yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-200/40">
                {services.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0 truncate text-[13px] font-medium text-zinc-900">{s.name}</span>
                    <ServiceAlertToggle service={s} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-1 flex-col">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4 pb-2">
              <h2 className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Public dashboard</h2>
              <Link href="/demo" className="text-[11px] text-zinc-500 hover:text-zinc-800 hover:underline">
                View public dashboard →
              </Link>
            </div>
            <p className="px-5 pb-2 max-w-md text-[12px] leading-relaxed text-zinc-400">
              Marked-public services and domains appear on the anonymous, read-only{' '}
              <code className="font-mono text-[11px] text-zinc-500">/demo</code> page. Everything else stays private.
            </p>

            <h3 className="px-5 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-300">Services</h3>
            {services.length === 0 ? (
              <p className="px-5 pb-3 text-[12px] text-zinc-400">No services yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-200/40">
                {services.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0 truncate text-[13px] font-medium text-zinc-900">{s.name}</span>
                    <ServicePublicToggle service={s} />
                  </li>
                ))}
              </ul>
            )}

            <h3 className="px-5 pt-3 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-300">Domains</h3>
            {domains.length === 0 ? (
              <p className="px-5 pb-4 text-[12px] text-zinc-400">No domains yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-200/40">
                {domains.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0 truncate font-mono text-[13px] text-zinc-900">{d.domain}</span>
                    <DomainPublicToggle domain={d} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
