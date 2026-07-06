import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pool } from '../db/index';
import { alertsSent, incidentEvents, incidents, serviceChecks, services } from '../db/schema';
import { eq } from 'drizzle-orm';
import { upsertFromClerk } from '../db/repositories/users';
import { processAlertsOnce } from './alert-worker';

async function seedOpen() {
  const u = await upsertFromClerk({ clerkUserId: 'w_user', email: 'me@e.com' });
  const [svc] = await db.insert(services).values({ userId: u.id, name: 'Demo', baseUrl: 'https://x.com', healthCheckPath: '/', currentStatus: 'down', currentStatusSince: new Date(), nextCheckAt: new Date() }).returning();
  const [chk] = await db.insert(serviceChecks).values({ serviceId: svc!.id, status: 'failure', statusCode: 500 }).returning();
  const [inc] = await db.insert(incidents).values({ serviceId: svc!.id, startedAt: new Date(), severity: 'down', triggerCheckId: chk!.id }).returning();
  await db.insert(incidentEvents).values({ incidentId: inc!.id, occurredAt: new Date(), eventType: 'opened', message: 'HTTP 500', metadata: null });
  return { inc: inc!, checkId: chk!.id };
}

describe('alert reconciler (integration)', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('sends one open email and marks it; a second pass sends nothing', async () => {
    const { inc } = await seedOpen();
    const send = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(send);
    expect(send).toHaveBeenCalledTimes(1);
    const marked = (await db.select().from(incidents).where(eq(incidents.id, inc.id)))[0]!;
    expect(marked.notificationSent).toBe(true);
    await processAlertsOnce(send);
    expect(send).toHaveBeenCalledTimes(1); // dedup: no second send
  });

  it('a failed send records failed and retries next pass', async () => {
    await seedOpen();
    const send = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
    await processAlertsOnce(send);
    const rows = await db.select().from(alertsSent);
    expect(rows.some((r) => r.status === 'failed' && r.kind === 'opened')).toBe(true);
    // still needs it: a subsequent OK send delivers
    const ok = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('sends a resolve email only for a self-recovered, open-alerted incident', async () => {
    const { inc, checkId } = await seedOpen();
    const send = vi.fn(async () => ({ ok: true as const }));
    await processAlertsOnce(send); // open alert
    await db.update(incidents).set({ resolvedAt: new Date(), durationSeconds: 12, resolutionCheckId: checkId }).where(eq(incidents.id, inc.id));
    await processAlertsOnce(send); // resolve alert
    expect(send).toHaveBeenCalledTimes(2);
    const resolved = await db.select().from(alertsSent).where(eq(alertsSent.kind, 'resolved'));
    expect(resolved).toHaveLength(1);
  });
});
