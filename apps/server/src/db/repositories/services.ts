import { and, desc, eq, lt, lte, sql } from 'drizzle-orm';
import type { CheckStatus, ServiceCreateInput, ServiceStatus, ServiceUpdateInput } from '@beacon/shared';
import { db } from '../index';
import { serviceChecks, services, type Service, type ServiceCheck } from '../schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export async function createService(userId: string, input: ServiceCreateInput): Promise<Service> {
  const rows = await db
    .insert(services)
    .values({
      userId,
      name: input.name,
      description: input.description,
      baseUrl: input.baseUrl,
      healthCheckPath: input.healthCheckPath,
      expectedStatusCodes: input.expectedStatusCodes,
      checkIntervalSeconds: input.checkIntervalSeconds,
      timeoutSeconds: input.timeoutSeconds,
      currentStatus: 'pending',
      currentStatusSince: new Date(),
      nextCheckAt: new Date(),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createService: no row returned');
  return row;
}

export async function listServicesByUser(userId: string): Promise<Service[]> {
  return db.select().from(services).where(eq(services.userId, userId)).orderBy(desc(services.createdAt));
}

export async function getService(userId: string, id: string): Promise<Service | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateService(
  userId: string,
  id: string,
  patch: ServiceUpdateInput,
): Promise<Service | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .update(services)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteService(userId: string, id: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(id)) return false;
  const rows = await db
    .delete(services)
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning({ id: services.id });
  return rows.length > 0;
}

export async function setPaused(userId: string, id: string, paused: boolean): Promise<Service | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const rows = await db
    .update(services)
    .set({ paused, currentStatus: paused ? 'paused' : 'pending', updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function findDueServices(limit: number): Promise<Service[]> {
  return db
    .select()
    .from(services)
    .where(and(eq(services.paused, false), lte(services.nextCheckAt, new Date())))
    .orderBy(services.nextCheckAt)
    .limit(limit);
}

export async function applyCheckResult(args: {
  service: Service;
  check: { status: CheckStatus; statusCode: number | null; responseTimeMs: number | null; errorMessage: string | null };
  newStatus: ServiceStatus;
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.service.checkIntervalSeconds * 1000);
  const statusChanged = args.newStatus !== args.service.currentStatus;
  await db.transaction(async (tx) => {
    await tx.insert(serviceChecks).values({
      serviceId: args.service.id,
      status: args.check.status,
      statusCode: args.check.statusCode,
      responseTimeMs: args.check.responseTimeMs,
      errorMessage: args.check.errorMessage,
      checkedAt: now,
    });
    await tx
      .update(services)
      .set({
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
        ...(statusChanged ? { currentStatus: args.newStatus, currentStatusSince: now } : {}),
      })
      .where(eq(services.id, args.service.id));
    if (statusChanged) {
      const event = {
        type: 'service.status_changed' as const,
        serviceId: args.service.id,
        userId: args.service.userId,
        status: args.newStatus,
        previousStatus: args.service.currentStatus,
        occurredAt: now.toISOString(),
      };
      await tx.execute(sql`select pg_notify('beacon_events', ${JSON.stringify(event)})`);
    }
  });
}

export async function listChecks(userId: string, serviceId: string, limit: number): Promise<ServiceCheck[]> {
  const owned = await getService(userId, serviceId);
  if (!owned) return [];
  return db
    .select()
    .from(serviceChecks)
    .where(eq(serviceChecks.serviceId, serviceId))
    .orderBy(desc(serviceChecks.checkedAt))
    .limit(limit);
}

export async function deleteChecksOlderThan(days: number): Promise<number> {
  const rows = await db
    .delete(serviceChecks)
    .where(lt(serviceChecks.checkedAt, sql`now() - make_interval(days => ${days})`))
    .returning({ id: serviceChecks.id });
  return rows.length;
}
