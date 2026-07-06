'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

import type { WsEvent } from '@beacon/shared';

import type { IncidentDto } from '@/lib/incidents-api';
import { relativeTime } from '@/lib/relative-time';
import { SEVERITY_STYLE, formatDuration } from '@/lib/incident-style';
import { useServiceStatusSubscription } from '@/lib/use-ws';

function incidentCounts(incidents: IncidentDto[]) {
  return incidents.reduce(
    (acc, i) => {
      if (i.resolvedAt == null) acc.ongoing++;
      else acc.resolved++;
      return acc;
    },
    { ongoing: 0, resolved: 0 },
  );
}

export function IncidentsLiveList({ initial }: { initial: IncidentDto[] }) {
  const [incidents, setIncidents] = useState(initial);

  // Adopt server-driven membership changes (same rationale as ServicesLiveList:
  // a fresh server read from revalidation is authoritative and never behind a
  // live WS event, since pg_notify fires inside the same txn as the write).
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setIncidents(initial);
  }

  const onEvent = useCallback((e: WsEvent) => {
    if (e.type === 'incident.opened') {
      setIncidents((prev) =>
        prev.some((i) => i.id === e.incidentId)
          ? prev
          : [
              {
                id: e.incidentId,
                serviceId: e.serviceId,
                // No serviceName on the WS event — placeholder until the next
                // server revalidation fills it in via the adoption trick above.
                serviceName: '…',
                severity: 'down',
                startedAt: e.startedAt,
                resolvedAt: null,
                durationSeconds: null,
              },
              ...prev,
            ],
      );
    } else if (e.type === 'incident.resolved') {
      setIncidents((prev) =>
        prev.map((i) =>
          i.id === e.incidentId
            ? { ...i, resolvedAt: e.resolvedAt, durationSeconds: e.durationSeconds }
            : i,
        ),
      );
    }
  }, []);

  useServiceStatusSubscription('global', onEvent);

  if (incidents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="py-16 text-center">
          <p className="mb-4 font-mono text-[10px] tracking-[0.15em] text-zinc-300 select-none uppercase">
            no incidents recorded
          </p>
          <p className="text-[13px] font-medium text-zinc-700">All clear</p>
          <p className="mt-1.5 max-w-[280px] text-[12px] leading-relaxed text-zinc-400">
            When a service fails two checks in a row, an incident opens here
            automatically.
          </p>
        </div>
      </div>
    );
  }

  const counts = incidentCounts(incidents);
  const hasOngoing = counts.ongoing > 0;

  return (
    <>
      {/* ─── Summary strip ─── */}
      <div
        className={[
          'flex items-center gap-5 border-b px-5 py-2 transition-colors',
          hasOngoing ? 'border-red-100/80 bg-red-50/40' : 'border-zinc-200/40 bg-zinc-50/50',
        ].join(' ')}
      >
        {hasOngoing && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-down"
              aria-hidden="true"
            />
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {counts.ongoing} ongoing
            </span>
          </span>
        )}
        {counts.resolved > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-300" aria-hidden="true" />
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {counts.resolved} resolved
            </span>
          </span>
        )}

        {hasOngoing ? (
          <span className="ml-auto font-mono text-[11px] font-medium text-status-down">
            {counts.ongoing} active incident{counts.ongoing !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="ml-auto font-mono text-[11px] text-status-up/70">
            no active incidents
          </span>
        )}
      </div>

      {/* ─── Column header row ─── */}
      <div className="flex items-center gap-4 border-b border-zinc-200/40 px-5 py-2">
        <span className="w-24 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Status
        </span>
        <span className="flex-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Service
        </span>
        <span className="w-24 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Duration
        </span>
        <span className="w-28 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Started
        </span>
      </div>

      {/* ─── Incident rows ─── */}
      <ul className="divide-y divide-zinc-200/40">
        {incidents.map((i) => {
          const style = SEVERITY_STYLE[i.severity] ?? { text: 'text-status-down', dot: 'bg-status-down' };
          const ongoing = i.resolvedAt == null;
          // Ongoing keeps the red severity dot (+ pulse); resolved rows use the same
          // neutral gray as the summary strip's "N resolved" dot, so a closed incident
          // never reads as an active failure to someone skimming the list.
          const dotClass = ongoing ? style.dot : 'bg-zinc-300';
          return (
            <li
              key={i.id}
              className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-zinc-50/70"
            >
              {/* Status — dot + label */}
              <div className="flex w-24 items-center gap-1.5">
                <span
                  className={[
                    'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                    dotClass,
                    ongoing ? 'animate-pulse' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden="true"
                />
                <span className={`text-[12px] font-medium ${ongoing ? style.text : 'text-zinc-400'}`}>
                  {ongoing ? 'ongoing' : 'resolved'}
                </span>
              </div>

              {/* Service name */}
              <div className="min-w-0 flex-1">
                <Link
                  href={`/incidents/${i.id}`}
                  className="block truncate text-[13px] font-medium text-zinc-900 hover:underline"
                >
                  {i.serviceName}
                </Link>
              </div>

              {/* Duration */}
              <span className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-500">
                {formatDuration(i.durationSeconds)}
              </span>

              {/* Started — relative */}
              <span
                className="w-28 text-right font-mono text-[11px] tabular-nums text-zinc-400"
                suppressHydrationWarning
              >
                {relativeTime(i.startedAt)}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
