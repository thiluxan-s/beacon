import { randomUUID } from 'node:crypto';
import type { WsEvent } from '@beacon/shared';
import { getService, isServicePublic as repoIsServicePublic } from '../db/repositories/services';

export type WsLike = { send(data: string): void; readyState?: number };

type Conn = { ws: WsLike; userId: string; topics: Set<string>; public: boolean };

export class ConnectionHub {
  private conns = new Map<string, Conn>();

  add(ws: WsLike, userId: string, isPublic = false): string {
    const id = randomUUID();
    this.conns.set(id, { ws, userId, topics: new Set(), public: isPublic });
    return id;
  }

  remove(connId: string): void {
    this.conns.delete(connId);
  }

  async subscribe(
    connId: string,
    topic: string,
    deps: {
      canAccessService?: (userId: string, serviceId: string) => Promise<boolean>;
      isServicePublic?: (serviceId: string) => Promise<boolean>;
    } = {},
  ): Promise<boolean> {
    const conn = this.conns.get(connId);
    if (!conn) return false;

    // A public (anonymous) connection is receive-only and scoped to public service
    // topics — global and private-service topics are refused.
    if (conn.public) {
      if (topic === 'global') return false;
      const m = /^service:(.+)$/.exec(topic);
      if (!m) return false;
      const isPublic = deps.isServicePublic ?? repoIsServicePublic;
      if (!(await isPublic(m[1]!))) return false;
      conn.topics.add(topic);
      return true;
    }

    if (topic !== 'global') {
      const m = /^service:(.+)$/.exec(topic);
      if (!m) return false;
      const canAccess = deps.canAccessService ?? (async (uid, sid) => (await getService(uid, sid)) !== null);
      if (!(await canAccess(conn.userId, m[1]!))) return false;
    }
    conn.topics.add(topic);
    return true;
  }

  unsubscribe(connId: string, topic: string): void {
    this.conns.get(connId)?.topics.delete(topic);
  }

  broadcast(event: WsEvent): void {
    const data = JSON.stringify(event);
    const serviceTopic = `service:${event.serviceId}`;
    for (const conn of this.conns.values()) {
      if (conn.userId !== event.userId) continue;
      if (conn.topics.has('global') || conn.topics.has(serviceTopic)) {
        try {
          conn.ws.send(data);
        } catch {
          // a dead socket is cleaned up by the heartbeat / close handler; never let it break the loop
        }
      }
    }
  }
}
