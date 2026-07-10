import 'server-only';
import type { ServiceCreateInput, ServiceStatus, ServiceUpdateInput } from '@beacon/shared';

import { serverApiBaseUrl } from './api-base';

export type ServiceDto = {
  id: string;
  name: string;
  description: string | null;
  baseUrl: string;
  healthCheckPath: string;
  currentStatus: ServiceStatus;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  paused: boolean;
  checkIntervalSeconds: number;
  timeoutSeconds: number;
  expectedStatusCodes: number[];
  alertsEnabled: boolean;
  isPublic: boolean;
};

function headers(clerkUserId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
    'x-clerk-user-id': clerkUserId,
  };
}

export async function fetchServices(clerkUserId: string): Promise<ServiceDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services`, {
    headers: headers(clerkUserId),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`fetchServices failed: ${res.status}`);
  return (await res.json()).services as ServiceDto[];
}

export async function createServiceOnServer(clerkUserId: string, input: ServiceCreateInput): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services`, {
    method: 'POST',
    headers: headers(clerkUserId),
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`createService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function updateServiceOnServer(clerkUserId: string, id: string, patch: ServiceUpdateInput): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, {
    method: 'PATCH',
    headers: headers(clerkUserId),
    body: JSON.stringify(patch),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`updateService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function deleteServiceOnServer(clerkUserId: string, id: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, {
    method: 'DELETE',
    headers: headers(clerkUserId),
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) throw new Error(`deleteService failed: ${res.status}`);
}

export async function pauseServiceOnServer(clerkUserId: string, id: string, paused: boolean): Promise<ServiceDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}/pause`, {
    method: 'POST',
    headers: headers(clerkUserId),
    body: JSON.stringify({ paused }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`pauseService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export type ServiceCheckDto = {
  id: string;
  serviceId: string;
  checkedAt: string;
  status: 'success' | 'failure' | 'timeout' | 'error';
  statusCode: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
};

export async function fetchService(clerkUserId: string, id: string): Promise<ServiceDto | null> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchService failed: ${res.status}`);
  return (await res.json()) as ServiceDto;
}

export async function fetchServiceChecks(clerkUserId: string, id: string, limit = 50): Promise<ServiceCheckDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${id}/checks?limit=${limit}`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchServiceChecks failed: ${res.status}`);
  return (await res.json()).checks as ServiceCheckDto[];
}

export type IntegrationDto = {
  integrationId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastError: string | null;
  snapshot: Record<string, unknown> | null;
};

export async function fetchIntegrations(clerkUserId: string, serviceId: string): Promise<IntegrationDto[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchIntegrations failed: ${res.status}`);
  return (await res.json()).integrations as IntegrationDto[];
}

export async function attachIntegration(
  clerkUserId: string,
  serviceId: string,
  body: { integrationId: string; config: Record<string, unknown>; credentials: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations`, {
    method: 'POST', headers: headers(clerkUserId), body: JSON.stringify(body), cache: 'no-store',
  });
  if (res.ok) return { ok: true };
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: err.error ?? `Request failed (${res.status})` };
}

export async function removeIntegration(clerkUserId: string, serviceId: string, integrationId: string): Promise<void> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/services/${serviceId}/integrations/${integrationId}`, {
    method: 'DELETE', headers: headers(clerkUserId), cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) throw new Error(`removeIntegration failed: ${res.status}`);
}

export type IntegrationField = {
  name: string;
  label: string;
  type: 'text' | 'password';
  section: 'credentials' | 'config';
  placeholder?: string;
  optional?: boolean;
};
export type AvailableIntegration = { id: string; name: string; fields: IntegrationField[] };

export async function fetchAvailableIntegrations(clerkUserId: string): Promise<AvailableIntegration[]> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/integrations`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchAvailableIntegrations failed: ${res.status}`);
  return (await res.json()).integrations as AvailableIntegration[];
}
