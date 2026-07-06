import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { applyCheckResult, createService, deleteChecksOlderThan, listChecks } from './services';

async function seed() {
  const u = await upsertFromClerk({ clerkUserId: 'user_c', email: 'c@e.com' });
  const svc = await createService(u.id, { name: 'C', baseUrl: 'https://c.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 });
  return { userId: u.id, svc };
}

describe('checks repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('lists checks newest-first for the owner only', async () => {
    const { userId, svc } = await seed();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, rawStatus: 'up' });
    await applyCheckResult({ service: { ...svc, currentStatus: 'up' }, check: { status: 'failure', statusCode: 500, responseTimeMs: 12, errorMessage: null }, rawStatus: 'down' });
    const checks = await listChecks(userId, svc.id, 10);
    expect(checks).toHaveLength(2);
    expect(checks[0]!.checkedAt >= checks[1]!.checkedAt).toBe(true);
    expect(await listChecks('00000000-0000-0000-0000-000000000000', svc.id, 10)).toEqual([]);
  });

  it('deletes checks older than N days', async () => {
    const { svc } = await seed();
    await applyCheckResult({ service: svc, check: { status: 'success', statusCode: 200, responseTimeMs: 10, errorMessage: null }, rawStatus: 'up' });
    await pool.query("UPDATE service_checks SET checked_at = now() - interval '40 days' WHERE service_id = $1", [svc.id]);
    expect(await deleteChecksOlderThan(30)).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM service_checks WHERE service_id=$1', [svc.id]);
    expect(rows[0].n).toBe(0);
  });
});
