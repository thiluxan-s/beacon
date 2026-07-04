import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService } from './services';

async function makeService() {
  const u = await upsertFromClerk({ clerkUserId: 'user_n', email: 'n@e.com' });
  return createService(u.id, { name: 'N', baseUrl: 'https://n.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
}

describe('applyCheckResult pg_notify (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('emits a beacon_events notification when status changes', async () => {
    const svc = await makeService();
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query('LISTEN beacon_events');
    const received = new Promise<string>((resolve) => {
      listener.on('notification', (msg) => resolve(msg.payload ?? ''));
    });
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({ type: 'service.status_changed', serviceId: svc.id, userId: svc.userId, status: 'up', previousStatus: 'pending' });
    await listener.end();
  });

  it('emits NO notification when status is unchanged', async () => {
    const svc = await makeService();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, newStatus: 'up' });
    const after = { ...svc, currentStatus: 'up' as const };
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query('LISTEN beacon_events');
    let got = false;
    listener.on('notification', () => { got = true; });
    await applyCheckResult({ service: after, check: { status: 'success', statusCode: 200, responseTimeMs: 11, errorMessage: null }, newStatus: 'up' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toBe(false);
    await listener.end();
  });
});
