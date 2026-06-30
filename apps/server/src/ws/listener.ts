import { Client } from 'pg';
import { WsEventSchema, type WsEvent } from '@beacon/shared';
import { env } from '../lib/env';

export async function startEventListener(
  hub: { broadcast(e: WsEvent): void },
  deps: { connectionString?: string } = {},
): Promise<{ stop(): Promise<void> }> {
  const connectionString = deps.connectionString ?? env.DATABASE_URL;
  let stopped = false;
  let client: Client;

  async function connect(): Promise<void> {
    client = new Client({ connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== 'beacon_events' || !msg.payload) return;
      let json: unknown;
      try {
        json = JSON.parse(msg.payload);
      } catch {
        console.error('[beacon-ws] non-JSON beacon_events payload');
        return;
      }
      const parsed = WsEventSchema.safeParse(json);
      if (parsed.success) hub.broadcast(parsed.data);
      else console.error('[beacon-ws] dropped invalid beacon_events payload');
    });
    client.on('error', (err) => {
      console.error('[beacon-ws] LISTEN client error', err);
    });
    client.on('end', () => {
      if (!stopped) setTimeout(() => void connect(), 1000); // reconnect with a small backoff
    });
    await client.connect();
    await client.query('LISTEN beacon_events');
  }

  await connect();
  return {
    async stop() {
      stopped = true;
      await client.end();
    },
  };
}
