import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../index';
import { serviceIntegrations, type ServiceIntegration } from '../schema';
import { getService } from './services';

export type { ServiceIntegration };

export async function upsertIntegration(args: {
  serviceId: string;
  integrationId: string;
  config: Record<string, unknown>;
  credentialsEncrypted: string;
}): Promise<ServiceIntegration> {
  const rows = await db
    .insert(serviceIntegrations)
    .values({
      serviceId: args.serviceId,
      integrationId: args.integrationId,
      config: args.config,
      credentialsEncrypted: args.credentialsEncrypted,
    })
    .onConflictDoUpdate({
      target: [serviceIntegrations.serviceId, serviceIntegrations.integrationId],
      set: {
        config: args.config,
        credentialsEncrypted: args.credentialsEncrypted,
        lastError: null,
        lastFetchedAt: null,
        lastSnapshot: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertIntegration: no row returned');
  return row;
}

export async function listIntegrations(userId: string, serviceId: string): Promise<ServiceIntegration[]> {
  if (!(await getService(userId, serviceId))) return [];
  return db.select().from(serviceIntegrations).where(eq(serviceIntegrations.serviceId, serviceId));
}

export async function getIntegration(
  userId: string,
  serviceId: string,
  integrationId: string,
): Promise<ServiceIntegration | null> {
  if (!(await getService(userId, serviceId))) return null;
  const rows = await db
    .select()
    .from(serviceIntegrations)
    .where(and(eq(serviceIntegrations.serviceId, serviceId), eq(serviceIntegrations.integrationId, integrationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteIntegration(userId: string, serviceId: string, integrationId: string): Promise<boolean> {
  if (!(await getService(userId, serviceId))) return false;
  const rows = await db
    .delete(serviceIntegrations)
    .where(and(eq(serviceIntegrations.serviceId, serviceId), eq(serviceIntegrations.integrationId, integrationId)))
    .returning({ id: serviceIntegrations.id });
  return rows.length > 0;
}

/** Enabled integrations never fetched, or last fetched more than `olderThanMs` ago. */
export async function findDueIntegrations(olderThanMs: number, limit: number): Promise<ServiceIntegration[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .select()
    .from(serviceIntegrations)
    .where(
      and(
        eq(serviceIntegrations.enabled, true),
        or(isNull(serviceIntegrations.lastFetchedAt), lt(serviceIntegrations.lastFetchedAt, cutoff)),
      ),
    )
    .limit(limit);
}

export async function recordFetchSuccess(id: string, snapshot: Record<string, unknown>): Promise<void> {
  await db
    .update(serviceIntegrations)
    .set({ lastSnapshot: snapshot, lastFetchedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(serviceIntegrations.id, id));
}

export async function recordFetchError(id: string, error: string): Promise<void> {
  await db
    .update(serviceIntegrations)
    .set({ lastError: error, lastFetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(serviceIntegrations.id, id));
}
