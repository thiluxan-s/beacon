import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { getByClerkId, upsertFromClerk } from './users';

describe('users repository (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('inserts a new user and reads it back', async () => {
    const created = await upsertFromClerk({ clerkUserId: 'user_1', email: 'a@example.com' });
    expect(created.clerkUserId).toBe('user_1');
    const found = await getByClerkId('user_1');
    expect(found?.email).toBe('a@example.com');
  });

  it('is idempotent and updates email on conflict', async () => {
    await upsertFromClerk({ clerkUserId: 'user_1', email: 'a@example.com' });
    const updated = await upsertFromClerk({ clerkUserId: 'user_1', email: 'b@example.com' });
    expect(updated.email).toBe('b@example.com');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('returns null for an unknown clerk id', async () => {
    expect(await getByClerkId('nope')).toBeNull();
  });
});
