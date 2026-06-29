import { describe, expect, it } from 'vitest';
import { runBounded } from './concurrency';

describe('runBounded', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let max = 0;
    await runBounded([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(max).toBeLessThanOrEqual(2);
  });
});
