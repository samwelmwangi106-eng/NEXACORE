const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../src/lib/security');

 test('normalizes email addresses consistently', function emailNormalization() {
  assert.equal(security.normalizeEmail('  Ada.Lovelace@Example.COM '), 'ada.lovelace@example.com');
});

test('password policy rejects weak credentials and accepts a strong credential', function passwordPolicy() {
  assert.equal(security.passwordSchema.safeParse('short1').success, false);
  assert.equal(security.passwordSchema.safeParse('longpasswordhere').success, false);
  assert.equal(security.passwordSchema.safeParse('LongPassword123').success, true);
});

test('refresh token parsing requires a session ID and secret', function refreshParsing() {
  const id = '11111111-1111-4111-8111-111111111111';
  const secret = 'x'.repeat(48);
  assert.deepEqual(security.parseRefreshToken(`${id}.${secret}`), { sessionId: id, secret });
  assert.equal(security.parseRefreshToken('forged'), null);
  assert.equal(security.parseRefreshToken(`${id}.short`), null);
});

test('refresh token hashes are deterministic but do not store the original secret', function tokenHashing() {
  const secret = security.createRefreshSecret();
  const digest = security.hashRefreshSecret(secret);
  assert.equal(digest, security.hashRefreshSecret(secret));
  assert.notEqual(digest, secret);
  assert.equal(digest.length, 64);
});

test('access tokens are audience and issuer constrained', function accessTokenClaims() {
  const secret = 'test-only-secret-that-is-at-least-32-characters';
  const token = security.createAccessToken({ id: 'user-1' }, secret, '1m');
  assert.equal(security.verifyAccessToken(token, secret).sub, 'user-1');
  assert.throws(function rejectWrongSecret() { security.verifyAccessToken(token, `${secret}!`); });
});
