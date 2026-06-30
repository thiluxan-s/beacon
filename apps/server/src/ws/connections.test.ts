import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@beacon/shared';
import { ConnectionHub, type WsLike } from './connections';

function fakeWs() {
  return { sent: [] as string[], send(d: string) { this.sent.push(d); } } as WsLike & { sent: string[] };
}

const event: WsEvent = { type: 'service.status_changed', serviceId: 'svc1', userId: 'u1', status: 'down', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' };

describe('ConnectionHub', () => {
  it('broadcasts to a connection subscribed to the service topic of the same user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    await hub.subscribe(id, 'service:svc1', { canAccessService: async () => true });
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'service.status_changed', serviceId: 'svc1' });
  });

  it('broadcasts to global subscribers of the same user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    await hub.subscribe(id, 'global');
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(1);
  });

  it('does NOT broadcast to a different user', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u2');
    await hub.subscribe(id, 'global');
    hub.broadcast(event);
    expect(ws.sent).toHaveLength(0);
  });

  it('rejects subscribing to a service the user does not own', async () => {
    const hub = new ConnectionHub();
    const ws = fakeWs();
    const id = hub.add(ws, 'u1');
    const ok = await hub.subscribe(id, 'service:other', { canAccessService: async () => false });
    expect(ok).toBe(false);
    hub.broadcast({ ...event, serviceId: 'other' });
    expect(ws.sent).toHaveLength(0);
  });
});
