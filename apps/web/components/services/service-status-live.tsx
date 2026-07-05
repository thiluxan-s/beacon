'use client';

import { useCallback, useState } from 'react';

import type { ServiceStatus, WsEvent } from '@beacon/shared';

import { STATUS_STYLE } from '@/lib/status-style';
import { useServiceStatusSubscription } from '@/lib/use-ws';

export function ServiceStatusLive({
  serviceId,
  initialStatus,
}: {
  serviceId: string;
  initialStatus: ServiceStatus;
}) {
  const [status, setStatus] = useState<ServiceStatus>(initialStatus);

  const onEvent = useCallback(
    (e: WsEvent) => {
      if (e.type === 'service.status_changed' && e.serviceId === serviceId) {
        setStatus(e.status);
      }
    },
    [serviceId],
  );

  useServiceStatusSubscription(`service:${serviceId}`, onEvent);

  const style = STATUS_STYLE[status] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300', pulse: false };

  return (
    <span className="inline-flex items-center gap-1.5">
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
      <span className={`text-[13px] font-semibold capitalize ${style.text}`}>{status}</span>
    </span>
  );
}
