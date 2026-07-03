import { describe, expect, it } from 'vitest';
import { nextBackoffMs } from './ws-client';

describe('nextBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(3)).toBe(8000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});
