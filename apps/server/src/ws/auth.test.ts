import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/index';
import { upsertFromClerk } from '../db/repositories/users';
import { authenticateConnection } from './auth';

describe('authenticateConnection (integration)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it('returns userId for a valid token whose user exists', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'clerk_1', email: 'a@e.com' });
    const verify = vi.fn().mockResolvedValue({ sub: 'clerk_1' });
    expect(await authenticateConnection('tok', {}, { verify })).toEqual({ userId: u.id, public: false });
  });

  it('returns null when no token', async () => {
    expect(await authenticateConnection(undefined)).toBeNull();
  });

  it('returns null when verify throws', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('bad'));
    expect(await authenticateConnection('tok', {}, { verify })).toBeNull();
  });

  it('returns null when the clerk user is unknown', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'nobody' });
    expect(await authenticateConnection('tok', {}, { verify })).toBeNull();
  });

  it('public connection resolves to the owner when enabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'owner_clerk');
    const auth = await authenticateConnection(undefined, { public: true }, { resolveOwner: async () => ({ userId: 'owner-uuid' }) });
    expect(auth).toEqual({ userId: 'owner-uuid', public: true });
  });

  it('public connection rejected when disabled', async () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
    expect(await authenticateConnection(undefined, { public: true })).toBeNull();
  });

  it('token connection still resolves with public:false', async () => {
    const auth = await authenticateConnection('tok', {}, { verify: async () => ({ sub: 'clerk_x' }), resolveByClerk: async () => ({ userId: 'u1' }) });
    expect(auth).toEqual({ userId: 'u1', public: false });
  });
});
