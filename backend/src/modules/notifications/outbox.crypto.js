const crypto = require('node:crypto');

function encryptPayload(value, encodedKey) {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('Outbox encryption key must decode to exactly 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(function encode(part) { return part.toString('base64url'); }).join('.');
}

function decryptPayload(value, encodedKey) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Encrypted outbox payload is malformed');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('Outbox encryption key must decode to exactly 32 bytes');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parts[2], 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

module.exports = { encryptPayload, decryptPayload };
