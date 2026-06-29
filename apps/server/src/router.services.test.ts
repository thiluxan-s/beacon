import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();

function req(path: string, init: RequestInit & { clerk?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-internal-secret', SECRET);
  if (init.clerk !== '') headers.set('x-clerk-user-id', init.clerk ?? 'user_api');
  return app.request(path, { ...init, headers });
}

describe('internal services endpoints', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
    await upsertFromClerk({ clerkUserId: 'user_api', email: 'api@e.com' });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('rejects without the internal secret', async () => {
    const res = await app.request('/internal/services', { headers: { 'x-clerk-user-id': 'user_api' } });
    expect(res.status).toBe(401);
  });

  it('creates and lists a service', async () => {
    const create = await req('/internal/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Wayfare', baseUrl: 'https://wayfare.thiluxan.com' }),
    });
    expect(create.status).toBe(201);
    const list = await req('/internal/services');
    const body = (await list.json()) as { services: Array<{ name: string }> };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]?.name).toBe('Wayfare');
  });

  it('404s for an unknown id', async () => {
    const res = await req('/internal/services/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
