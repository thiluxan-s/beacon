import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from './db/index';
import { upsertFromClerk } from './db/repositories/users';
import { applyCheckResult, createService } from './db/repositories/services';
import { createRouter } from './router';

const SECRET = process.env.INTERNAL_API_SECRET!;
const app = createRouter();

describe('GET /internal/services/:id/checks', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('returns recent checks for the owner', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'user_rc', email: 'rc@e.com' });
    const svc = await createService(u.id, { name: 'R', baseUrl: 'https://r.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 9, errorMessage: null }, rawStatus: 'up' });
    const res = await app.request(`/internal/services/${svc.id}/checks`, { headers: { 'x-internal-secret': SECRET, 'x-clerk-user-id': 'user_rc' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: unknown[] };
    expect(body.checks).toHaveLength(1);
  });

  it('401 without the secret', async () => {
    const res = await app.request('/internal/services/x/checks', { headers: { 'x-clerk-user-id': 'user_rc' } });
    expect(res.status).toBe(401);
  });
});
