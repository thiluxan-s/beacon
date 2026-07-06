import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../db/schema';
import { checkOne } from './check-worker';

function fakeService(over: Partial<Service> = {}): Service {
  return {
    id: 's1', userId: 'u1', name: 'W', description: null,
    baseUrl: 'https://w.com', healthCheckPath: '/health',
    expectedStatusCodes: [200], checkIntervalSeconds: 60, timeoutSeconds: 10,
    currentStatus: 'pending', currentStatusSince: new Date(),
    lastCheckAt: null, nextCheckAt: new Date(), paused: false, alertsEnabled: true,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as Service;
}

describe('checkOne', () => {
  it('applies an "up" result for an expected status code', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(fetchFn).toHaveBeenCalledWith('https://w.com/health', expect.objectContaining({ method: 'GET' }));
    expect(apply.mock.calls[0]![0].rawStatus).toBe('up');
    expect(apply.mock.calls[0]![0].check.status).toBe('success');
  });

  it('applies a "down" result when the fetch throws', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(apply.mock.calls[0]![0].rawStatus).toBe('down');
    expect(apply.mock.calls[0]![0].check.status).toBe('error');
  });

  it('applies a "down" result for an unexpected status code', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 503 }));
    await checkOne(fakeService(), { fetchFn: fetchFn as unknown as typeof fetch, apply });
    expect(apply.mock.calls[0]![0].check.status).toBe('failure');
    expect(apply.mock.calls[0]![0].rawStatus).toBe('down');
  });
});
