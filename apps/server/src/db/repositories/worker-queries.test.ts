import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService, findDueServices, getService, setPaused } from './services';

async function makeService() {
  const u = await upsertFromClerk({ clerkUserId: 'user_w', email: 'w@e.com' });
  return createService(u.id, {
    name: 'W', baseUrl: 'https://w.com', healthCheckPath: '/',
    expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10,
  });
}

describe('worker queries (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('findDueServices returns a freshly-created (due-now) service', async () => {
    const svc = await makeService();
    const due = await findDueServices(10);
    expect(due.map((s) => s.id)).toContain(svc.id);
  });

  it('findDueServices skips paused services', async () => {
    const svc = await makeService();
    await setPaused(svc.userId, svc.id, true);
    const due = await findDueServices(10);
    expect(due.map((s) => s.id)).not.toContain(svc.id);
  });

  it('applyCheckResult records a check, advances next_check_at, and flips status on change', async () => {
    const svc = await makeService();
    await applyCheckResult({
      service: svc,
      check: { status: 'success', statusCode: 200, responseTimeMs: 42, errorMessage: null },
      rawStatus: 'up',
    });
    const after = await getService(svc.userId, svc.id);
    expect(after?.currentStatus).toBe('up');
    expect(after?.lastCheckAt).not.toBeNull();
    expect(after?.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM service_checks WHERE service_id=$1', [svc.id]);
    expect(rows[0].n).toBe(1);
  });

  it('applyCheckResult is no longer due immediately after a check', async () => {
    const svc = await makeService();
    await applyCheckResult({
      service: svc,
      check: { status: 'failure', statusCode: 500, responseTimeMs: 10, errorMessage: null },
      rawStatus: 'down',
    });
    expect((await findDueServices(10)).map((s) => s.id)).not.toContain(svc.id);
  });
});
