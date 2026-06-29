import { Hono } from 'hono';
import { z } from 'zod';
import type { HealthResponse } from '@beacon/shared';
import { ServiceCreateSchema, ServiceUpdateSchema } from '@beacon/shared';
import { env } from './lib/env';
import { getByClerkId, upsertFromClerk } from './db/repositories/users';
import { createService, deleteService, getService, listServicesByUser, setPaused, updateService } from './db/repositories/services';

const UpsertUserSchema = z.object({ clerkUserId: z.string().min(1), email: z.string().email() });

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

  app.post('/internal/services/:id/pause', async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unknown user' }, 401);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (typeof body?.paused !== 'boolean') return c.json({ error: 'invalid body' }, 400);
    const svc = await setPaused(userId, c.req.param('id'), body.paused);
    return svc ? c.json(svc) : c.json({ error: 'not found' }, 404);
  });

  return app;
}
