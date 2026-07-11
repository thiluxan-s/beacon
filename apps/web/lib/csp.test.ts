import { describe, expect, it } from 'vitest';
import { buildCspDirectives } from './csp';

describe('buildCspDirectives', () => {
  it('puts self plus the API and WS origins in connect-src (production URLs)', () => {
    const d = buildCspDirectives(
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    );
    expect(d['connect-src']).toEqual([
      "'self'",
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    ]);
  });

  it('parses localhost dev URLs to their origins', () => {
    const d = buildCspDirectives(
      'http://localhost:3001',
      'ws://localhost:3001',
    );
    expect(d['connect-src']).toEqual([
      "'self'",
      'http://localhost:3001',
      'ws://localhost:3001',
    ]);
  });

  it('skips an invalid or empty URL instead of throwing', () => {
    const d = buildCspDirectives('', 'wss://api.beacon.thiluxan.com');
    expect(d['connect-src']).toEqual([
      "'self'",
      'wss://api.beacon.thiluxan.com',
    ]);
  });

  it('sets the static hardening directives', () => {
    const d = buildCspDirectives(
      'https://api.beacon.thiluxan.com',
      'wss://api.beacon.thiluxan.com',
    );
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:']);
    expect(d['font-src']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
  });
});
