const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/modules/auth/auth.service');
const { hashRefreshSecret, verifyPassword } = require('../src/lib/security');
const { decryptPayload } = require('../src/modules/notifications/outbox.crypto');

const config = {
  accessSecret: 'test-only-secret-that-is-at-least-32-characters',
  accessTtl: '5m',
  refreshTtlDays: 30,
  webOrigin: 'http://localhost:5173',
  outboxEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
};
const userId = '11111111-1111-4111-8111-111111111111';
const tokenId = '22222222-2222-4222-8222-222222222222';
const rawToken = 'verification-reset-test-token-with-enough-entropy-123456';

function fakeUser(status) {
  return {
    id: userId,
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status,
    emailVerifiedAt: status === 'ACTIVE' ? new Date() : null,
    passwordHash: 'existing-hash',
  };
}

test('registration creates a pending account and enqueues an encrypted one-time verification URL', async function registerRequiresVerification() {
  const created = { user: null, organisation: null, authToken: null, outbox: null };
  const tx = {
    user: { create: async function create(args) { created.user = { ...args.data }; return created.user; } },
    organisation: { create: async function create(args) { created.organisation = { id: 'org-1', ...args.data }; return created.organisation; } },
    organisationMember: { create: async function create(args) { return { id: 'member-1', ...args.data }; } },
    permission: { upsert: async function upsert() { return {}; } },
    role: { create: async function create(args) { return { id: `role-${args.data.name}` }; } },
    memberRole: { create: async function create() { return {}; } },
    authToken: {
      updateMany: async function updateMany() { return { count: 0 }; },
      create: async function create(args) { created.authToken = args.data; return args.data; },
    },
    emailOutbox: { create: async function create(args) { created.outbox = args.data; return args.data; } },
    auditLog: { create: async function create() { return {}; } },
  };
  const prisma = { $transaction: async function transaction(callback) { return callback(tx); } };
  const result = await auth.register(prisma, {
    email: ' Ada@Example.test ', password: 'NexaCoreSecure123', firstName: 'Ada', lastName: 'Lovelace',
    organisationName: 'Analytical Engines', industry: 'SCHOOL',
  }, config, { requestId: 'request-1' });

  assert.equal(created.user.status, 'PENDING_VERIFICATION');
  assert.equal(created.user.email, 'ada@example.test');
  assert.equal(created.authToken.type, 'EMAIL_VERIFICATION');
  assert.equal(created.authToken.tokenHash.length, 64);
  assert.equal(result.accessToken, undefined);
  assert.equal(result.refreshToken, undefined);
  assert.equal(created.outbox.recipient, 'ada@example.test');
  assert.doesNotMatch(created.outbox.encryptedPayload, /verify-email/);
  const payload = decryptPayload(created.outbox.encryptedPayload, config.outboxEncryptionKey);
  const verificationUrl = new URL(payload.text.match(/https?:\/\/\S+/)[0]);
  const rawToken = verificationUrl.searchParams.get('token');
  assert.equal(hashRefreshSecret(rawToken), created.authToken.tokenHash);
  assert.equal(result.user.status, 'PENDING_VERIFICATION');
});

test('email verification consumes a token once and issues a session', async function verifyEmailCreatesSession() {
  const user = fakeUser('ACTIVE');
  let consumed = false;
  const tokenRecord = {
    id: tokenId,
    userId,
    type: 'EMAIL_VERIFICATION',
    tokenHash: hashRefreshSecret(rawToken),
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    user: fakeUser('PENDING_VERIFICATION'),
  };
  const tx = {
    authToken: { updateMany: async function updateMany() { consumed = true; return { count: 1 }; } },
    user: { updateMany: async function updateMany() { return { count: 1 }; }, findUnique: async function findUnique() { return user; } },
    organisationMember: { updateMany: async function updateMany() { return { count: 0 }; } },
    auditLog: { create: async function create() { return {}; } },
  };
  const prisma = {
    authToken: { findUnique: async function findUnique() { return consumed ? { ...tokenRecord, consumedAt: new Date() } : tokenRecord; } },
    $transaction: async function transaction(callback) { return callback(tx); },
    refreshSession: { create: async function create() { return { id: '33333333-3333-4333-8333-333333333333' }; } },
  };
  const result = await auth.verifyEmail(prisma, rawToken, config);
  assert.equal(consumed, true);
  assert.equal(result.user.id, userId);
  assert.ok(result.accessToken);
  assert.match(result.refreshToken, /^33333333-3333-4333-8333-333333333333\./);
});

test('verification rejects consumed and expired tokens', async function invalidVerificationToken() {
  const prisma = {
    authToken: { findUnique: async function findUnique() {
      return { type: 'EMAIL_VERIFICATION', consumedAt: new Date(), expiresAt: new Date(0), user: fakeUser('ACTIVE') };
    } },
  };
  await assert.rejects(auth.verifyEmail(prisma, rawToken, config), function invalidToken(error) {
    return error.code === 'INVALID_VERIFICATION_TOKEN';
  });
});

test('password reset consumes token, replaces password, and revokes active refresh sessions', async function resetRevokesSessions() {
  let sessionRevocations = 0;
  let savedPasswordHash;
  const token = {
    id: tokenId,
    userId,
    type: 'PASSWORD_RESET',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: fakeUser('ACTIVE'),
  };
  const tx = {
    authToken: { updateMany: async function updateMany() { return { count: 1 }; } },
    user: { update: async function update(args) { savedPasswordHash = args.data.passwordHash; return {}; } },
    refreshSession: { updateMany: async function updateMany() { sessionRevocations += 1; return { count: 2 }; } },
    auditLog: { create: async function create() { return {}; } },
  };
  const prisma = {
    authToken: { findUnique: async function findUnique() { return token; } },
    $transaction: async function transaction(callback) { return callback(tx); },
  };
  await auth.resetPassword(prisma, rawToken, 'ReplacementPassword987', { requestId: 'request-2' });
  assert.equal(sessionRevocations, 1);
  assert.ok(await verifyPassword('ReplacementPassword987', savedPasswordHash));
});

test('login rejects pending verification accounts', async function pendingLoginRejected() {
  const bcrypt = require('bcrypt');
  const pending = { ...fakeUser('PENDING_VERIFICATION'), passwordHash: await bcrypt.hash('ValidPassword123', 10) };
  const prisma = { user: { findUnique: async function findUnique() { return pending; } } };
  await assert.rejects(auth.login(prisma, { email: pending.email, password: 'ValidPassword123' }, config), function verificationRequired(error) {
    return error.code === 'EMAIL_NOT_VERIFIED';
  });
});
