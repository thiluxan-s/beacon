import { Hono } from 'hono';
import { z } from 'zod';
import type { HealthResponse } from '@beacon/shared';
import { env } from './lib/env';
import { upsertFromClerk } from './db/repositories/users';

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

  return app;
}
