import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../index';
import { incidentEvents, incidents, services, type Incident } from '../schema';

export type IncidentDetail = {
  status: 'success' | 'failure' | 'timeout' | 'error';
  statusCode: number | null;
  errorMessage: string | null;
};

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function describeFailure(d: IncidentDetail): string {
  if (d.status === 'timeout') return 'Request timed out';
  if (d.status === 'error') return d.errorMessage ? `Connection error: ${d.errorMessage}` : 'Connection error';
  if (d.statusCode != null) return `HTTP ${d.statusCode}`;
  return 'Check failed';
}

function detailMeta(d: IncidentDetail): Record<string, unknown> {
  return { status: d.status, statusCode: d.statusCode, errorMessage: d.errorMessage };
}

export async function findOpenIncident(tx: Tx, serviceId: string): Promise<Incident | null> {
  const rows = await tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.serviceId, serviceId), isNull(incidents.resolvedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function openIncident(
  tx: Tx,
  a: { serviceId: string; startedAt: Date; triggerCheckId: string; detail: IncidentDetail },
): Promise<Incident> {
  const rows = await tx
    .insert(incidents)
    .values({ serviceId: a.serviceId, startedAt: a.startedAt, severity: 'down', triggerCheckId: a.triggerCheckId })
    .returning();
  const incident = rows[0];
  if (!incident) throw new Error('openIncident: no row returned');
  await tx.insert(incidentEvents).values({
    incidentId: incident.id,
    occurredAt: a.startedAt,
    eventType: 'opened',
    message: describeFailure(a.detail),
    metadata: detailMeta(a.detail),
  });
  return incident;
}

export async function recordObservationIfChanged(
  tx: Tx,
  a: { incidentId: string; detail: IncidentDetail; occurredAt: Date },
): Promise<boolean> {
  const last = await tx
    .select({ metadata: incidentEvents.metadata })
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, a.incidentId))
    .orderBy(desc(incidentEvents.occurredAt))
    .limit(1);
  const prev = last[0]?.metadata as Record<string, unknown> | null | undefined;
  const next = detailMeta(a.detail);
  if (prev && prev.status === next.status && prev.statusCode === next.statusCode && prev.errorMessage === next.errorMessage) {
    return false;
  }
  await tx.insert(incidentEvents).values({
    incidentId: a.incidentId,
    occurredAt: a.occurredAt,
    eventType: 'observed',
    message: describeFailure(a.detail),
    metadata: next,
  });
  return true;
}

export async function resolveIncident(
  tx: Tx,
  a: { incidentId: string; startedAt: Date; resolvedAt: Date; resolutionCheckId: string | null; closeEvent: { type: 'resolved' | 'note'; message: string } },
): Promise<{ durationSeconds: number }> {
  const durationSeconds = Math.max(0, Math.floor((a.resolvedAt.getTime() - a.startedAt.getTime()) / 1000));
  await tx
    .update(incidents)
    .set({ resolvedAt: a.resolvedAt, durationSeconds, resolutionCheckId: a.resolutionCheckId, updatedAt: a.resolvedAt })
    .where(eq(incidents.id, a.incidentId));
  await tx.insert(incidentEvents).values({
    incidentId: a.incidentId,
    occurredAt: a.resolvedAt,
    eventType: a.closeEvent.type,
    message: a.closeEvent.message,
    metadata: null,
  });
  return { durationSeconds };
}

export type IncidentListRow = {
  id: string;
  serviceId: string;
  serviceName: string;
  severity: 'down';
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
};

export async function listIncidents(userId: string, opts: { serviceId?: string; open?: boolean }): Promise<IncidentListRow[]> {
  const conds = [eq(services.userId, userId)];
  if (opts.serviceId) conds.push(eq(incidents.serviceId, opts.serviceId));
  if (opts.open) conds.push(isNull(incidents.resolvedAt));
  const rows = await db
    .select({
      id: incidents.id, serviceId: incidents.serviceId, serviceName: services.name,
      severity: incidents.severity, startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt, durationSeconds: incidents.durationSeconds,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .where(and(...conds))
    .orderBy(desc(incidents.startedAt));
  return rows.map((r) => ({
    id: r.id, serviceId: r.serviceId, serviceName: r.serviceName, severity: 'down',
    startedAt: r.startedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    durationSeconds: r.durationSeconds,
  }));
}

export async function getIncidentWithEvents(userId: string, incidentId: string) {
  const list = await listIncidents(userId, {});
  const incident = list.find((i) => i.id === incidentId);
  if (!incident) return null;
  const events = await db
    .select({ id: incidentEvents.id, occurredAt: incidentEvents.occurredAt, eventType: incidentEvents.eventType, message: incidentEvents.message, metadata: incidentEvents.metadata })
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, incidentId))
    .orderBy(incidentEvents.occurredAt);
  return {
    incident,
    events: events.map((e) => ({ id: e.id, occurredAt: e.occurredAt.toISOString(), eventType: e.eventType, message: e.message, metadata: (e.metadata as Record<string, unknown> | null) })),
  };
}
