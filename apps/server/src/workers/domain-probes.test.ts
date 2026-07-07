import { describe, expect, it, vi } from 'vitest';
import { parseRdapExpiration, parseCertExpiry, resolveDns, probeSsl, probeRdap } from './domain-probes';

describe('parseRdapExpiration', () => {
  it('extracts the expiration event date', () => {
    const json = { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-04T00:00:00Z' }] };
    expect(parseRdapExpiration(json)?.toISOString()).toBe('2027-03-04T00:00:00.000Z');
  });
  it('returns null when no expiration event', () => {
    expect(parseRdapExpiration({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] })).toBeNull();
  });
  it('returns null on malformed input', () => {
    expect(parseRdapExpiration(null)).toBeNull();
    expect(parseRdapExpiration({ events: 'nope' })).toBeNull();
    expect(parseRdapExpiration({ events: [{ eventAction: 'expiration', eventDate: 'not-a-date' }] })).toBeNull();
  });
});

describe('parseCertExpiry', () => {
  it('reads valid_to and issuer O', () => {
    const r = parseCertExpiry({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { O: "Let's Encrypt", CN: 'R3' } });
    expect(r.expiresAt?.getFullYear()).toBe(2027);
    expect(r.issuer).toBe("Let's Encrypt");
  });
  it('falls back to issuer CN, and nulls on missing cert', () => {
    expect(parseCertExpiry({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { CN: 'R3' } }).issuer).toBe('R3');
    expect(parseCertExpiry(null)).toEqual({ expiresAt: null, issuer: null });
    expect(parseCertExpiry({}).expiresAt).toBeNull();
  });
});

describe('resolveDns', () => {
  it('resolved with ip on success', async () => {
    const r = await resolveDns('x.com', { lookup: async () => ({ address: '1.2.3.4' }) });
    expect(r).toEqual({ resolved: true, ip: '1.2.3.4' });
  });
  it('not resolved on failure', async () => {
    const r = await resolveDns('x.com', { lookup: async () => { throw new Error('ENOTFOUND'); } });
    expect(r.resolved).toBe(false);
    expect(r.ip).toBeNull();
  });
});

describe('probeSsl', () => {
  it('parses a returned cert', async () => {
    const r = await probeSsl('x.com', { getCert: async () => ({ valid_to: 'Mar 4 12:00:00 2027 GMT', issuer: { O: 'CA' } }) });
    expect(r.expiresAt?.getFullYear()).toBe(2027);
    expect(r.issuer).toBe('CA');
  });
  it('nulls with error when the cert fetch throws', async () => {
    const r = await probeSsl('x.com', { getCert: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.expiresAt).toBeNull();
    expect(r.error).toBeDefined();
  });
});

describe('probeRdap', () => {
  it('returns the expiration on a 200', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: '2027-03-04T00:00:00Z' }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await probeRdap('x.com', { fetchFn });
    expect(r.expiresAt?.toISOString()).toBe('2027-03-04T00:00:00.000Z');
  });
  it('returns null when all candidates fail', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const r = await probeRdap('sub.x.com', { fetchFn });
    expect(r.expiresAt).toBeNull();
  });
});
