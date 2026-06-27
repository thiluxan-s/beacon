import { Hono } from 'hono';
import type { HealthResponse } from '@beacon/shared';

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

  return app;
}
