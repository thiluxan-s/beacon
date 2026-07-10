import { and, desc, eq, lt, lte, sql } from 'drizzle-orm';
import type { CheckStatus, ServiceCreateInput, ServiceUpdateInput, WsEvent } from '@beacon/shared';
import { db } from '../index';
import { serviceChecks, services, type Service, type ServiceCheck } from '../schema';
import { decideTransition } from '../../workers/transition';
import { findOpenIncident, openIncident, recordObservationIfChanged, resolveIncident, type IncidentDetail } from './incidents';

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
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(services)
      .set({
        paused,
        currentStatus: paused ? 'paused' : 'pending',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(services.id, id), eq(services.userId, userId)))
      .returning();
    const svc = rows[0];
    if (!svc) return null;

    if (paused) {
      const open = await findOpenIncident(tx, id);
      if (open) {
        const now = new Date();
        const { durationSeconds } = await resolveIncident(tx, {
          incidentId: open.id,
          startedAt: open.startedAt,
          resolvedAt: now,
          resolutionCheckId: null,
          closeEvent: { type: 'note', message: 'Resolved: monitoring paused' },
        });
        const payload = {
          type: 'incident.resolved',
          incidentId: open.id,
          serviceId: id,
          userId: svc.userId,
          durationSeconds,
          resolvedAt: now.toISOString(),
          occurredAt: now.toISOString(),
        } satisfies WsEvent;
        await tx.execute(sql`select pg_notify('beacon_events', ${JSON.stringify(payload)})`);
      }
    }
    return svc;
  });
}

export async function listPublicServices(): Promise<Service[]> {
  return db.select().from(services).where(eq(services.isPublic, true)).orderBy(services.name);
}

export async function isServicePublic(serviceId: string): Promise<boolean> {
  if (!isUuid(serviceId)) return false;
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.isPublic, true)))
    .limit(1);
  return rows.length > 0;
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
  rawStatus: 'up' | 'down';
}): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + args.service.checkIntervalSeconds * 1000);

  const consecutiveFailures = args.rawStatus === 'down' ? args.service.consecutiveFailures + 1 : 0;
  const consecutiveSuccesses = args.rawStatus === 'up' ? args.service.consecutiveSuccesses + 1 : 0;

  const decision = decideTransition({
    currentStatus: args.service.currentStatus,
    consecutiveFailures,
    consecutiveSuccesses,
    rawStatus: args.rawStatus,
  });
  const statusChanged = decision.nextStatus !== args.service.currentStatus;
  const detail: IncidentDetail = {
    status: args.check.status,
    statusCode: args.check.statusCode,
    errorMessage: args.check.errorMessage,
  };

  const notifies: string[] = [];

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(serviceChecks)
      .values({
        serviceId: args.service.id,
        status: args.check.status,
        statusCode: args.check.statusCode,
        responseTimeMs: args.check.responseTimeMs,
        errorMessage: args.check.errorMessage,
        checkedAt: now,
      })
      .returning({ id: serviceChecks.id });
    const checkId = inserted[0]!.id;

    await tx
      .update(services)
      .set({
        lastCheckAt: now,
        nextCheckAt: next,
        updatedAt: now,
        consecutiveFailures,
        consecutiveSuccesses,
        ...(statusChanged ? { currentStatus: decision.nextStatus, currentStatusSince: now } : {}),
      })
      .where(eq(services.id, args.service.id));

    if (statusChanged) {
      notifies.push(JSON.stringify({
        type: 'service.status_changed',
        serviceId: args.service.id,
        userId: args.service.userId,
        status: decision.nextStatus,
        previousStatus: args.service.currentStatus,
        occurredAt: now.toISOString(),
      } satisfies WsEvent));
    }

    if (decision.incidentAction === 'open') {
      const inc = await openIncident(tx, { serviceId: args.service.id, startedAt: now, triggerCheckId: checkId, detail });
      notifies.push(JSON.stringify({
        type: 'incident.opened', incidentId: inc.id, serviceId: args.service.id, userId: args.service.userId,
        severity: 'down', startedAt: now.toISOString(), occurredAt: now.toISOString(),
      } satisfies WsEvent));
    } else if (decision.incidentAction === 'resolve') {
      const open = await findOpenIncident(tx, args.service.id);
      if (open) {
        const { durationSeconds } = await resolveIncident(tx, {
          incidentId: open.id, startedAt: open.startedAt, resolvedAt: now, resolutionCheckId: checkId,
          closeEvent: { type: 'resolved', message: 'Service recovered' },
        });
        notifies.push(JSON.stringify({
          type: 'incident.resolved', incidentId: open.id, serviceId: args.service.id, userId: args.service.userId,
          durationSeconds, resolvedAt: now.toISOString(), occurredAt: now.toISOString(),
        } satisfies WsEvent));
      }
    } else if (args.rawStatus === 'down') {
      const open = await findOpenIncident(tx, args.service.id);
      if (open) await recordObservationIfChanged(tx, { incidentId: open.id, detail, occurredAt: now });
    }

    for (const payload of notifies) {
      await tx.execute(sql`select pg_notify('beacon_events', ${payload})`);
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
