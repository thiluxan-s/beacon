import { Client } from 'pg';
import { WsEventSchema, type WsEvent } from '@beacon/shared';
import { env } from '../lib/env';

export async function startEventListener(
  hub: { broadcast(e: WsEvent): void },
  deps: { connectionString?: string } = {},
): Promise<{ stop(): Promise<void> }> {
  const connectionString = deps.connectionString ?? env.DATABASE_URL;
  let stopped = false;
  let client: Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-arm a single pending reconnect. Guarded so a client emitting both
  // 'error' and 'end' (or a stale client firing after teardown) can't spawn
  // overlapping connect loops. Any connect that rejects re-schedules itself,
  // so a DB outage retries indefinitely instead of crashing the process.
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(scheduleReconnect);
    }, 1000);
  }

  async function connect(): Promise<void> {
    const c = new Client({ connectionString });
    client = c;
    c.on('notification', (msg) => {
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
    c.on('error', (err) => {
      console.error('[beacon-ws] LISTEN client error', err);
      scheduleReconnect();
    });
    c.on('end', () => {
      scheduleReconnect();
    });
    await c.connect();
    await c.query('LISTEN beacon_events');
  }

  // A failed initial connect must not crash boot — retry in the background so
  // the server stays up (and the rest of the app works) while Postgres recovers.
  try {
    await connect();
  } catch (err) {
    console.error('[beacon-ws] initial LISTEN connect failed; will retry', err);
    scheduleReconnect();
  }

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (client) await client.end().catch(() => undefined);
    },
  };
}
