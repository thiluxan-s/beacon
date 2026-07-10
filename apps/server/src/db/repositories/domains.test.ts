import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { domainChecks } from '../schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from './users';
import {
  createDomain, listDomainsByUser, getDomain, deleteDomain,
  findDueDomains, recheckDomain, applyDomainCheckResult, DomainExistsError,
  listPublicDomains, setDomainPublic,
} from './domains';

async function makeUser(clerkId = 'dom_user') {
  return (await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` })).id;
}

describe('domains repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('creates a pending domain due now, lowercased', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'Thiluxan.COM', checkIntervalSeconds: 3600 });
    expect(d.domain).toBe('thiluxan.com');
    expect(d.currentStatus).toBe('pending');
    expect(d.nextCheckAt).not.toBeNull();
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(true);
  });

  it('rejects a duplicate (user, domain) with DomainExistsError', async () => {
    const userId = await makeUser();
    await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    await expect(createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 })).rejects.toBeInstanceOf(DomainExistsError);
  });

  it('lists/gets/deletes owner-scoped', async () => {
    const a = await makeUser('a'); const b = await makeUser('b');
    const d = await createDomain(a, { domain: 'a.com', checkIntervalSeconds: 3600 });
    expect(await listDomainsByUser(a)).toHaveLength(1);
    expect(await listDomainsByUser(b)).toHaveLength(0);
    expect(await getDomain(b, d.id)).toBeNull();
    expect(await deleteDomain(b, d.id)).toBe(false);
    expect(await deleteDomain(a, d.id)).toBe(true);
  });

  it('applyDomainCheckResult writes a check + updates the row', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    const ssl = new Date(Date.now() + 40 * 86_400_000);
    await applyDomainCheckResult({
      domain: d,
      check: { dnsResolved: true, dnsIp: '1.2.3.4', sslValid: true, sslExpiresAt: ssl, sslDaysUntilExpiry: 40, errorMessage: null },
      status: 'healthy', sslExpiresAt: ssl, domainExpiresAt: null, sslIssuer: 'CA',
    });
    const updated = await getDomain(userId, d.id);
    expect(updated?.currentStatus).toBe('healthy');
    expect(updated?.sslIssuer).toBe('CA');
    expect(updated?.lastCheckAt).not.toBeNull();
    const checks = await db.select().from(domainChecks).where(eq(domainChecks.domainId, d.id));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.dnsIp).toBe('1.2.3.4');
  });

  it('recheckDomain sets next_check_at to now, owner-scoped', async () => {
    const userId = await makeUser();
    const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    // push it into the future first
    await applyDomainCheckResult({ domain: d, check: { dnsResolved: true, dnsIp: null, sslValid: true, sslExpiresAt: null, sslDaysUntilExpiry: null, errorMessage: null }, status: 'healthy', sslExpiresAt: null, domainExpiresAt: null, sslIssuer: null });
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(false);
    const re = await recheckDomain(userId, d.id);
    expect(re).not.toBeNull();
    expect((await findDueDomains(10)).some((x) => x.id === d.id)).toBe(true);
  });

  it('setDomainPublic flips the flag (owner-scoped); listPublicDomains returns only public', async () => {
    const userId = await makeUser('pub_dom');
    const d = await createDomain(userId, { domain: 'thiluxan.com', checkIntervalSeconds: 3600 });
    expect(await listPublicDomains()).toHaveLength(0);
    expect(await setDomainPublic('00000000-0000-0000-0000-000000000000', d.id, true)).toBeNull(); // non-owner
    const updated = await setDomainPublic(userId, d.id, true);
    expect(updated?.isPublic).toBe(true);
    expect((await listPublicDomains()).map((x) => x.id)).toEqual([d.id]);
  });
});
