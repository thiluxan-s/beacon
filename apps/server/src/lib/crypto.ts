import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env';

const KEY = Buffer.from(env.INTEGRATIONS_ENCRYPTION_KEY, 'base64');
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt a UTF-8 string → base64("iv | authTag | ciphertext"). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverse of encrypt(). Throws if the auth tag does not verify. */
export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
