import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function seal(value: unknown, keyHex: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}
export function unseal(ciphertext: string, keyHex: string, context: string): unknown {
  const data = Buffer.from(ciphertext, 'base64');
  if (data.length < 28) throw new Error('Invalid evidence envelope');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
  );
}
