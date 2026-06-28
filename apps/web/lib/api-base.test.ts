import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverApiBaseUrl } from './api-base';

describe('serverApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers INTERNAL_API_URL when set', () => {
    vi.stubEnv('INTERNAL_API_URL', 'http://server:3001');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.beacon.thiluxan.com');
    expect(serverApiBaseUrl()).toBe('http://server:3001');
  });

  it('falls back to NEXT_PUBLIC_API_URL when INTERNAL_API_URL is unset', () => {
    vi.stubEnv('INTERNAL_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3001');
    expect(serverApiBaseUrl()).toBe('http://localhost:3001');
  });
});
