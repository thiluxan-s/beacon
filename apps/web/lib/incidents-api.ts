import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type IncidentDto = {
  id: string;
  serviceId: string;
  serviceName: string;
  severity: 'down';
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
};

export type IncidentEventDto = {
  id: string;
  occurredAt: string;
  eventType: 'opened' | 'observed' | 'resolved' | 'note';
  message: string;
  metadata: Record<string, unknown> | null;
};

export type IncidentDetailDto = { incident: IncidentDto; events: IncidentEventDto[] };

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchIncidents(clerkUserId: string, opts: { serviceId?: string; open?: boolean } = {}): Promise<IncidentDto[]> {
  const qs = new URLSearchParams();
  if (opts.serviceId) qs.set('serviceId', opts.serviceId);
  if (opts.open) qs.set('open', 'true');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${serverApiBaseUrl()}/internal/incidents${suffix}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchIncidents failed: ${res.status}`);
  return (await res.json()).incidents as IncidentDto[];
}

export async function fetchIncident(clerkUserId: string, id: string): Promise<IncidentDetailDto | null> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/incidents/${id}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchIncident failed: ${res.status}`);
  return (await res.json()) as IncidentDetailDto;
}
