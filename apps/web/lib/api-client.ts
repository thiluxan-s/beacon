import { HealthResponseSchema, type HealthResponse } from '@beacon/shared';

import { serverApiBaseUrl } from './api-base';

export async function fetchServerHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${serverApiBaseUrl()}/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return HealthResponseSchema.parse(await res.json());
  } catch {
    return null;
  }
}
