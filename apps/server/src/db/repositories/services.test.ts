import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../index';
import { incidentEvents, incidents, services } from '../schema';
import { upsertFromClerk } from './users';
import {
  applyCheckResult,
  createService,
  deleteService,
  getService,
  isServicePublic,
  listPublicServices,
  listServicesByUser,
  setPaused,
  updateService,
} from './services';
import type { Service } from '../schema';

async function makeUser(clerkId = 'user_svc') {
  const u = await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` });
  return u.id;
}

async function apply(svc: Service, raw: 'up' | 'down', statusCode: number | null): Promise<Service> {
  const fresh = (await db.select().from(services).where(eq(services.id, svc.id)))[0]!;
  await applyCheckResult({
    service: fresh,
    check: { status: raw === 'up' ? 'success' : 'failure', statusCode, responseTimeMs: 5, errorMessage: null },
    rawStatus: raw,
  });
  return (await db.select().from(services).where(eq(services.id, svc.id)))[0]!;
}

describe('services repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('creates a service as pending and due now', async () => {
    const userId = await makeUser();
    const svc = await createService(userId, {
      name: 'Wayfare',
      baseUrl: 'https://wayfare.thiluxan.com',
      healthCheckPath: '/',
      expectedStatusCodes: [200],
      checkIntervalSeconds: 60,
      timeoutSeconds: 10,
    });
    expect(svc.currentStatus).toBe('pending');
    expect(svc.nextCheckAt).not.toBeNull();
    expect(svc.userId).toBe(userId);
  });

  it('lists only the owner-visible services', async () => {
    const a = await makeUser('user_a');
    const b = await makeUser('user_b');
    await createService(a, { name: 'A1', baseUrl: 'https://a1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await createService(b, { name: 'B1', baseUrl: 'https://b1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    expect((await listServicesByUser(a)).map((s) => s.name)).toEqual(['A1']);
  });

  it('does not return another user\'s service by id', async () => {
    const a = await makeUser('user_a');
    const b = await makeUser('user_b');
    const svc = await createService(a, { name: 'A1', baseUrl: 'https://a1.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    expect(await getService(b, svc.id)).toBeNull();
    expect(await getService(a, svc.id)).not.toBeNull();
  });

  it('updates, pauses, and deletes (ownership-scoped)', async () => {
    const userId = await makeUser();
    const svc = await createService(userId, { name: 'X', baseUrl: 'https://x.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    const updated = await updateService(userId, svc.id, { name: 'X2' });
    expect(updated?.name).toBe('X2');
    const paused = await setPaused(userId, svc.id, true);
    expect(paused?.paused).toBe(true);
    expect(await deleteService('other-user', svc.id)).toBe(false);
    expect(await deleteService(userId, svc.id)).toBe(true);
    expect(await getService(userId, svc.id)).toBeNull();
  });

  it('fail/fail opens one incident and flips status to down', async () => {
    const userId = await makeUser('seq');
    const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    let s = await apply(svc, 'up', 200);      // pending -> up
    s = await apply(s, 'down', 500);          // strike 1, still up
    expect(s.currentStatus).toBe('up');
    s = await apply(s, 'down', 500);          // strike 2 -> down + open
    expect(s.currentStatus).toBe('down');
    const open = await db.select().from(incidents).where(eq(incidents.serviceId, svc.id));
    expect(open).toHaveLength(1);
    expect(open[0]!.resolvedAt).toBeNull();
  });

  it('records observed only when the failure code changes', async () => {
    const userId = await makeUser('obs');
    const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    let s = await apply(svc, 'down', 500);
    s = await apply(s, 'down', 500);          // opens
    s = await apply(s, 'down', 500);          // same code -> no observed
    await apply(s, 'down', 503);              // changed -> observed
    const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
    const evs = await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id));
    const observed = evs.filter((e) => e.eventType === 'observed');
    expect(observed).toHaveLength(1);
  });

  it('ok/ok after down resolves the incident with a duration', async () => {
    const userId = await makeUser('rec');
    const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    let s = await apply(svc, 'down', 500);
    s = await apply(s, 'down', 500);          // open
    s = await apply(s, 'up', 200);            // recovery strike 1
    expect(s.currentStatus).toBe('down');
    s = await apply(s, 'up', 200);            // strike 2 -> resolve + up
    expect(s.currentStatus).toBe('up');
    const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
    expect(inc.resolvedAt).not.toBeNull();
    expect(inc.durationSeconds).not.toBeNull();
  });

  it('pausing a service with an open incident auto-resolves it with a note', async () => {
    const userId = await makeUser('pause');
    const svc = await createService(userId, { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    const s = await apply(svc, 'down', 500);
    await apply(s, 'down', 500);              // opens
    await setPaused(userId, svc.id, true);
    const inc = (await db.select().from(incidents).where(eq(incidents.serviceId, svc.id)))[0]!;
    expect(inc.resolvedAt).not.toBeNull();
    const evs = await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id));
    expect(evs.some((e) => e.eventType === 'note' && /paused/i.test(e.message))).toBe(true);
  });

  it('listPublicServices returns only is_public services; isServicePublic reflects the flag', async () => {
    const userId = await makeUser('pub_svc');
    const pub = await createService(userId, { name: 'Public', baseUrl: 'https://p.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    const priv = await createService(userId, { name: 'Private', baseUrl: 'https://q.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
    await updateService(userId, pub.id, { isPublic: true });
    const list = await listPublicServices();
    expect(list.map((s) => s.id)).toEqual([pub.id]);
    expect(await isServicePublic(pub.id)).toBe(true);
    expect(await isServicePublic(priv.id)).toBe(false);
    expect(await isServicePublic('not-a-uuid')).toBe(false);
  });
});
