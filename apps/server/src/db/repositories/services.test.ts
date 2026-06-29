import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import {
  createService,
  deleteService,
  getService,
  listServicesByUser,
  setPaused,
  updateService,
} from './services';

async function makeUser(clerkId = 'user_svc') {
  const u = await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` });
  return u.id;
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
});
