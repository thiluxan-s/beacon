'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@clerk/nextjs';

import type { WsEvent } from '@beacon/shared';

import { clientEnv } from '@/lib/env.client';
import { BeaconSocket, type ConnectionState } from '@/lib/ws-client';

const Ctx = createContext<BeaconSocket | null>(null);

export function WsProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  const socket = useMemo(
    () => new BeaconSocket({ url: clientEnv.NEXT_PUBLIC_WS_URL, getToken: () => getToken() }),
    [getToken],
  );
  useEffect(() => {
    void socket.connect();
    // BeaconSocket has no public disconnect in v1; one socket per app session is intended.
  }, [socket]);
  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

export function useWsConnectionState(): ConnectionState {
  const socket = useContext(Ctx);
  const [state, setState] = useState<ConnectionState>(socket?.state ?? 'disconnected');
  useEffect(() => socket?.onStateChange(setState), [socket]);
  return state;
}

export function useServiceStatusSubscription(topic: string, handler: (e: WsEvent) => void) {
  const socket = useContext(Ctx);
  useEffect(() => socket?.subscribe(topic, handler), [socket, topic, handler]);
}

// Anonymous read-only lane for /demo — no token, connects with ?public=1.
export function PublicWsProvider({ children }: { children: React.ReactNode }) {
  const socket = useMemo(() => new BeaconSocket({ url: clientEnv.NEXT_PUBLIC_WS_URL, public: true }), []);
  useEffect(() => {
    void socket.connect();
  }, [socket]);
  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

// Subscribe to many topics in one effect (lint-safe: one hook call, not a loop of
// hooks). A single component needs to subscribe to every public service's topic.
export function useServiceStatusSubscriptions(topics: string[], handler: (e: WsEvent) => void) {
  const socket = useContext(Ctx);
  const key = topics.join('|');
  useEffect(() => {
    if (!socket) return;
    const unsubs = topics.map((t) => socket.subscribe(t, handler));
    return () => {
      for (const u of unsubs) u();
    };
    // `topics` is derived from `key`; `handler` is memoized by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, key, handler]);
}
