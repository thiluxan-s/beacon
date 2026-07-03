import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { startEventListener } from './listener';

describe('startEventListener (integration)', () => {
  it('broadcasts a valid beacon_events payload', async () => {
    const broadcast = vi.fn();
    const sub = await startEventListener({ broadcast }, { connectionString: process.env.DATABASE_URL });
    const event = { type: 'service.status_changed', serviceId: 's1', userId: 'u1', status: 'up', previousStatus: 'pending', occurredAt: '2026-06-29T00:00:00.000Z' };
    const notifier = new Client({ connectionString: process.env.DATABASE_URL });
    await notifier.connect();
    await notifier.query(`select pg_notify('beacon_events', $1)`, [JSON.stringify(event)]);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'service.status_changed', serviceId: 's1' })), { timeout: 2000 });
    await notifier.end();
    await sub.stop();
  });

  it('ignores an invalid payload', async () => {
    const broadcast = vi.fn();
    const sub = await startEventListener({ broadcast }, { connectionString: process.env.DATABASE_URL });
    const notifier = new Client({ connectionString: process.env.DATABASE_URL });
    await notifier.connect();
    await notifier.query(`select pg_notify('beacon_events', $1)`, ['not json']);
    await new Promise((r) => setTimeout(r, 300));
    expect(broadcast).not.toHaveBeenCalled();
    await notifier.end();
    await sub.stop();
  });

  it('resolves (does not reject/crash) when the initial connection fails', async () => {
    // A DB outage at boot must not crash the process — startEventListener should
    // resolve and retry in the background; stop() cancels the pending reconnect.
    const broadcast = vi.fn();
    const sub = await startEventListener({ broadcast }, { connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nope' });
    await sub.stop();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
