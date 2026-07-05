import { afterEach, describe, expect, it, vi } from 'vitest';
import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an em dash for null', () => {
    expect(relativeTime(null)).toBe('—');
  });

  it('formats seconds, minutes, hours, and days ago', () => {
    const now = new Date('2026-07-05T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(relativeTime(ago(30_000))).toBe('30s ago'); // 30 seconds
    expect(relativeTime(ago(5 * 60_000))).toBe('5m ago'); // 5 minutes
    expect(relativeTime(ago(3 * 3_600_000))).toBe('3h ago'); // 3 hours
    expect(relativeTime(ago(2 * 86_400_000))).toBe('2d ago'); // 2 days
  });
});
