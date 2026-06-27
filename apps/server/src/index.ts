import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { createRouter } from './router';

const app = new Hono();
app.use('*', cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.route('/', createRouter());

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[beacon-server] listening on http://localhost:${info.port}`);
});
