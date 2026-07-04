import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../index';
import { upsertFromClerk } from './users';
import { createService } from './services';
import {
  upsertIntegration,
  listIntegrations,
  getIntegration,
  deleteIntegration,
  findDueIntegrations,
  recordFetchSuccess,
  recordFetchError,
} from './service-integrations';

const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };

describe('service-integrations repository', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  it('upserts (one row per service+integration) and lists with ownership', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_i', email: 'i@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p1' }, credentialsEncrypted: 'enc1' });
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p2' }, credentialsEncrypted: 'enc2' });
    const rows = await listIntegrations(u.id, svc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config).toEqual({ projectId: 'p2' });
    expect(rows[0]!.credentialsEncrypted).toBe('enc2');
  });

  it('getIntegration returns null for a non-owner', async () => {
    const owner = await upsertFromClerk({ clerkUserId: 'u_own', email: 'o@e.com' });
    const other = await upsertFromClerk({ clerkUserId: 'u_oth', email: 'x@e.com' });
    const svc = await createService(owner.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    expect(await getIntegration(other.id, svc.id, 'vercel')).toBeNull();
    expect(await getIntegration(owner.id, svc.id, 'vercel')).not.toBeNull();
  });

  it('records fetch success and error, and finds due rows', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_due', email: 'd@e.com' });
    const svc = await createService(u.id, svcInput);
    const row = await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    // never-fetched rows are due
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).toContain(row.id);
    await recordFetchSuccess(row.id, { deployments: [] });
    const after = await getIntegration(u.id, svc.id, 'vercel');
    expect(after!.lastSnapshot).toEqual({ deployments: [] });
    expect(after!.lastError).toBeNull();
    // just-fetched rows are no longer due
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).not.toContain(row.id);
    await recordFetchError(row.id, 'boom');
    expect((await getIntegration(u.id, svc.id, 'vercel'))!.lastError).toBe('boom');
  });

  it('re-attaching (re-upserting) an integration resets fetch state so it becomes due again', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_reattach', email: 'r@e.com' });
    const svc = await createService(u.id, svcInput);
    const row = await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p1' }, credentialsEncrypted: 'enc1' });
    await recordFetchSuccess(row.id, { deployments: ['old'] });
    // freshly fetched, so not due
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).not.toContain(row.id);

    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: { projectId: 'p2' }, credentialsEncrypted: 'enc2' });
    const after = await getIntegration(u.id, svc.id, 'vercel');
    expect(after!.lastSnapshot).toBeNull();
    expect(after!.lastFetchedAt).toBeNull();
    // re-attach clears fetch state, so it's due again immediately
    expect((await findDueIntegrations(5 * 60_000, 10)).map((r) => r.id)).toContain(row.id);
  });

  it('deleteIntegration removes only the owner\'s row', async () => {
    const u = await upsertFromClerk({ clerkUserId: 'u_del', email: 'del@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'vercel', config: {}, credentialsEncrypted: 'e' });
    expect(await deleteIntegration(u.id, svc.id, 'vercel')).toBe(true);
    expect(await listIntegrations(u.id, svc.id)).toHaveLength(0);
  });
});
