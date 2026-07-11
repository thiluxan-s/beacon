'use client';

import { useCallback, useState } from 'react';

import type { WsEvent } from '@beacon/shared';

import type { PublicIncidentDto } from '@/lib/public-api';
import { relativeTime } from '@/lib/relative-time';
import { SEVERITY_STYLE, formatDuration } from '@/lib/incident-style';
import { useServiceStatusSubscriptions } from '@/lib/use-ws';

export function PublicIncidentsList({ initial }: { initial: PublicIncidentDto[] }) {
  const [incidents, setIncidents] = useState(initial);

  const onEvent = useCallback((e: WsEvent) => {
    // The initial fetch already covers open incidents; here we only resolve
    // existing rows live (no serviceName arrives on the WS event to prepend with).
    if (e.type !== 'incident.resolved') return;
    setIncidents((prev) =>
      prev.map((i) => (i.id === e.incidentId ? { ...i, resolvedAt: e.resolvedAt, durationSeconds: e.durationSeconds } : i)),
    );
  }, []);

  useServiceStatusSubscriptions(
    initial.map((i) => `service:${i.serviceId}`),
    onEvent,
  );

  if (incidents.length === 0) {
    return <p className="px-5 pb-4 text-[12px] text-zinc-400">No incidents recorded.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200/40">
      {incidents.map((i) => {
        const style = SEVERITY_STYLE[i.severity] ?? { text: 'text-status-down', dot: 'bg-status-down' };
        const ongoing = i.resolvedAt == null;
        const dotClass = ongoing ? style.dot : 'bg-zinc-300';
        return (
          <li key={i.id} className="flex items-center gap-4 px-5 py-3">
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
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-900">{i.serviceName}</span>
            <span className="hidden w-24 text-right font-mono text-[11px] tabular-nums text-zinc-500 sm:block">
              {formatDuration(i.durationSeconds)}
            </span>
            <span
              className="hidden w-28 text-right font-mono text-[11px] tabular-nums text-zinc-400 sm:block"
              suppressHydrationWarning
            >
              {relativeTime(i.startedAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
