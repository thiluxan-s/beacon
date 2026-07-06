import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { getResolvedSettings, upsertSettings } from './notification-settings';

async function makeUser(clerkId = 'ns_user', email = 'clerk@e.com') {
  return (await upsertFromClerk({ clerkUserId: clerkId, email })).id;
}

describe('notification-settings repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('defaults to enabled + the clerk email when no row exists', async () => {
    const userId = await makeUser('ns1', 'clerk1@e.com');
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: true, alertEmail: 'clerk1@e.com' });
  });

  it('upsert sets and updates fields; null alertEmail falls back', async () => {
    const userId = await makeUser('ns2', 'clerk2@e.com');
    await upsertSettings(userId, { alertsEnabled: false, alertEmail: 'override@e.com' });
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: false, alertEmail: 'override@e.com' });
    await upsertSettings(userId, { alertEmail: null });
    expect(await getResolvedSettings(userId)).toEqual({ alertsEnabled: false, alertEmail: 'clerk2@e.com' });
  });
});
