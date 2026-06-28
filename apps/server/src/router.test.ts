import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@beacon/shared';
import { pool } from './db/index';
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

describe('POST /internal/users/upsert', () => {
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE clerk_user_id = 'user_x'");
  });

  it('rejects without the internal secret', async () => {
    const app = createRouter();
    const res = await app.request('/internal/users/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_x', email: 'x@example.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('upserts with a valid secret', async () => {
    const app = createRouter();
    const res = await app.request('/internal/users/upsert', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': 'test-internal-secret-at-least-16',
      },
      body: JSON.stringify({ clerkUserId: 'user_x', email: 'x@example.com' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clerkUserId: string };
    expect(body.clerkUserId).toBe('user_x');
  });
});
