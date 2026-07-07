import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, init: RequestInit & { clerkId?: string } = {}) {
  const { clerkId, ...rest } = init;
  return app.request(path, { ...rest, headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, ...(clerkId ? { 'x-clerk-user-id': clerkId } : {}), 'content-type': 'application/json' } });
}

describe('domains routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without secret', async () => {
    expect((await app.request('/internal/domains')).status).toBe(401);
  });

  it('creates, lists, rechecks, deletes; rejects bad domain and duplicate', async () => {
    await upsertFromClerk({ clerkUserId: 'dr', email: 'dr@e.com' });
    const bad = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'https://x.com' }) });
    expect(bad.status).toBe(400);
    const created = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const dup = await req('/internal/domains', { method: 'POST', clerkId: 'dr', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    expect(dup.status).toBe(409);
    const list = await req('/internal/domains', { clerkId: 'dr' });
    expect(((await list.json()) as { domains: unknown[] }).domains).toHaveLength(1);
    expect((await req(`/internal/domains/${id}/recheck`, { method: 'POST', clerkId: 'dr' })).status).toBe(200);
    expect((await req(`/internal/domains/${id}`, { method: 'DELETE', clerkId: 'dr' })).status).toBe(204);
  });

  it('404 deleting a non-owned domain', async () => {
    await upsertFromClerk({ clerkUserId: 'owner', email: 'o@e.com' });
    await upsertFromClerk({ clerkUserId: 'intruder', email: 'i@e.com' });
    const created = await req('/internal/domains', { method: 'POST', clerkId: 'owner', body: JSON.stringify({ domain: 'thiluxan.com' }) });
    const id = ((await created.json()) as { id: string }).id;
    expect((await req(`/internal/domains/${id}`, { method: 'DELETE', clerkId: 'intruder' })).status).toBe(404);
  });
});
