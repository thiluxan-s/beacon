import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from './router';
import { pool, db } from './db/index';
import { services } from './db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from './db/repositories/users';
import { createService } from './db/repositories/services';
import { env } from './lib/env';

const app = createRouter();
function pub(path: string) {
  return app.request(path, { headers: { 'x-internal-secret': env.INTERNAL_API_SECRET } });
}

describe('public endpoints', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await pool.end(); });

  it('401 without the secret', async () => {
    expect((await app.request('/internal/public/services')).status).toBe(401);
  });

  it('404 when public mode disabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
    expect((await pub('/internal/public/services')).status).toBe(404);
  });

  it('returns only public rows when enabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'owner');
    const u = await upsertFromClerk({ clerkUserId: 'owner', email: 'o@e.com' });
    const s = await createService(u.id, { name: 'Pub', baseUrl: 'https://p.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await createService(u.id, { name: 'Priv', baseUrl: 'https://q.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await db.update(services).set({ isPublic: true }).where(eq(services.id, s.id));
    const res = await pub('/internal/public/services');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: { id: string; name: string }[] };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]!.name).toBe('Pub');
    // minimal DTO — no baseUrl leaked
    expect(JSON.stringify(body)).not.toContain('p.com');
  });
});
