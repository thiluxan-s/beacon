import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../index';
import { serviceChecks, services } from '../schema';
import { upsertFromClerk } from './users';
import {
  describeFailure, findOpenIncident, openIncident, recordObservationIfChanged,
  resolveIncident, listIncidents, listPublicIncidents, getIncidentWithEvents, type IncidentDetail,
} from './incidents';
import { updateService } from './services';

async function seedService(clerkId = 'inc_user') {
  const u = await upsertFromClerk({ clerkUserId: clerkId, email: `${clerkId}@e.com` });
  const [svc] = await db.insert(services).values({
    userId: u.id, name: 'Svc', baseUrl: 'https://x.com', healthCheckPath: '/',
    currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date(),
  }).returning();
  return { userId: u.id, service: svc! };
}
async function seedCheck(serviceId: string) {
  const [c] = await db.insert(serviceChecks).values({ serviceId, status: 'failure', statusCode: 500 }).returning();
  return c!.id;
}
const detail500: IncidentDetail = { status: 'failure', statusCode: 500, errorMessage: null };
const detail503: IncidentDetail = { status: 'failure', statusCode: 503, errorMessage: null };

describe('incidents repository (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('describeFailure renders human strings', () => {
    expect(describeFailure(detail500)).toBe('HTTP 500');
    expect(describeFailure({ status: 'timeout', statusCode: null, errorMessage: null })).toBe('Request timed out');
    expect(describeFailure({ status: 'error', statusCode: null, errorMessage: 'ECONNREFUSED' })).toBe('Connection error: ECONNREFUSED');
  });

  it('opens an incident with an opened event and finds it', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    const startedAt = new Date();
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt, triggerCheckId: checkId, detail: detail500 }));
    expect(inc.severity).toBe('down');
    expect(inc.triggerCheckId).toBe(checkId);
    const open = await db.transaction((tx) => findOpenIncident(tx, service.id));
    expect(open?.id).toBe(inc.id);
  });

  it('records observed only when detail changes', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
    const same = await db.transaction((tx) => recordObservationIfChanged(tx, { incidentId: inc.id, detail: detail500, occurredAt: new Date() }));
    expect(same).toBe(false);
    const changed = await db.transaction((tx) => recordObservationIfChanged(tx, { incidentId: inc.id, detail: detail503, occurredAt: new Date() }));
    expect(changed).toBe(true);
  });

  it('resolves with duration and a resolved event', async () => {
    const { userId, service } = await seedService();
    const checkId = await seedCheck(service.id);
    const startedAt = new Date(Date.now() - 65_000);
    const inc = await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt, triggerCheckId: checkId, detail: detail500 }));
    const res = await db.transaction((tx) => resolveIncident(tx, { incidentId: inc.id, startedAt, resolvedAt: new Date(), resolutionCheckId: checkId, closeEvent: { type: 'resolved', message: 'Service recovered' } }));
    expect(res.durationSeconds).toBeGreaterThanOrEqual(64);
    const detail = await getIncidentWithEvents(userId, inc.id);
    expect(detail?.incident.resolvedAt).not.toBeNull();
    expect(detail?.events.map((e) => e.eventType)).toContain('resolved');
  });

  it('one open incident per service invariant', async () => {
    const { service } = await seedService();
    const checkId = await seedCheck(service.id);
    await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
    await expect(
      db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 })),
    ).rejects.toThrow();
  });

  it('listIncidents filters by service and open, scoped to owner', async () => {
    const { userId, service } = await seedService('owner');
    const other = await seedService('intruder');
    const c1 = await seedCheck(service.id);
    await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: c1, detail: detail500 }));
    const all = await listIncidents(userId, {});
    expect(all).toHaveLength(1);
    expect(all[0]!.serviceName).toBe('Svc');
    const open = await listIncidents(userId, { open: true });
    expect(open).toHaveLength(1);
    const foreign = await listIncidents(other.userId, {});
    expect(foreign).toHaveLength(0);
  });

  it('listPublicIncidents includes only incidents of public services', async () => {
    const { userId, service } = await seedService('pi_owner');
    const checkId = await seedCheck(service.id);
    await db.transaction((tx) => openIncident(tx, { serviceId: service.id, startedAt: new Date(), triggerCheckId: checkId, detail: detail500 }));
    expect(await listPublicIncidents()).toHaveLength(0); // service not public yet
    await updateService(userId, service.id, { isPublic: true });
    const pub = await listPublicIncidents();
    expect(pub).toHaveLength(1);
    expect(pub[0]!.serviceName).toBe('Svc');
  });
});
