import { describe, expect, it } from 'vitest';
import { classifyCheck } from './check-classify';

describe('classifyCheck', () => {
  it('success when status code is expected', () => {
    expect(classifyCheck({ outcome: 'response', statusCode: 200, responseTimeMs: 30, expectedStatusCodes: [200] }))
      .toEqual({ status: 'success', statusCode: 200, responseTimeMs: 30, errorMessage: null, serviceStatus: 'up' });
  });

  it('success when status code is one of several expected', () => {
    expect(classifyCheck({ outcome: 'response', statusCode: 401, responseTimeMs: 12, expectedStatusCodes: [200, 401] }).status)
      .toBe('success');
  });

  it('failure when status code is not expected', () => {
    const r = classifyCheck({ outcome: 'response', statusCode: 500, responseTimeMs: 12, expectedStatusCodes: [200] });
    expect(r.status).toBe('failure');
    expect(r.serviceStatus).toBe('down');
  });

  it('timeout maps to down with null status code', () => {
    const r = classifyCheck({ outcome: 'timeout', responseTimeMs: 10_000 });
    expect(r).toEqual({ status: 'timeout', statusCode: null, responseTimeMs: 10_000, errorMessage: null, serviceStatus: 'down' });
  });

  it('error carries the message and maps to down', () => {
    const r = classifyCheck({ outcome: 'error', errorMessage: 'ENOTFOUND' });
    expect(r).toEqual({ status: 'error', statusCode: null, responseTimeMs: null, errorMessage: 'ENOTFOUND', serviceStatus: 'down' });
  });
});
