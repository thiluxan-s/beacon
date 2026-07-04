import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pool } from '../db/index';
import { upsertFromClerk } from '../db/repositories/users';
import { createService } from '../db/repositories/services';
import { upsertIntegration, getIntegration } from '../db/repositories/service-integrations';
import { encrypt } from '../lib/crypto';
import type { IntegrationDefinition } from '../integrations/types';
import { processDueIntegrations } from './integration-worker';

const svcInput = { name: 'S', baseUrl: 'https://s.com', healthCheckPath: '/', expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10 };

function fakeDef(behavior: 'ok' | 'throw'): IntegrationDefinition {
  return {
    id: 'faker',
    name: 'Faker',
    credentialsSchema: z.object({ apiToken: z.string() }),
    configSchema: z.object({}),
    async testCredentials() { return { ok: true }; },
    async fetchData() {
      if (behavior === 'throw') throw new Error('kaboom');
      return { ok: 1 };
    },
  };
}

describe('processDueIntegrations', () => {
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await pool.end(); });

  async function seed(): Promise<{ userId: string; serviceId: string }> {
    const u = await upsertFromClerk({ clerkUserId: 'u_w', email: 'w@e.com' });
    const svc = await createService(u.id, svcInput);
    await upsertIntegration({ serviceId: svc.id, integrationId: 'faker', config: {}, credentialsEncrypted: encrypt(JSON.stringify({ apiToken: 't' })) });
    return { userId: u.id, serviceId: svc.id };
  }

  it('persists a snapshot on success', async () => {
    const { userId, serviceId } = await seed();
    await processDueIntegrations({ registry: new Map([['faker', fakeDef('ok')]]) });
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastSnapshot).toEqual({ ok: 1 });
    expect(row!.lastError).toBeNull();
  });

  it('records last_error on failure without throwing', async () => {
    const { userId, serviceId } = await seed();
    await expect(processDueIntegrations({ registry: new Map([['faker', fakeDef('throw')]]) })).resolves.toBeUndefined();
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastError).toContain('kaboom');
  });

  it('skips integrations whose id is not in the registry', async () => {
    const { userId, serviceId } = await seed();
    await processDueIntegrations({ registry: new Map() }); // faker not registered
    const row = await getIntegration(userId, serviceId, 'faker');
    expect(row!.lastSnapshot).toBeNull();
    expect(row!.lastError).toContain('Unknown integration');
  });
});
