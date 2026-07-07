import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { incidentEvents, incidents, serviceChecks, services } from '../schema';
import { upsertFromClerk } from './users';
import { upsertSettings } from './notification-settings';
import {
  findIncidentsNeedingOpenAlert, findIncidentsNeedingResolveAlert,
  markOpenNotifiedAndRecord, recordAlertSent, recordAlertFailed,
} from './alerts';

async function seed(opts: { alertsEnabled?: boolean; svcAlerts?: boolean } = {}) {
  const u = await upsertFromClerk({ clerkUserId: 'a_user', email: 'me@e.com' });
  if (opts.alertsEnabled === false) await upsertSettings(u.id, { alertsEnabled: false });
  const [svc] = await db.insert(services).values({
    userId: u.id, name: 'Demo', baseUrl: 'https://x.com', healthCheckPath: '/',
    currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date(),
    alertsEnabled: opts.svcAlerts ?? true,
  }).returning();
  const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
  return { userId: u.id, service: svc!, checkId: chk!.id };
}
// Open incident with its 'opened' event, mimicking 5a's openIncident.
async function openInc(serviceId: string, checkId: string) {
  const [inc] = await db.insert(incidents).values({ serviceId, startedAt: new Date(), severity: 'down', triggerCheckId: checkId }).returning();
  await db.insert(incidentEvents).values({ incidentId: inc!.id, occurredAt: new Date(), eventType: 'opened', message: 'HTTP 500', metadata: { status: 'failure', statusCode: 500, errorMessage: null } });
  return inc!;
}

describe('alerts repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('open-needed picks an open, un-alerted incident with alerts on', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    const t = await findIncidentsNeedingOpenAlert(10);
    expect(t).toHaveLength(1);
    expect(t[0]!.incidentId).toBe(inc.id);
    expect(t[0]!.serviceName).toBe('Demo');
    expect(t[0]!.failureDetail).toBe('HTTP 500');
    expect(t[0]!.toEmail).toBe('me@e.com');
  });

  it('open-needed excludes when global alerts off or service alerts off', async () => {
    const off = await seed({ alertsEnabled: false });
    await openInc(off.service.id, off.checkId);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
    await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
    const svcOff = await seed({ svcAlerts: false });
    await openInc(svcOff.service.id, svcOff.checkId);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
  });

  it('markOpenNotifiedAndRecord marks the incident and removes it from open-needed', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await markOpenNotifiedAndRecord(inc.id);
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(0);
    // second call would violate the partial-unique on (incident,email,opened,sent)
    await expect(markOpenNotifiedAndRecord(inc.id)).rejects.toThrow();
  });

  it('resolve-needed requires open-alerted + self-recovery, excludes pause-resolves', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await markOpenNotifiedAndRecord(inc.id);
    // pause-style resolve: resolution_check_id null
    await db.update(incidents).set({ resolvedAt: new Date(), durationSeconds: 10, resolutionCheckId: null }).where(eq(incidents.id, inc.id));
    expect(await findIncidentsNeedingResolveAlert(10)).toHaveLength(0);
    // real recovery: resolution_check_id set
    await db.update(incidents).set({ resolutionCheckId: checkId }).where(eq(incidents.id, inc.id));
    const t = await findIncidentsNeedingResolveAlert(10);
    expect(t).toHaveLength(1);
    expect(t[0]!.durationSeconds).toBe(10);
    // once resolved-sent recorded, it drops out
    await recordAlertSent(inc.id, 'resolved');
    expect(await findIncidentsNeedingResolveAlert(10)).toHaveLength(0);
  });

  it('recordAlertFailed does not satisfy dedup (still needs the alert)', async () => {
    const { service, checkId } = await seed();
    const inc = await openInc(service.id, checkId);
    await recordAlertFailed(inc.id, 'opened');
    expect(await findIncidentsNeedingOpenAlert(10)).toHaveLength(1); // notification_sent still false
  });
});
