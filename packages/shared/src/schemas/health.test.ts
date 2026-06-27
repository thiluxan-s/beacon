import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './health';

describe('HealthResponseSchema', () => {
  it('accepts a valid health response', () => {
    const value = { status: 'ok', service: 'beacon-server', time: '2026-06-26T00:00:00.000Z' };
    expect(HealthResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a wrong status literal', () => {
    // Only `status` is invalid here (time is a valid ISO datetime) so the test
    // isolates the status-literal check rather than passing for the wrong reason.
    expect(() =>
      HealthResponseSchema.parse({ status: 'bad', service: 's', time: '2026-06-26T00:00:00.000Z' }),
    ).toThrow();
  });

  it('rejects a missing field', () => {
    expect(() => HealthResponseSchema.parse({ status: 'ok', service: 's' })).toThrow();
  });
});
