import { Hono } from 'hono';
import { z } from 'zod';
import type { HealthResponse } from '@beacon/shared';
import { ServiceCreateSchema, ServiceUpdateSchema, NotificationSettingsUpdateSchema } from '@beacon/shared';
import { env } from './lib/env';
import { getByClerkId, upsertFromClerk } from './db/repositories/users';
import { createService, deleteService, getService, listChecks, listServicesByUser, setPaused, updateService } from './db/repositories/services';
import { IntegrationRegistry } from './integrations/registry';
import type { IntegrationDefinition } from './integrations/types';
import { encrypt } from './lib/crypto';
import { upsertIntegration, listIntegrations, deleteIntegration } from './db/repositories/service-integrations';
import type { ServiceIntegration } from './db/repositories/service-integrations';
import { listIncidents, getIncidentWithEvents } from './db/repositories/incidents';
import { getResolvedSettings, upsertSettings } from './db/repositories/notification-settings';

const UpsertUserSchema = z.object({ clerkUserId: z.string().min(1), email: z.string().email() });

const AttachSchema = z.object({
  integrationId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), z.unknown()),
});

function toIntegrationDto(row: ServiceIntegration) {
  return {
    integrationId: row.integrationId,
    config: row.config,
    enabled: row.enabled,
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    lastError: row.lastError,
    snapshot: row.lastSnapshot ?? null,
  };
}

function toCatalogDto(def: IntegrationDefinition) {
  return { id: def.id, name: def.name, fields: def.fields };
}

export function createRouter(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'beacon-server',
      time: new Date().toISOString(),
    };
    return c.json(body);
  });

  app.post('/internal/users/upsert', async (c) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = UpsertUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      const user = await upsertFromClerk(parsed.data);
      return c.json(user);
    } catch (err) {
      console.error('[beacon-server] upsert user failed', err);
      return c.json({ error: 'could not upsert user' }, 500);
    }
  });

  // All /internal/services* routes require the shared secret + a resolvable user.
  app.use('/internal/services/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  app.use('/internal/services', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // /internal/incidents* routes require the shared secret + a resolvable user.
  app.use('/internal/incidents', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  app.use('/internal/incidents/*', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  // /internal/notification-settings has no sub-segments, so one exact-path guard covers GET + PUT.
  app.use('/internal/notification-settings', async (c, next) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  async function resolveUserId(c: { req: { header: (k: string) => string | undefined } }): Promise<string | null> {
    const clerkId = c.req.header('x-clerk-user-id');
    if (!clerkId) return null;
    const user = await getByClerkId(clerkId);
    return user?.id ?? null;
  }

  app.get('/internal/services', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json({ services: await listServicesByUser(userId) });
  });

  app.post('/internal/services', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = ServiceCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const svc = await createService(userId, parsed.data);
    return c.json(svc, 201);
  });

  app.get('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const svc = await getService(userId, c.req.param('id'));
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = ServiceUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const svc = await updateService(userId, c.req.param('id'), parsed.data);
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/internal/services/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const ok = await deleteService(userId, c.req.param('id'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  app.get('/internal/services/:id/checks', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const checks = await listChecks(userId, c.req.param('id'), limit);
    return c.json({ checks });
  });

  app.get('/internal/services/:id/integrations', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const rows = await listIntegrations(userId, c.req.param('id'));
    return c.json({ integrations: rows.map(toIntegrationDto) });
  });

  app.post('/internal/services/:id/integrations', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const serviceId = c.req.param('id');
    if (!(await getService(userId, serviceId))) return c.json({ error: 'not found' }, 404);

    const parsed = AttachSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);

    const def = IntegrationRegistry.get(parsed.data.integrationId);
    if (!def) return c.json({ error: 'unknown integration' }, 400);

    const config = def.configSchema.safeParse(parsed.data.config);
    if (!config.success) return c.json({ error: 'invalid config', issues: config.error.issues }, 400);
    const creds = def.credentialsSchema.safeParse(parsed.data.credentials);
    if (!creds.success) return c.json({ error: 'invalid credentials' }, 400);

    const test = await def.testCredentials(creds.data, config.data);
    if (!test.ok) return c.json({ error: test.error }, 400);

    const row = await upsertIntegration({
      serviceId,
      integrationId: def.id,
      config: config.data as Record<string, unknown>,
      credentialsEncrypted: encrypt(JSON.stringify(creds.data)),
    });
    return c.json(toIntegrationDto(row), 201);
  });

  app.delete('/internal/services/:id/integrations/:integrationId', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const ok = await deleteIntegration(userId, c.req.param('id'), c.req.param('integrationId'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  app.get('/internal/integrations', async (c) => {
    if (c.req.header('x-internal-secret') !== env.INTERNAL_API_SECRET) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json({ integrations: [...IntegrationRegistry.values()].map(toCatalogDto) });
  });

  app.post('/internal/services/:id/pause', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (typeof body?.paused !== 'boolean') return c.json({ error: 'invalid body' }, 400);
    const svc = await setPaused(userId, c.req.param('id'), body.paused);
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  app.get('/internal/incidents', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const serviceId = c.req.query('serviceId') || undefined;
    const open = c.req.query('open') === 'true';
    return c.json({ incidents: await listIncidents(userId, { serviceId, open }) });
  });

  app.get('/internal/incidents/:id', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const detail = await getIncidentWithEvents(userId, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  app.get('/internal/notification-settings', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    return c.json(await getResolvedSettings(userId));
  });

  app.put('/internal/notification-settings', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const parsed = NotificationSettingsUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    await upsertSettings(userId, parsed.data);
    return c.json(await getResolvedSettings(userId));
  });

  return app;
}
