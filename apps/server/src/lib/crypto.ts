import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env';

const KEY = Buffer.from(env.INTEGRATIONS_ENCRYPTION_KEY, 'base64');
// Blob format version. A 1-byte prefix lets us evolve the scheme (or support
// key rotation / key-id selection) later without silently failing to decrypt
// older blobs — an unknown version throws loudly instead.
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt a UTF-8 string → base64("version(1) | iv(12) | authTag(16) | ciphertext"). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64');
}

/** Reverse of encrypt(). Throws on an unknown version or if the auth tag does not verify. */
export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(`unsupported credential blob version: ${String(version)}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
