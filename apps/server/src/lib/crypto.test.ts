import { describe, expect, it } from 'vitest';
import { encrypt, decrypt, timingSafeEqualStr } from './crypto';

describe('timingSafeEqualStr', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStr('a-secret-value', 'a-secret-value')).toBe(true);
  });
  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualStr('a-secret-value', 'a-secret-valuX')).toBe(false);
  });
  it('returns false for different lengths without throwing', () => {
    expect(timingSafeEqualStr('short', 'a-longer-secret')).toBe(false);
  });
  it('returns false when one side is empty', () => {
    expect(timingSafeEqualStr('', 'secret')).toBe(false);
  });
});

describe('crypto (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const secret = JSON.stringify({ apiToken: 'tok_123' });
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces a different blob each time (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('prefixes the blob with the format version byte', () => {
    expect(Buffer.from(encrypt('x'), 'base64')[0]).toBe(1);
  });

  it('throws on an unknown blob version', () => {
    const buf = Buffer.from(encrypt('hello'), 'base64');
    buf[0] = 2; // bump the version byte to an unsupported value
    expect(() => decrypt(buf.toString('base64'))).toThrow(/version/);
  });

  it('throws when the ciphertext is tampered', () => {
    const blob = encrypt('hello');
    const buf = Buffer.from(blob, 'base64');
    const lastIdx = buf.length - 1;
    buf[lastIdx] = (buf[lastIdx] as number) ^ 0xff; // flip a byte of the ciphertext/tag
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });
});
