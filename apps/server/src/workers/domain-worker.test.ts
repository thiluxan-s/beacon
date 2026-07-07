import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../db/index';
import { domainChecks, domains } from '../db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from '../db/repositories/users';
import { createDomain } from '../db/repositories/domains';
import { checkDomainOnce } from './domain-worker';

async function seed() {
  const u = await upsertFromClerk({ clerkUserId: 'dw', email: 'dw@e.com' });
  return createDomain(u.id, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
}

describe('domain worker checkDomainOnce (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('classifies healthy and writes a check + updates the row', async () => {
    const d = await seed();
    const ssl = new Date(Date.now() + 60 * 86_400_000);
    await checkDomainOnce(d, {
      resolveDns: async () => ({ resolved: true, ip: '1.2.3.4' }),
      probeSsl: async () => ({ expiresAt: ssl, issuer: 'CA' }),
      probeRdap: async () => ({ expiresAt: new Date(Date.now() + 300 * 86_400_000) }),
    });
    const row = (await db.select().from(domains).where(eq(domains.id, d.id)))[0]!;
    expect(row.currentStatus).toBe('healthy');
    expect(row.sslIssuer).toBe('CA');
    const checks = await db.select().from(domainChecks).where(eq(domainChecks.domainId, d.id));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.sslValid).toBe(true);
  });

  it('classifies unhealthy when DNS fails, without throwing', async () => {
    const d = await seed();
    await checkDomainOnce(d, {
      resolveDns: async () => ({ resolved: false, ip: null, error: 'ENOTFOUND' }),
      probeSsl: async () => ({ expiresAt: null, issuer: null, error: 'x' }),
      probeRdap: async () => ({ expiresAt: null }),
    });
    const row = (await db.select().from(domains).where(eq(domains.id, d.id)))[0]!;
    expect(row.currentStatus).toBe('unhealthy');
  });
});
