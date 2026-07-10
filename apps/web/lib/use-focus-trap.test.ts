import { describe, expect, it } from 'vitest';
import { wrapTabIndex } from './use-focus-trap';

describe('wrapTabIndex', () => {
  it('wraps shift+Tab from the first item to the last', () => {
    expect(wrapTabIndex(3, 0, true)).toBe(2);
  });
  it('wraps Tab from the last item to the first', () => {
    expect(wrapTabIndex(3, 2, false)).toBe(0);
  });
  it('does not wrap from the middle (returns null → browser handles it)', () => {
    expect(wrapTabIndex(3, 1, false)).toBeNull();
    expect(wrapTabIndex(3, 1, true)).toBeNull();
  });
  it('returns null for an empty focusable set', () => {
    expect(wrapTabIndex(0, -1, false)).toBeNull();
  });
});
