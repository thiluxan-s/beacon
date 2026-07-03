import type { WsEvent } from '@beacon/shared';

export function nextBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';
type Handler = (event: WsEvent) => void;

export class BeaconSocket {
  private ws: WebSocket | null = null;
  private topics = new Map<string, Set<Handler>>();
  private attempt = 0;
  private stateCbs = new Set<(s: ConnectionState) => void>();
  state: ConnectionState = 'disconnected';

  constructor(private opts: { url: string; getToken: () => Promise<string | null> }) {}

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  async connect(): Promise<void> {
    const token = await this.opts.getToken();
    if (!token) {
      this.setState('disconnected');
      return;
    }
    const ws = new WebSocket(`${this.opts.url}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.setState('connected');
      for (const topic of this.topics.keys()) ws.send(JSON.stringify({ type: 'subscribe', topic }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WsEvent;
        const handlers =
          data.type === 'service.status_changed'
            ? this.topics.get(`service:${data.serviceId}`)
            : undefined;
        for (const h of this.topics.get('global') ?? []) h(data);
        for (const h of handlers ?? []) h(data);
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener('close', () => this.scheduleReconnect());
    ws.addEventListener('error', () => ws.close());
  }

  private scheduleReconnect() {
    this.setState('reconnecting');
    const delay = nextBackoffMs(this.attempt++);
    setTimeout(() => void this.connect(), delay);
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', topic }));
    }
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.topics.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'unsubscribe', topic }));
        }
      }
    };
  }
}
