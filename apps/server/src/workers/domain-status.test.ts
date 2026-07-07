import { describe, expect, it } from 'vitest';
import { classifyDomain } from './domain-status';

const now = new Date('2026-07-06T00:00:00.000Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('classifyDomain', () => {
  it('DNS failure is unhealthy regardless of SSL', () => {
    expect(classifyDomain({ dnsResolved: false, sslExpiresAt: inDays(200), domainExpiresAt: inDays(200), now })).toBe('unhealthy');
  });
  it('no readable cert (null) is unhealthy', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: null, domainExpiresAt: inDays(200), now })).toBe('unhealthy');
  });
  it('past-due SSL is expired', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(-1), domainExpiresAt: inDays(200), now })).toBe('expired');
  });
  it('past-due registration is expired', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(-1), now })).toBe('expired');
  });
  it('SSL within 7 days is expiring_soon', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(5), domainExpiresAt: inDays(200), now })).toBe('expiring_soon');
  });
  it('registration within 7 days is expiring_soon (worst-of)', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(3), now })).toBe('expiring_soon');
  });
  it('within 30 days is warning', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(20), domainExpiresAt: inDays(200), now })).toBe('warning');
  });
  it('both far out is healthy', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: inDays(300), now })).toBe('healthy');
  });
  it('unknown registration never warns on its own', () => {
    expect(classifyDomain({ dnsResolved: true, sslExpiresAt: inDays(200), domainExpiresAt: null, now })).toBe('healthy');
  });
});
