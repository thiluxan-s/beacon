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
