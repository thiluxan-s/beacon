import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type DomainDto = {
  id: string;
  domain: string;
  currentStatus: 'pending' | 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';
  sslExpiresAt: string | null;
  domainExpiresAt: string | null;
  sslIssuer: string | null;
  lastCheckAt: string | null;
  isPublic: boolean;
};

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchDomains(clerkUserId: string): Promise<DomainDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchDomains failed: ${res.status}`);
  return (await res.json()).domains as DomainDto[];
}

export async function createDomainOnServer(clerkUserId: string, input: { domain: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains`, { method: 'POST', headers: headers(clerkUserId), body: JSON.stringify(input), cache: 'no-store' });
  if (res.ok) return { ok: true };
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: err.error ?? `Request failed (${res.status})` };
}

export async function deleteDomainOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}`, { method: 'DELETE', headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok && res.status !== 404) throw new Error(`deleteDomain failed: ${res.status}`);
}

export async function recheckDomainOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}/recheck`, { method: 'POST', headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`recheckDomain failed: ${res.status}`);
}

export async function setDomainPublicOnServer(clerkUserId: string, id: string, isPublic: boolean): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/domains/${id}/visibility`, {
    method: 'POST',
    headers: headers(clerkUserId),
    body: JSON.stringify({ isPublic }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`setDomainPublic failed: ${res.status}`);
}
