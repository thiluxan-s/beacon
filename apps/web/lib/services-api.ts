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
