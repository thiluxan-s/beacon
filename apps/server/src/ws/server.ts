import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsClientMessageSchema } from '@beacon/shared';
import { authenticateConnection } from './auth';
import type { ConnectionHub } from './connections';

type Deps = {
  authenticate?: (token: string | undefined) => Promise<{ userId: string } | null>;
  canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
  heartbeatMs?: number;
};

export function attachWebSocketServer(httpServer: Server, hub: ConnectionHub, deps: Deps = {}): void {
  const authenticate = deps.authenticate ?? ((t) => authenticateConnection(t));
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const wss = new WebSocketServer({ noServer: true });

  // Store auth results between upgrade and connection events
  const authMap = new WeakMap<WebSocket, { userId: string }>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? undefined;
    // Authenticate before completing the handshake so a bad token never gets a 101
    void authenticate(token).then((auth) => {
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
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

    const connId = hub.add(ws, auth.userId);
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
      if (parsed.data.type === 'subscribe') await hub.subscribe(connId, parsed.data.topic, { canAccessService: deps.canAccessService });
      else hub.unsubscribe(connId, parsed.data.topic);
    });

    ws.on('close', () => { clearInterval(timer); hub.remove(connId); });
    ws.on('error', () => { clearInterval(timer); hub.remove(connId); });
  });
}
