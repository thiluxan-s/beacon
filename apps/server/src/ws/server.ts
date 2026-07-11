import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsClientMessageSchema } from '@beacon/shared';
import { authenticateConnection } from './auth';
import { isServicePublic } from '../db/repositories/services';
import type { ConnectionHub } from './connections';

// Ceiling on concurrent anonymous (public) WS connections. The public lane is
// unauthenticated, so without a cap it could be opened without bound and exhaust
// the small VPS. Authenticated (owner) connections are not capped.
const DEFAULT_MAX_PUBLIC_CONNECTIONS = 100;

type Deps = {
  authenticate?: (token: string | undefined, opts: { public: boolean }) => Promise<{ userId: string; public: boolean } | null>;
  canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
  isServicePublic?: (serviceId: string) => Promise<boolean>;
  heartbeatMs?: number;
  maxPublicConnections?: number;
};

export function attachWebSocketServer(httpServer: Server, hub: ConnectionHub, deps: Deps = {}): void {
  const authenticate = deps.authenticate ?? ((t, o) => authenticateConnection(t, o));
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const maxPublicConnections = deps.maxPublicConnections ?? DEFAULT_MAX_PUBLIC_CONNECTIONS;
  const wss = new WebSocketServer({ noServer: true });

  // Store auth results between upgrade and connection events
  const authMap = new WeakMap<WebSocket, { userId: string; public: boolean }>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? undefined;
    const isPublic = url.searchParams.get('public') === '1';
    // Authenticate before completing the handshake so a bad token never gets a 101
    void authenticate(token, { public: isPublic }).then((auth) => {
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (auth.public && hub.publicConnectionCount() >= maxPublicConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        authMap.set(ws, auth);
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const auth = authMap.get(ws);
    if (!auth) {
      // Should not happen — authenticate is done above — but guard anyway
      ws.close(1008, 'unauthorized');
      return;
    }

    const connId = hub.add(ws, auth.userId, auth.public);
    let missed = 0;
    ws.on('pong', () => { missed = 0; });
    const timer = setInterval(() => {
      if (missed >= 2) { ws.terminate(); return; }
      missed += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, heartbeatMs);

    ws.on('message', async (raw) => {
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return; }
      const parsed = WsClientMessageSchema.safeParse(json);
      if (!parsed.success) return;
      if (parsed.data.type === 'subscribe') await hub.subscribe(connId, parsed.data.topic, { canAccessService: deps.canAccessService, isServicePublic: deps.isServicePublic ?? isServicePublic });
      else hub.unsubscribe(connId, parsed.data.topic);
    });

    ws.on('close', () => { clearInterval(timer); hub.remove(connId); });
    ws.on('error', () => { clearInterval(timer); hub.remove(connId); });
  });
}
