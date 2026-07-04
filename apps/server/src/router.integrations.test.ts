import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { createService } from './db/repositories/services';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();
const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };
const H = (clerk: string) => ({ 'content-type': 'application/json', 'x-internal-secret': SECRET, 'x-clerk-user-id': clerk });

afterEach(() => vi.unstubAllGlobals());
function stubFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status }))));
}

describe('integration routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  async function ownedService(clerk = 'u_ir'): Promise<string> {
    const u = await upsertFromClerk({ clerkUserId: clerk, email: `${clerk}@e.com` });
    return (await createService(u.id, svcInput)).id;
  }

  it('attaches a valid Vercel integration (credentials never returned)', async () => {
    stubFetch(200); // testCredentials -> ok
    const id = await ownedService();
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST',
      headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { integrationId: string; config: unknown };
    expect(body.integrationId).toBe('vercel');
    expect(body.config).toEqual({ projectId: 'p1' });
    expect(JSON.stringify(body)).not.toContain('tok'); // no credential leakage
  });

  it('rejects when testCredentials fails and saves nothing', async () => {
    stubFetch(401);
    const id = await ownedService();
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'bad' } }),
    });
    expect(res.status).toBe(400);
    const list = await app.request(`/internal/services/${id}/integrations`, { headers: H('u_ir') });
    const listBody = (await list.json()) as { integrations: unknown[] };
    expect(listBody.integrations).toHaveLength(0);
  });

  it('401 without the internal secret', async () => {
    const res = await app.request('/internal/services/x/integrations', { headers: { 'x-clerk-user-id': 'u_ir' } });
    expect(res.status).toBe(401);
  });

  it('404 when the service is not owned', async () => {
    stubFetch(200);
    const id = await ownedService('u_owner');
    await upsertFromClerk({ clerkUserId: 'u_other', email: 'o@e.com' });
    const res = await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_other'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes an integration', async () => {
    stubFetch(200);
    const id = await ownedService();
    await app.request(`/internal/services/${id}/integrations`, {
      method: 'POST', headers: H('u_ir'),
      body: JSON.stringify({ integrationId: 'vercel', config: { projectId: 'p1' }, credentials: { apiToken: 'tok' } }),
    });
    const del = await app.request(`/internal/services/${id}/integrations/vercel`, { method: 'DELETE', headers: H('u_ir') });
    expect(del.status).toBe(204);
  });
});
