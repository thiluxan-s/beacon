import { describe, expect, it } from 'vitest';
import { ServiceCreateSchema, ServiceUpdateSchema } from './service';

describe('ServiceCreateSchema', () => {
  it('applies defaults when optional fields are omitted', () => {
    const parsed = ServiceCreateSchema.parse({ name: 'Wayfare', baseUrl: 'https://wayfare.thiluxan.com' });
    expect(parsed).toMatchObject({
      name: 'Wayfare',
      baseUrl: 'https://wayfare.thiluxan.com',
      healthCheckPath: '/',
      expectedStatusCodes: [200],
      checkIntervalSeconds: 60,
      timeoutSeconds: 10,
    });
  });

  it('rejects a non-URL baseUrl', () => {
    expect(ServiceCreateSchema.safeParse({ name: 'x', baseUrl: 'not-a-url' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(ServiceCreateSchema.safeParse({ name: '', baseUrl: 'https://a.com' }).success).toBe(false);
  });

  it('rejects an out-of-range status code', () => {
    expect(
      ServiceCreateSchema.safeParse({ name: 'x', baseUrl: 'https://a.com', expectedStatusCodes: [99] }).success,
    ).toBe(false);
  });
});

describe('ServiceUpdateSchema', () => {
  it('allows a partial patch', () => {
    expect(ServiceUpdateSchema.parse({ paused: true })).toEqual({ paused: true });
  });
});
