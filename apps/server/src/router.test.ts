import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@beacon/shared';
import { createRouter } from './router';

describe('GET /health', () => {
  it('returns a valid HealthResponse', async () => {
    const app = createRouter();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(HealthResponseSchema.parse(body).status).toBe('ok');
  });
});
