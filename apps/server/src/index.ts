import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { createRouter } from './router';
import { ConnectionHub } from './ws/connections';
import { attachWebSocketServer } from './ws/server';
import { startEventListener } from './ws/listener';

const app = new Hono();
app.use('*', cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.route('/', createRouter());

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[beacon-server] listening on http://localhost:${info.port}`);
});

const hub = new ConnectionHub();
attachWebSocketServer(server as unknown as import('node:http').Server, hub);
startEventListener(hub)
  .then(() => console.log('[beacon-server] LISTEN beacon_events started'))
  .catch((err) => console.error('[beacon-server] failed to start LISTEN relay', err));
