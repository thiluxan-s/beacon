import { describe, expect, it } from 'vitest';
import { WsClientMessageSchema, WsEventSchema } from './ws-event';

describe('WsEventSchema', () => {
  it('parses a service.status_changed event', () => {
    const e = {
      type: 'service.status_changed',
      serviceId: 's1',
      userId: 'u1',
      status: 'up',
      previousStatus: 'pending',
      occurredAt: '2026-06-29T00:00:00.000Z',
    };
    expect(WsEventSchema.parse(e)).toEqual(e);
  });

  it('rejects an unknown event type', () => {
    expect(WsEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a bad status', () => {
    expect(
      WsEventSchema.safeParse({ type: 'service.status_changed', serviceId: 's', userId: 'u', status: 'sideways', previousStatus: 'up', occurredAt: '2026-06-29T00:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('WsClientMessageSchema', () => {
  it('parses subscribe/unsubscribe', () => {
    expect(WsClientMessageSchema.parse({ type: 'subscribe', topic: 'service:s1' })).toEqual({ type: 'subscribe', topic: 'service:s1' });
    expect(WsClientMessageSchema.parse({ type: 'unsubscribe', topic: 'global' })).toEqual({ type: 'unsubscribe', topic: 'global' });
  });

  it('rejects an empty topic', () => {
    expect(WsClientMessageSchema.safeParse({ type: 'subscribe', topic: '' }).success).toBe(false);
  });
});
