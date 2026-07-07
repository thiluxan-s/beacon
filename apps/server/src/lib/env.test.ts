import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://beacon:beacon@localhost:5432/beacon',
  WEB_ORIGIN: 'http://localhost:3000',
  INTERNAL_API_SECRET: 'a-32-char-minimum-secret-value-1234',
  CLERK_SECRET_KEY: 'sk_test_x',
  INTEGRATIONS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('loadEnv', () => {
  it('applies defaults for PORT and LOG_LEVEL', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow();
  });

  it('throws when INTERNAL_API_SECRET is too short', () => {
    expect(() => loadEnv({ ...base, INTERNAL_API_SECRET: 'short' })).toThrow();
  });

  it('accepts an empty ALERT_FROM_EMAIL (blank-value convention disables alerting)', () => {
    expect(() => loadEnv({ ...base, ALERT_FROM_EMAIL: '' })).not.toThrow();
  });

  it('throws when ALERT_FROM_EMAIL is a malformed non-empty value', () => {
    expect(() => loadEnv({ ...base, ALERT_FROM_EMAIL: 'nope' })).toThrow();
  });
});
