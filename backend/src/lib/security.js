const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');

const passwordSchema = z.string().min(12).max(128).refine(function hasLetter(value) {
  return /[a-z]/i.test(value);
}, 'Password must include a letter').refine(function hasNumber(value) {
  return /\d/.test(value);
}, 'Password must include a number');

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

async function hashPassword(password, rounds) {
  passwordSchema.parse(password);
  return bcrypt.hash(password, rounds || Number(process.env.BCRYPT_ROUNDS || 12));
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function createRefreshSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashRefreshSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function refreshSecretMatches(expectedHash, secret) {
  const actualHash = Buffer.from(hashRefreshSecret(secret), 'hex');
  const storedHash = Buffer.from(expectedHash, 'hex');
  return storedHash.length === actualHash.length && crypto.timingSafeEqual(storedHash, actualHash);
}

function createRefreshToken(sessionId, secret) {
  return `${sessionId}.${secret}`;
}

function parseRefreshToken(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^[0-9a-f-]{36}$/i.test(parts[0]) || parts[1].length < 40) return null;
  return { sessionId: parts[0], secret: parts[1] };
}

function createAccessToken(user, secret, expiresIn, sessionId) {
  return jwt.sign({ sub: user.id, sid: sessionId || null, ver: user.tokenVersion || 0, typ: 'access' }, secret, {
    algorithm: 'HS256',
    expiresIn: expiresIn || '15m',
    issuer: 'nexacore-api',
    audience: 'nexacore-web',
  });
}

function verifyAccessToken(token, secret) {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'nexacore-api',
    audience: 'nexacore-web',
  });
}

module.exports = {
  passwordSchema,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  createRefreshSecret,
  hashRefreshSecret,
  refreshSecretMatches,
  createRefreshToken,
  parseRefreshToken,
  createAccessToken,
  verifyAccessToken,
};
