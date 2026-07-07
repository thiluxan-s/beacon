import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../index';
import { alertsSent, incidentEvents, incidents, notificationSettings, services, users } from '../schema';
import type { AlertTarget } from '../../lib/email';

type Kind = 'opened' | 'resolved';

export async function findIncidentsNeedingOpenAlert(limit: number): Promise<AlertTarget[]> {
  const rows = await db
    .select({
      incidentId: incidents.id,
      serviceName: services.name,
      startedAt: incidents.startedAt,
      failureDetail: incidentEvents.message,
      userEmail: users.email,
      alertEmail: notificationSettings.alertEmail,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .innerJoin(users, eq(services.userId, users.id))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .innerJoin(
      incidentEvents,
      and(eq(incidentEvents.incidentId, incidents.id), eq(incidentEvents.eventType, 'opened')),
    )
    .where(
      and(
        isNull(incidents.resolvedAt),
        eq(incidents.notificationSent, false),
        eq(services.alertsEnabled, true),
        sql`COALESCE(${notificationSettings.alertsEnabled}, true) = true`,
      ),
    )
    .orderBy(incidents.startedAt)
    .limit(limit);

  return rows.map((r) => ({
    incidentId: r.incidentId,
    serviceName: r.serviceName,
    failureDetail: r.failureDetail,
    startedAt: r.startedAt,
    resolvedAt: null,
    durationSeconds: null,
    toEmail: r.alertEmail ?? r.userEmail,
  }));
}

export async function findIncidentsNeedingResolveAlert(limit: number): Promise<AlertTarget[]> {
  const rows = await db
    .select({
      incidentId: incidents.id,
      serviceName: services.name,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      durationSeconds: incidents.durationSeconds,
      userEmail: users.email,
      alertEmail: notificationSettings.alertEmail,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .innerJoin(users, eq(services.userId, users.id))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(
      and(
        isNotNull(incidents.resolvedAt),
        eq(incidents.notificationSent, true),
        isNotNull(incidents.resolutionCheckId),
        sql`NOT EXISTS (SELECT 1 FROM alerts_sent a WHERE a.incident_id = ${incidents.id} AND a.channel = 'email' AND a.kind = 'resolved' AND a.status = 'sent')`,
      ),
    )
    .orderBy(incidents.resolvedAt)
    .limit(limit);

  return rows.map((r) => ({
    incidentId: r.incidentId,
    serviceName: r.serviceName,
    failureDetail: '',
    startedAt: r.startedAt,
    resolvedAt: r.resolvedAt,
    durationSeconds: r.durationSeconds,
    toEmail: r.alertEmail ?? r.userEmail,
  }));
}

export async function markOpenNotifiedAndRecord(incidentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(incidents).set({ notificationSent: true, updatedAt: new Date() }).where(eq(incidents.id, incidentId));
    await tx.insert(alertsSent).values({ incidentId, channel: 'email', kind: 'opened', status: 'sent' });
  });
}

export async function recordAlertSent(incidentId: string, kind: Kind): Promise<void> {
  await db.insert(alertsSent).values({ incidentId, channel: 'email', kind, status: 'sent' });
}

export async function recordAlertFailed(incidentId: string, kind: Kind): Promise<void> {
  await db.insert(alertsSent).values({ incidentId, channel: 'email', kind, status: 'failed' });
}
