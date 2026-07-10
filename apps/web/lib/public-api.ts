import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type PublicServiceDto = { id: string; name: string; currentStatus: string; lastCheckAt: string | null };
export type PublicIncidentDto = { id: string; serviceId: string; serviceName: string; severity: 'down'; startedAt: string; resolvedAt: string | null; durationSeconds: number | null };
export type PublicDomainDto = { id: string; domain: string; currentStatus: string; sslExpiresAt: string | null; domainExpiresAt: string | null };

function headers(): HeadersInit {
  return { 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '' };
}

// Returns null when public mode is disabled (server answers 404) — the caller
// renders the "not enabled" state. Any other non-2xx is a real error.
async function get<T>(path: string, key: string): Promise<T[] | null> {
  const res = await fetch(`${serverApiBaseUrl()}${path}`, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json())[key] as T[];
}

export const fetchPublicServices = () => get<PublicServiceDto>('/internal/public/services', 'services');
export const fetchPublicIncidents = () => get<PublicIncidentDto>('/internal/public/incidents', 'incidents');
export const fetchPublicDomains = () => get<PublicDomainDto>('/internal/public/domains', 'domains');
