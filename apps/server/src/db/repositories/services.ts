import { and, desc, eq } from 'drizzle-orm';
import type { ServiceCreateInput, ServiceUpdateInput } from '@beacon/shared';
import { db } from '../index';
import { services, type Service } from '../schema';

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
