import { describe, expect, it } from 'vitest';
import { decideTransition } from './transition';

const base = { consecutiveFailures: 0, consecutiveSuccesses: 0 } as const;

describe('decideTransition', () => {
  it('first failure from up: no change, no incident (invisible strike)', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveFailures: 1, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('second consecutive failure from up: flip down + open', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveFailures: 2, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'open' });
  });

  it('pending goes up immediately on first success', () => {
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveSuccesses: 1, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('pending needs two failures to go down + open', () => {
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveFailures: 1, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'pending', incidentAction: 'none' });
    expect(decideTransition({ ...base, currentStatus: 'pending', consecutiveFailures: 2, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'open' });
  });

  it('down: first success does not resolve', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveSuccesses: 1, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'none' });
  });

  it('down: two consecutive successes resolve', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveSuccesses: 2, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'resolve' });
  });

  it('stays up when already up and passing', () => {
    expect(decideTransition({ ...base, currentStatus: 'up', consecutiveSuccesses: 5, rawStatus: 'up' }))
      .toEqual({ nextStatus: 'up', incidentAction: 'none' });
  });

  it('stays down when already down and failing', () => {
    expect(decideTransition({ ...base, currentStatus: 'down', consecutiveFailures: 5, rawStatus: 'down' }))
      .toEqual({ nextStatus: 'down', incidentAction: 'none' });
  });
});
