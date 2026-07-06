import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from './router';
import { pool, db } from './db/index';
import { incidents, serviceChecks, services } from './db/schema';
import { upsertFromClerk } from './db/repositories/users';
import { env } from './lib/env';

const app = createRouter();
function req(path: string, clerkId: string) {
  return app.request(path, { headers: { 'x-internal-secret': env.INTERNAL_API_SECRET, 'x-clerk-user-id': clerkId } });
}

describe('incidents routes', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('401 without secret', async () => {
    const res = await app.request('/internal/incidents');
    expect(res.status).toBe(401);
  });

  it('lists incidents for the owner and filters by service', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'r_owner', email: 'o@e.com' });
    const [svc] = await db.insert(services).values({ userId: u.id, name: 'S', baseUrl: 'https://s.com', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
    const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
    await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id });
    const res = await req('/internal/incidents', 'r_owner');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<{ serviceName: string }> };
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]?.serviceName).toBe('S');
  });

  it('404 for a non-owned incident detail', async () => {
    const owner = await upsertFromClerk({ clerkUserId: 'r_o2', email: 'o2@e.com' });
    await upsertFromClerk({ clerkUserId: 'r_intruder', email: 'i@e.com' });
    const [svc] = await db.insert(services).values({ userId: owner.id, name: 'S', baseUrl: 'https://s.com', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
    const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
    const [inc] = await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id }).returning();
    const res = await req(`/internal/incidents/${inc!.id}`, 'r_intruder');
    expect(res.status).toBe(404);
  });
});
