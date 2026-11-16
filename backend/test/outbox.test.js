const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptPayload, decryptPayload } = require('../src/modules/notifications/outbox.crypto');
const { processNextEmail, MAX_ATTEMPTS } = require('../src/modules/notifications/outbox.service');

const key = Buffer.alloc(32, 19).toString('base64');
const now = new Date();

function pendingRow(overrides) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    recipient: 'nexa@example.test',
    encryptedPayload: encryptPayload({ subject: 'Test message', text: 'Sensitive link' }, key),
    status: 'PENDING',
    attempts: 1,
    nextAttemptAt: now,
    lockedAt: now,
    deliveredAt: null,
    lastError: null,
    createdAt: now,
    ...overrides,
  };
}

test('outbox payloads encrypt auth links and reject tampering', function encryptedOutboxPayload() {
  const payload = { subject: 'Verify', text: 'https://example.test/verify?token=secret-value' };
  const encrypted = encryptPayload(payload, key);
  assert.doesNotMatch(encrypted, /secret-value|verify/);
  assert.deepEqual(decryptPayload(encrypted, key), payload);
  const tampered = `${encrypted.slice(0, -2)}AA`;
  assert.throws(function rejectTamperedPayload() { decryptPayload(tampered, key); });
});

test('outbox worker sends and marks messages as delivered', async function successfulDelivery() {
  const row = pendingRow();
  const updates = [];
  let sent;
  const prisma = {
    emailOutbox: {
      findFirst: async function findFirst() { return row; },
      updateMany: async function updateMany() { return { count: 1 }; },
      findUnique: async function findUnique() { return row; },
      update: async function update(args) { updates.push(args.data); return {}; },
    },
  };
  const result = await processNextEmail(prisma, { send: async function send(message) { sent = message; } }, { outboxEncryptionKey: key });
  assert.equal(result.status, 'SENT');
  assert.equal(sent.to, 'nexa@example.test');
  assert.equal(sent.subject, 'Test message');
  assert.deepEqual(updates[0], { status: 'SENT', lockedAt: null, deliveredAt: updates[0].deliveredAt, lastError: null });
  assert.ok(updates[0].deliveredAt instanceof Date);
});

test('outbox worker reschedules transient delivery failures', async function retryTransientDelivery() {
  const row = pendingRow({ attempts: 1 });
  const updates = [];
  const prisma = {
    emailOutbox: {
      findFirst: async function findFirst() { return row; },
      updateMany: async function updateMany() { return { count: 1 }; },
      findUnique: async function findUnique() { return { ...row, attempts: 2 }; },
      update: async function update(args) { updates.push(args.data); return {}; },
    },
  };
  const result = await processNextEmail(prisma, { send: async function send() { throw new Error('temporary SMTP failure'); } }, { outboxEncryptionKey: key });
  assert.equal(result.status, 'PENDING');
  assert.equal(updates[0].status, 'PENDING');
  assert.equal(updates[0].lastError, 'temporary SMTP failure');
  assert.ok(updates[0].nextAttemptAt.getTime() > Date.now());
});

test('outbox worker records terminal failures and emits an audit event', async function terminalDeliveryFailure() {
  const row = pendingRow({ attempts: MAX_ATTEMPTS - 1 });
  const updates = [];
  let auditEvent;
  const prisma = {
    emailOutbox: {
      findFirst: async function findFirst() { return row; },
      updateMany: async function updateMany() { return { count: 1 }; },
      findUnique: async function findUnique() { return { ...row, attempts: MAX_ATTEMPTS }; },
      update: async function update(args) { updates.push(args.data); return {}; },
    },
    auditLog: { create: async function create(args) { auditEvent = args.data; return {}; } },
  };
  const result = await processNextEmail(prisma, { send: async function send() { throw new Error('smtp password=should-not-leak'); } }, { outboxEncryptionKey: key });
  assert.equal(result.status, 'FAILED');
  assert.equal(updates[0].status, 'FAILED');
  assert.doesNotMatch(auditEvent.metadata.error, /should-not-leak/);
  assert.equal(auditEvent.action, 'notification.email_delivery_failed');
});
