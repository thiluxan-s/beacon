'use client';

import { useWsConnectionState } from '@/lib/use-ws';

const DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  disconnected: 'bg-zinc-400',
};

export function ConnectionIndicator() {
  const state = useWsConnectionState();
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500"
      title={`Realtime: ${state}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[state] ?? 'bg-zinc-400'}`} />
      {state}
    </span>
  );
}
