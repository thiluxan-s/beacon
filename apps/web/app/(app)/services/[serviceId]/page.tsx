import Link from 'next/link';

import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchIntegrations, fetchService, fetchServiceChecks } from '@/lib/services-api';
import { ServiceStatusLive } from '@/components/services/service-status-live';
import { IntegrationAttachDialog } from '@/components/services/integration-attach-dialog';
import { VercelIntegrationCard } from '@/components/services/vercel-integration-card';
import { GithubIntegrationCard } from '@/components/services/github-integration-card';
import { removeIntegrationAction } from '@/app/(app)/services/actions';

// Check-status → project --color-status-* tokens (globals.css @theme)
const CHECK_STYLE: Record<string, { text: string; dot: string }> = {
  success: { text: 'text-status-up',       dot: 'bg-status-up' },
  failure: { text: 'text-status-down',     dot: 'bg-status-down' },
  timeout: { text: 'text-status-degraded', dot: 'bg-status-degraded' },
  error:   { text: 'text-status-down',     dot: 'bg-status-down' },
};

// Relative time — matches the dashboard's Xs/Xm/Xh ago style. Computed once on
// the server (this is a Server Component), so no hydration guard is required.
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ serviceId: string }>;
}) {
  const { serviceId } = await params;

  const user = await currentUser();
  if (!user) notFound();

  const service = await fetchService(user.id, serviceId);
  if (!service) notFound();

  const checks = await fetchServiceChecks(user.id, serviceId, 50);
  const integrations = await fetchIntegrations(user.id, serviceId);

  const endpoint = `${service.baseUrl}${service.healthCheckPath === '/' ? '' : service.healthCheckPath}`;

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Back link ─── */}
      <div className="px-5 pt-4">
        <Link
          href="/services"
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400 transition-colors hover:text-zinc-600"
        >
          ← services
        </Link>
      </div>

      {/* ─── Header block ─── */}
      <div className="flex items-start justify-between gap-6 border-b border-zinc-200/60 px-5 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-zinc-900">{service.name}</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{endpoint}</p>
          {service.description && (
            <p className="mt-1.5 max-w-[52ch] text-[12px] leading-relaxed text-zinc-500">
              {service.description}
            </p>
          )}
        </div>
        <div className="shrink-0 pt-0.5">
          <ServiceStatusLive serviceId={service.id} initialStatus={service.currentStatus} />
        </div>
      </div>

      {/* ─── Meta strip ─── */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-b border-zinc-200/40 bg-zinc-50/50 px-5 py-3">
        <MetaItem label="Interval" value={`${service.checkIntervalSeconds}s`} />
        <MetaItem label="Timeout" value={`${service.timeoutSeconds}s`} />
        <MetaItem
          label="Expected"
          value={service.expectedStatusCodes.length ? service.expectedStatusCodes.join(', ') : '—'}
        />
        <MetaItem label="Last check" value={relativeTime(service.lastCheckAt)} />
        <MetaItem label="Next check" value={relativeTime(service.nextCheckAt)} />
      </div>

      {/* ─── Integrations ─── */}
      <section className="border-b border-zinc-200/40">
        <div className="flex items-center justify-between gap-2.5 px-5 pt-4 pb-2">
          <div className="flex items-baseline gap-2.5">
            <h2 className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              Integrations
            </h2>
            {integrations.length > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-zinc-300">
                {integrations.length}
              </span>
            )}
          </div>
          <IntegrationAttachDialog serviceId={service.id} />
        </div>

        {integrations.length === 0 ? (
          <p className="px-5 pb-4 text-[12px] text-zinc-400">
            No integrations attached yet.
          </p>
        ) : (
          <div className="space-y-3 px-5 pb-4">
            {integrations.map((integration) => {
              const card =
                integration.integrationId === 'vercel' ? (
                  <VercelIntegrationCard integration={integration} />
                ) : integration.integrationId === 'github' ? (
                  <GithubIntegrationCard integration={integration} />
                ) : null;
              if (!card) return null;
              return (
                <div key={integration.integrationId}>
                  <div className="flex items-center justify-end pb-1">
                    <form action={removeVercelIntegration.bind(null, service.id, integration.integrationId)}>
                      <button
                        type="submit"
                        className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400 transition-colors hover:text-status-down"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                  {card}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Recent checks ─── */}
      <section className="flex flex-1 flex-col">
        <div className="flex items-baseline gap-2.5 px-5 pt-4 pb-2">
          <h2 className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
            Recent checks
          </h2>
          {checks.length > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-300">
              {checks.length}
            </span>
          )}
        </div>

        {checks.length === 0 ? (
          <p className="px-5 py-4 text-[12px] text-zinc-400">
            No checks yet — the worker will run one within a few seconds.
          </p>
        ) : (
          <>
            {/* Column header row */}
            <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
              <span className="w-24 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                Result
              </span>
              <span className="w-12 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                Code
              </span>
              <span className="w-16 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                Time
              </span>
              <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                Detail
              </span>
              <span className="w-20 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                Checked
              </span>
            </div>

            <ul className="divide-y divide-zinc-200/40">
              {checks.map((c) => {
                const style = CHECK_STYLE[c.status] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300' };
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-zinc-50/70"
                  >
                    {/* Result — dot + label */}
                    <div className="flex w-24 items-center gap-1.5">
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
                        aria-hidden="true"
                      />
                      <span className={`text-[12px] font-medium capitalize ${style.text}`}>
                        {c.status}
                      </span>
                    </div>

                    {/* Status code */}
                    <span className="w-12 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {c.statusCode ?? '—'}
                    </span>

                    {/* Response time */}
                    <span className="w-16 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {c.responseTimeMs != null ? `${c.responseTimeMs}ms` : '—'}
                    </span>

                    {/* Error message / detail */}
                    <span className="flex-1 truncate text-[11px] text-zinc-400">
                      {c.errorMessage ?? ''}
                    </span>

                    {/* Checked-at — relative */}
                    <span className="w-20 text-right font-mono text-[11px] tabular-nums text-zinc-400">
                      {relativeTime(c.checkedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

// Thin wrapper so the form action satisfies Next's `(formData) => void | Promise<void>`
// signature — removeIntegrationAction itself returns a Result the caller can inspect,
// but this control has no client-side state to surface an error into (4b design pass).
async function removeVercelIntegration(serviceId: string, integrationId: string): Promise<void> {
  'use server';
  await removeIntegrationAction(serviceId, integrationId);
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-zinc-600">{value}</span>
    </div>
  );
}
