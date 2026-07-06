'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { WsEvent } from '@beacon/shared';

import { formatDuration } from '@/lib/incident-style';
import { useServiceStatusSubscription } from '@/lib/use-ws';

export function IncidentLiveHeader({
  incidentId,
  serviceId,
  startedAt,
  resolvedAt: initialResolvedAt,
  durationSeconds: initialDuration,
}: {
  incidentId: string;
  serviceId: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
}) {
  const router = useRouter();
  const [resolvedAt, setResolvedAt] = useState(initialResolvedAt);
  const [duration, setDuration] = useState(initialDuration);
  const [liveSeconds, setLiveSeconds] = useState(() =>
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
  );

  // Tick the live duration once a second while the incident is ongoing. Cleared
  // on unmount and re-evaluated (and stopped) the moment resolvedAt flips.
  useEffect(() => {
    if (resolvedAt) return;
    const t = setInterval(
      () => setLiveSeconds(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [resolvedAt, startedAt]);

  const onEvent = useCallback(
    (e: WsEvent) => {
      if (e.type === 'incident.resolved' && e.incidentId === incidentId) {
        setResolvedAt(e.resolvedAt);
        setDuration(e.durationSeconds);
        router.refresh(); // pull any interim `observed` events into the timeline
      }
    },
    [incidentId, router],
  );

  useServiceStatusSubscription(`service:${serviceId}`, onEvent);

  const ongoing = resolvedAt == null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={[
          'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
          ongoing ? 'bg-status-down' : 'bg-status-up',
          ongoing ? 'animate-pulse' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      />
      <span
        className={`text-[13px] font-semibold ${ongoing ? 'text-status-down' : 'text-status-up'}`}
      >
        {ongoing ? `ongoing · ${formatDuration(liveSeconds)}` : `resolved · ${formatDuration(duration)}`}
      </span>
    </span>
  );
}
