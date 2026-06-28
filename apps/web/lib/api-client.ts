import { HealthResponseSchema, type HealthResponse } from '@beacon/shared';

import { clientEnv } from './env.client';

export async function fetchServerHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_API_URL}/health`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return HealthResponseSchema.parse(await res.json());
  } catch {
    return null;
  }
}
