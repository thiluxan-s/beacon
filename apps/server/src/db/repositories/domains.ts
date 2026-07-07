import { and, asc, eq, lte } from 'drizzle-orm';
import type { DomainCreateInput } from '@beacon/shared';
import { db } from '../index';
import { domainChecks, domains, type Domain } from '../schema';
import type { DomainStatus } from '../../workers/domain-status';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID_RE.test(s);

export class DomainExistsError extends Error {}

export async function createDomain(userId: string, input: DomainCreateInput): Promise<Domain> {
  try {
    const rows = await db
      .insert(domains)
      .values({
        userId,
        domain: input.domain.toLowerCase(),
        checkIntervalSeconds: input.checkIntervalSeconds,
        currentStatus: 'pending',
        nextCheckAt: new Date(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createDomain: no row returned');
    return row;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
      throw new DomainExistsError('domain already tracked');
    }
    throw err;
  }
}

export async function listDomainsByUser(userId: string): Promise<Domain[]> {
  return db.select().from(domains).where(eq(domains.userId, userId)).orderBy(asc(domains.domain));
}

export async function getDomain(userId: string, id: string): Promise<Domain | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db.select().from(domains).where(and(eq(domains.id, id), eq(domains.userId, userId))).limit(1);
  return rows[0] ?? null;
}

export async function deleteDomain(userId: string, id: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(id)) return false;
  const rows = await db.delete(domains).where(and(eq(domains.id, id), eq(domains.userId, userId))).returning({ id: domains.id });
  return rows.length > 0;
}

export async function findDueDomains(limit: number): Promise<Domain[]> {
  return db.select().from(domains).where(lte(domains.nextCheckAt, new Date())).orderBy(asc(domains.nextCheckAt)).limit(limit);
}

export async function recheckDomain(userId: string, id: string): Promise<Domain | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .update(domains)
    .set({ nextCheckAt: new Date(), updatedAt: new Date() })
    .where(and(eq(domains.id, id), eq(domains.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function applyDomainCheckResult(args: {
  domain: Domain;
  check: { dnsResolved: boolean; dnsIp: string | null; sslValid: boolean | null; sslExpiresAt: Date | null; sslDaysUntilExpiry: number | null; errorMessage: string | null };
  status: Exclude<DomainStatus, 'pending'>;
  sslExpiresAt: Date | null;
  domainExpiresAt: Date | null;
  sslIssuer: string | null;
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.domain.checkIntervalSeconds * 1000);
  await db.transaction(async (tx) => {
    await tx.insert(domainChecks).values({ domainId: args.domain.id, checkedAt: now, ...args.check });
    await tx
      .update(domains)
      .set({
        currentStatus: args.status,
        sslExpiresAt: args.sslExpiresAt,
        domainExpiresAt: args.domainExpiresAt,
        sslIssuer: args.sslIssuer,
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
      })
      .where(eq(domains.id, args.domain.id));
  });
}
