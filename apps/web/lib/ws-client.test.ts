import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@beacon/shared';
import { BeaconSocket, nextBackoffMs } from './ws-client';

describe('nextBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(3)).toBe(8000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});

// Minimal WebSocket stand-in — captures the URL and lets tests drive open/message events.
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  send() {}
  close() {}
  dispatch(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

describe('BeaconSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('routes incident events to the service topic handler', async () => {
    const sock = new BeaconSocket({ url: 'ws://x', public: true });
    const got: WsEvent[] = [];
    sock.subscribe('service:s1', (e) => got.push(e));
    await sock.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.dispatch('open', {});
    const event: WsEvent = {
      type: 'incident.opened', incidentId: 'i1', serviceId: 's1', userId: 'u1',
      severity: 'down', startedAt: '2026-07-07T00:00:00.000Z', occurredAt: '2026-07-07T00:00:00.000Z',
    };
    ws.dispatch('message', { data: JSON.stringify(event) });
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe('incident.opened');
  });

  it('public mode connects with ?public=1 and no token', async () => {
    const sock = new BeaconSocket({ url: 'ws://x', public: true });
    await sock.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toBe('ws://x?public=1');
  });
});
