'use client';

import { useCallback, useState } from 'react';

import type { WsEvent } from '@beacon/shared';

import type { PublicServiceDto } from '@/lib/public-api';
import { STATUS_STYLE } from '@/lib/status-style';
import { relativeTime } from '@/lib/relative-time';
import { useServiceStatusSubscriptions } from '@/lib/use-ws';

export function PublicServicesList({ initial }: { initial: PublicServiceDto[] }) {
  const [services, setServices] = useState(initial);

  const onEvent = useCallback((e: WsEvent) => {
    if (e.type !== 'service.status_changed') return;
    setServices((prev) => prev.map((s) => (s.id === e.serviceId ? { ...s, currentStatus: e.status } : s)));
  }, []);

  // One hook call subscribing to every public service's topic (fixed for the
  // component's life — `initial` never changes on a read-only public page).
  useServiceStatusSubscriptions(
    initial.map((s) => `service:${s.id}`),
    onEvent,
  );

  if (services.length === 0) {
    return <p className="px-5 pb-4 text-[12px] text-zinc-400">No public services.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200/40">
      {services.map((s) => {
        const style = STATUS_STYLE[s.currentStatus] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300', pulse: false };
        return (
          <li key={s.id} className="flex items-center gap-4 px-5 py-3">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-900">{s.name}</span>
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
              <span className={`text-[12px] font-medium capitalize ${style.text}`}>{s.currentStatus}</span>
            </div>
            <span
              className="w-24 text-right font-mono text-[11px] tabular-nums text-zinc-400"
              suppressHydrationWarning
            >
              {relativeTime(s.lastCheckAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
