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

  it('public conn: rejects global and private, allows public service topic', async () => {
    const hub = new ConnectionHub();
    const id = hub.add(fakeWs(), 'owner-uuid', true); // public conn
    const deps = { isServicePublic: async (sid: string) => sid === 'pub-svc' };
    expect(await hub.subscribe(id, 'global', deps)).toBe(false);
    expect(await hub.subscribe(id, 'service:priv-svc', deps)).toBe(false);
    expect(await hub.subscribe(id, 'service:pub-svc', deps)).toBe(true);
  });

  it('authed conn unchanged (ownership check)', async () => {
    const hub = new ConnectionHub();
    const id = hub.add(fakeWs(), 'u1'); // non-public
    expect(await hub.subscribe(id, 'global')).toBe(true);
    expect(await hub.subscribe(id, 'service:x', { canAccessService: async () => true })).toBe(true);
    expect(await hub.subscribe(id, 'service:y', { canAccessService: async () => false })).toBe(false);
  });

  it('publicConnectionCount counts only public connections and tracks removals', () => {
    const hub = new ConnectionHub();
    const p1 = hub.add(fakeWs(), 'owner-uuid', true);
    hub.add(fakeWs(), 'owner-uuid', true);
    hub.add(fakeWs(), 'u1'); // authed (non-public) — not counted
    expect(hub.publicConnectionCount()).toBe(2);
    hub.remove(p1);
    expect(hub.publicConnectionCount()).toBe(1);
  });
});
