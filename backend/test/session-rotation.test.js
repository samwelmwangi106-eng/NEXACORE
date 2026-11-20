const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/modules/auth/auth.service');
const { createRefreshToken, hashRefreshSecret } = require('../src/lib/security');

const sessionId = '11111111-1111-4111-8111-111111111111';
const familyId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const secret = 'refresh-secret-for-rotation-test-0123456789abcdef';
const config = { accessSecret: 'test-only-secret-that-is-at-least-32-characters', accessTtl: '5m', refreshTtlDays: 30 };

function activeSession(revokedAt) {
  return {
    id: sessionId,
    familyId,
    userId,
    tokenHash: hashRefreshSecret(secret),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: revokedAt || null,
    user: { id: userId, email: 'session@example.test', firstName: 'Session', lastName: 'User', status: 'ACTIVE' },
  };
}

test('refresh rotation links the successor session to the same token family', async function rotateRefreshSession() {
  const created = [];
  const tx = {
    refreshSession: {
      updateMany: async function updateMany() { return { count: 1 }; },
      create: async function create(args) { created.push(args.data); return { id: '44444444-4444-4444-8444-444444444444' }; },
    },
  };
  const prisma = {
    refreshSession: { findUnique: async function findUnique() { return activeSession(); } },
    $transaction: async function transaction(callback) { return callback(tx); },
  };
  const result = await auth.rotateSession(prisma, createRefreshToken(sessionId, secret), config);
  assert.equal(created.length, 1);
  assert.equal(created[0].familyId, familyId);
  assert.match(result.refreshToken, /^44444444-4444-4444-8444-444444444444\./);
});

test('reuse of a valid revoked token revokes the refresh family and is audited', async function detectRefreshReuse() {
  let familyRevocation;
  let auditAction;
  const tx = {
    refreshSession: { updateMany: async function updateMany(args) { familyRevocation = args; return { count: 1 }; } },
    auditLog: { create: async function create(args) { auditAction = args.data.action; return {}; } },
  };
  const prisma = {
    refreshSession: { findUnique: async function findUnique() { return activeSession(new Date()); } },
    $transaction: async function transaction(callback) { return callback(tx); },
  };
  await assert.rejects(auth.rotateSession(prisma, createRefreshToken(sessionId, secret), config),
    function reuseRejected(error) { return error.code === 'INVALID_REFRESH_TOKEN'; });
  assert.deepEqual(familyRevocation.where, { familyId, revokedAt: null });
  assert.equal(auditAction, 'auth.refresh_reuse_detected');
});

test('a forged refresh secret does not revoke the genuine session family', async function forgedRefreshDoesNotRevoke() {
  let transactionStarted = false;
  const prisma = {
    refreshSession: { findUnique: async function findUnique() { return activeSession(); } },
    $transaction: async function transaction() { transactionStarted = true; },
  };
  await assert.rejects(auth.rotateSession(prisma, createRefreshToken(sessionId, `${secret}forged`), config),
    function invalidSecret(error) { return error.code === 'INVALID_REFRESH_TOKEN'; });
  assert.equal(transactionStarted, false);
});
