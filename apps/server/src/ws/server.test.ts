import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ConnectionHub } from './connections';
import { attachWebSocketServer } from './server';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
}

describe('attachWebSocketServer (integration)', () => {
  it('authenticates, subscribes, and receives a broadcast', async () => {
    const hub = new ConnectionHub();
    const httpServer = createServer();
    attachWebSocketServer(httpServer, hub, {
      authenticate: async (token) => (token === 'good' ? { userId: 'u1', public: false } : null),
      canAccessService: async () => true,
      heartbeatMs: 10_000,
    });
    const port = await listen(httpServer);

    const ws = new WebSocket(`ws://localhost:${port}/ws?token=good`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'service:s1' }));
    await new Promise((r) => setTimeout(r, 50));
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())));
    hub.broadcast({ type: 'service.status_changed', serviceId: 's1', userId: 'u1', status: 'down', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' });
    const msg = JSON.parse(await got);
    expect(msg).toMatchObject({ type: 'service.status_changed', serviceId: 's1' });
    ws.close();
    httpServer.close();
  });

  it('rejects a bad token', async () => {
    const hub = new ConnectionHub();
    const httpServer = createServer();
    attachWebSocketServer(httpServer, hub, { authenticate: async () => null, heartbeatMs: 10_000 });
    const port = await listen(httpServer);
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('error', () => {}); // prevent uncaught exception so emitClose() runs and 'close' fires
      ws.on('close', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    expect(closed).toBe(true);
    httpServer.close();
  });
});
