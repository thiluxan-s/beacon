import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicModeEnabled, publicOwnerClerkId } from './public-mode';

afterEach(() => vi.unstubAllEnvs());

describe('public-mode', () => {
  it('disabled when PUBLIC_OWNER_CLERK_ID is unset/blank', () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', '');
    expect(publicModeEnabled()).toBe(false);
    expect(publicOwnerClerkId()).toBeUndefined();
  });
  it('enabled when set', () => {
    vi.stubEnv('PUBLIC_OWNER_CLERK_ID', 'user_owner');
    expect(publicModeEnabled()).toBe(true);
    expect(publicOwnerClerkId()).toBe('user_owner');
  });
});
