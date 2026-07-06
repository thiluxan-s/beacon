import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, init: RequestInit & { clerkId?: string } = {}) {
  const { clerkId, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, ...(clerkId ? { 'x-clerk-user-id': clerkId } : {}), 'content-type': 'application/json' },
  });
}

describe('notification-settings routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without the secret', async () => {
    const res = await app.request('/internal/notification-settings');
    expect(res.status).toBe(401);
  });

  it('GET returns defaults; PUT updates', async () => {
    await upsertFromClerk({ clerkUserId: 'ns_r', email: 'clerk@e.com' });
    const get1 = await req('/internal/notification-settings', { clerkId: 'ns_r' });
    expect(await get1.json()).toEqual({ alertsEnabled: true, alertEmail: 'clerk@e.com' });
    const put = await req('/internal/notification-settings', { method: 'PUT', clerkId: 'ns_r', body: JSON.stringify({ alertsEnabled: false, alertEmail: 'x@y.com' }) });
    expect(put.status).toBe(200);
    const get2 = await req('/internal/notification-settings', { clerkId: 'ns_r' });
    expect(await get2.json()).toEqual({ alertsEnabled: false, alertEmail: 'x@y.com' });
  });

  it('PUT rejects a bad email', async () => {
    await upsertFromClerk({ clerkUserId: 'ns_bad', email: 'clerk@e.com' });
    const put = await req('/internal/notification-settings', { method: 'PUT', clerkId: 'ns_bad', body: JSON.stringify({ alertEmail: 'nope' }) });
    expect(put.status).toBe(400);
  });
});
