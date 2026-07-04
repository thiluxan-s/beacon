import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/index';
import { upsertFromClerk } from '../db/repositories/users';
import { authenticateConnection } from './auth';

describe('authenticateConnection (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('returns userId for a valid token whose user exists', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'clerk_1', email: 'a@e.com' });
    const verify = vi.fn().mockResolvedValue({ sub: 'clerk_1' });
    expect(await authenticateConnection('tok', { verify })).toEqual({ userId: u.id });
  });

  it('returns null when no token', async () => {
    expect(await authenticateConnection(undefined)).toBeNull();
  });

  it('returns null when verify throws', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('bad'));
    expect(await authenticateConnection('tok', { verify })).toBeNull();
  });

  it('returns null when the clerk user is unknown', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'nobody' });
    expect(await authenticateConnection('tok', { verify })).toBeNull();
  });
});
