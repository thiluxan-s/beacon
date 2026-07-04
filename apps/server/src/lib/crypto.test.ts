import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from './crypto';

describe('crypto (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const secret = JSON.stringify({ apiToken: 'tok_123' });
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces a different blob each time (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('throws when the ciphertext is tampered', () => {
    const blob = encrypt('hello');
    const buf = Buffer.from(blob, 'base64');
    const lastIdx = buf.length - 1;
    buf[lastIdx] = (buf[lastIdx] as number) ^ 0xff; // flip a byte of the ciphertext/tag
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });
});
