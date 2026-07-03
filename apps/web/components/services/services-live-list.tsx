'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

import type { WsEvent } from '@beacon/shared';

import type { ServiceDto } from '@/lib/services-api';
import { ServiceRowActions } from '@/components/services/service-row-actions';
import { useServiceStatusSubscription } from '@/lib/use-ws';

// Use the project's custom --color-status-* tokens from globals.css @theme
const STATUS_STYLE: Record<string, { text: string; dot: string; pulse: boolean }> = {
  up:       { text: 'text-status-up',      dot: 'bg-status-up',      pulse: true  },
  down:     { text: 'text-status-down',    dot: 'bg-status-down',    pulse: false },
  degraded: { text: 'text-status-degraded',dot: 'bg-status-degraded',pulse: false },
  paused:   { text: 'text-status-paused',  dot: 'bg-status-paused',  pulse: false },
  pending:  { text: 'text-zinc-400',       dot: 'bg-zinc-300',       pulse: false },
};

function lastChecked(s: ServiceDto): string {
  if (!s.lastCheckAt) return '—';
  const secs = Math.round((Date.now() - new Date(s.lastCheckAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function statusCounts(services: ServiceDto[]) {
  return services.reduce(
    (acc, s) => {
      if (s.paused) acc.paused++;
      else if (s.currentStatus === 'up') acc.up++;
      else if (s.currentStatus === 'down') acc.down++;
      else if (s.currentStatus === 'degraded') acc.degraded++;
      return acc;
    },
    { up: 0, down: 0, degraded: 0, paused: 0 },
  );
}

export function ServicesLiveList({ initial }: { initial: ServiceDto[] }) {
  const [services, setServices] = useState(initial);

  const onEvent = useCallback((e: WsEvent) => {
    if (e.type !== 'service.status_changed') return;
    setServices((prev) =>
      prev.map((s) => (s.id === e.serviceId ? { ...s, currentStatus: e.status } : s)),
    );
  }, []);

  useServiceStatusSubscription('global', onEvent);

  const counts = statusCounts(services);
  const hasIssues = counts.down > 0 || counts.degraded > 0;
  const issueCount = counts.down + counts.degraded;

  return (
    <>
      {/* ─── Status summary strip ─── */}
      <div
        className={[
          'flex items-center gap-5 border-b px-5 py-2 transition-colors',
          hasIssues
            ? 'border-red-100/80 bg-red-50/40'
            : 'border-zinc-200/40 bg-zinc-50/50',
        ].join(' ')}
      >
        {counts.up > 0 && (
          <StatusPill count={counts.up} label="up" dotClass="bg-status-up" />
        )}
        {counts.down > 0 && (
          <StatusPill count={counts.down} label="down" dotClass="bg-status-down" />
        )}
        {counts.degraded > 0 && (
          <StatusPill count={counts.degraded} label="degraded" dotClass="bg-status-degraded" />
        )}
        {counts.paused > 0 && (
          <StatusPill count={counts.paused} label="paused" dotClass="bg-status-paused" />
        )}

        {/* Health verdict — right-aligned */}
        {hasIssues ? (
          <span className="ml-auto font-mono text-[11px] font-medium text-status-down">
            {issueCount} issue{issueCount !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="ml-auto font-mono text-[11px] text-status-up/70">
            all systems operational
          </span>
        )}
      </div>

      {/* ─── Column header row ─── */}
      <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
        <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Service
        </span>
        <span className="w-24 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Status
        </span>
        <span className="w-28 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Last check
        </span>
        {/* Spacer for row actions column — keeps header aligned */}
        <div className="w-[152px]" />
      </div>

      {/* ─── Service rows ─── */}
      <ul className="divide-y divide-zinc-200/40">
        {services.map((s) => {
          const style = STATUS_STYLE[s.currentStatus] ?? {
            text: 'text-zinc-500',
            dot: 'bg-zinc-300',
            pulse: false,
          };
          return (
            <li
              key={s.id}
              className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-zinc-50/70"
            >
              {/* Service name + URL */}
              <div className="min-w-0 flex-1">
                <Link
                  href={`/services/${s.id}`}
                  className="block truncate text-[13px] font-medium text-zinc-900 hover:underline"
                >
                  {s.name}
                </Link>
                <p className="truncate font-mono text-[11px] text-zinc-400">
                  {s.baseUrl}
                  {s.healthCheckPath === '/' ? '' : s.healthCheckPath}
                </p>
              </div>

              {/* Status badge — dot + label */}
              <div className="flex w-24 items-center gap-1.5">
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
                  {s.currentStatus}
                </span>
              </div>

              {/* Last check time */}
              <span
                className="w-28 text-right font-mono text-[11px] tabular-nums text-zinc-400"
                suppressHydrationWarning
              >
                {lastChecked(s)}
              </span>

              {/* Row actions — revealed on hover (Linear/Vercel pattern) */}
              <div className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                <ServiceRowActions service={s} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function StatusPill({
  count,
  label,
  dotClass,
}: {
  count: number;
  label: string;
  dotClass: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="font-mono text-[11px] tabular-nums text-zinc-500">
        {count} {label}
      </span>
    </span>
  );
}
