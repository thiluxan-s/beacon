import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchDomains, type DomainDto } from '@/lib/domains-api';
import { DOMAIN_STATUS_STYLE, formatDaysUntil } from '@/lib/domain-status-style';
import { relativeTime } from '@/lib/relative-time';
import { DomainFormDialog } from '@/components/domains/domain-form-dialog';
import { DomainRowActions } from '@/components/domains/domain-row-actions';

const ISSUE_STATUSES = new Set(['warning', 'expiring_soon', 'expired', 'unhealthy']);

// Pill order mirrors ServicesLiveList: the positive state first, then severity
// descending, neutral ("pending") last.
const STATUS_ORDER = ['healthy', 'expired', 'unhealthy', 'expiring_soon', 'warning', 'pending'] as const;

function domainStatusCounts(domains: DomainDto[]): Record<string, number> {
  return domains.reduce<Record<string, number>>((acc, d) => {
    acc[d.currentStatus] = (acc[d.currentStatus] ?? 0) + 1;
    return acc;
  }, {});
}

export default async function DomainsPage() {
  const user = await currentUser();
  if (!user) notFound();

  let domains: DomainDto[] = [];
  let loadError = false;

  try {
    domains = await fetchDomains(user.id);
  } catch (err) {
    console.error('[beacon-web] domains page load failed', err);
    loadError = true;
  }

  const issues = domains.filter((d) => ISSUE_STATUSES.has(d.currentStatus)).length;
  const counts = domainStatusCounts(domains);

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Page header ─── */}
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-sm font-semibold text-zinc-900">Domains</h1>
          {!loadError && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-400">
              {domains.length} domain{domains.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <DomainFormDialog />
      </div>

      {/* ─── Data unavailable banner ─── */}
      {loadError && (
        <div className="flex items-center gap-2 border-b border-zinc-200/40 bg-zinc-50/70 px-5 py-2.5">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
          <p className="font-mono text-[11px] text-zinc-500">
            Couldn&apos;t load domains — retrying
          </p>
        </div>
      )}

      {/* ─── Empty state ─── */}
      {!loadError && domains.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <div className="py-16 text-center">
            <p className="mb-4 font-mono text-[10px] tracking-[0.15em] text-zinc-300 select-none uppercase">
              no domains tracked
            </p>
            <p className="text-[13px] font-medium text-zinc-700">No domains yet</p>
            <p className="mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-zinc-400">
              Add a domain and Beacon will start watching its DNS, SSL, and registration
              within a minute.
            </p>
          </div>
        </div>
      )}

      {/* ─── Summary strip + column header + rows ─── */}
      {!loadError && domains.length > 0 && (
        <>
          <div
            className={[
              'flex items-center gap-5 border-b px-5 py-2 transition-colors',
              issues > 0 ? 'border-red-100/80 bg-red-50/40' : 'border-zinc-200/40 bg-zinc-50/50',
            ].join(' ')}
          >
            {STATUS_ORDER.map((status) => {
              const count = counts[status] ?? 0;
              if (count === 0) return null;
              const style = DOMAIN_STATUS_STYLE[status] ?? { dot: 'bg-zinc-300' };
              return (
                <StatusPill
                  key={status}
                  count={count}
                  label={status.replace('_', ' ')}
                  dotClass={style.dot}
                />
              );
            })}

            {issues > 0 ? (
              <span className="ml-auto font-mono text-[11px] font-medium text-status-down">
                {issues} need{issues === 1 ? 's' : ''} attention
              </span>
            ) : (
              <span className="ml-auto font-mono text-[11px] text-status-up/70">
                all domains healthy
              </span>
            )}
          </div>

          <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
            <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              Domain
            </span>
            <span className="w-32 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              Status
            </span>
            <span className="w-16 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              SSL
            </span>
            <span className="w-20 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              Registration
            </span>
            <span className="w-24 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
              Checked
            </span>
            {/* Spacer for row actions column — keeps header aligned */}
            <div className="w-[132px]" />
          </div>

          <ul className="divide-y divide-zinc-200/40">
            {domains.map((d) => {
              const style = DOMAIN_STATUS_STYLE[d.currentStatus] ?? {
                text: 'text-zinc-500',
                dot: 'bg-zinc-300',
                pulse: false,
              };
              return (
                <li
                  key={d.id}
                  className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-zinc-50/70"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-900">
                    {d.domain}
                  </span>

                  <div className="flex w-32 items-center gap-1.5">
                    <span
                      className={[
                        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                        style.dot,
                        style.pulse ? 'animate-pulse' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                    />
                    <span className={`text-[12px] font-medium capitalize ${style.text}`}>
                      {d.currentStatus.replace('_', ' ')}
                    </span>
                  </div>

                  <span className="w-16 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                    {formatDaysUntil(d.sslExpiresAt)}
                  </span>
                  <span className="w-20 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                    {formatDaysUntil(d.domainExpiresAt)}
                  </span>
                  <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-400">
                    {relativeTime(d.lastCheckAt)}
                  </span>

                  {/* Row actions — revealed on hover (Linear/Vercel pattern) */}
                  <div className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                    <DomainRowActions id={d.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}

function StatusPill({ count, label, dotClass }: { count: number; label: string; dotClass: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="font-mono text-[11px] tabular-nums text-zinc-500">
        {count} {label}
      </span>
    </span>
  );
}
