const crypto = require('node:crypto');
const { encryptPayload, decryptPayload } = require('./outbox.crypto');
const { recordAudit } = require('../audit/audit.service');

const MAX_ATTEMPTS = 5;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

async function enqueueEmail(tx, config, message) {
  return tx.emailOutbox.create({
    data: {
      recipient: message.to,
      encryptedPayload: encryptPayload({ subject: message.subject, text: message.text }, config.outboxEncryptionKey),
    },
  });
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : 'Email delivery failed')
    .replace(/(smtp:\/\/|smtps:\/\/)[^\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(password|pass|authorization|token)=([^\s&]+)/gi, '$1=[redacted]')
    .slice(0, 500);
}

async function processNextEmail(prisma, mailer, config, logger) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  const candidate = await prisma.emailOutbox.findFirst({
    where: {
      OR: [
        { status: 'PENDING', nextAttemptAt: { lte: now } },
        { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!candidate) return { processed: false };

  const claimWhere = candidate.status === 'PENDING'
    ? { id: candidate.id, status: 'PENDING', nextAttemptAt: { lte: now } }
    : { id: candidate.id, status: 'PROCESSING', lockedAt: candidate.lockedAt };
  const lockToken = crypto.randomUUID();
  const claim = await prisma.emailOutbox.updateMany({
    where: claimWhere,
    data: { status: 'PROCESSING', lockedAt: now, lockToken, attempts: { increment: 1 } },
  });
  if (!claim.count) return { processed: false };

  const outbox = await prisma.emailOutbox.findUnique({ where: { id: candidate.id } });
  if (!outbox || outbox.lockToken !== lockToken) return { processed: true, status: 'OWNERSHIP_LOST', id: candidate.id };

  let sendError;
  try {
    const message = decryptPayload(outbox.encryptedPayload, config.outboxEncryptionKey);
    await mailer.send({ to: outbox.recipient, subject: message.subject, text: message.text });
  } catch (error) {
    sendError = error;
  }

  const ownership = { id: outbox.id, status: 'PROCESSING', lockToken };
  if (!sendError) {
    const delivered = await prisma.emailOutbox.updateMany({
      where: ownership,
      data: { status: 'SENT', lockedAt: null, lockToken: null, deliveredAt: new Date(), lastError: null },
    });
    if (!delivered.count) return { processed: true, status: 'OWNERSHIP_LOST', id: outbox.id };
    return { processed: true, status: 'SENT', id: outbox.id };
  }

  const message = safeErrorMessage(sendError);
  const failed = outbox.attempts >= MAX_ATTEMPTS;
  const backoffMs = Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.max(0, outbox.attempts - 1)));
  const rescheduled = await prisma.emailOutbox.updateMany({
    where: ownership,
    data: {
      status: failed ? 'FAILED' : 'PENDING',
      lockedAt: null,
      lockToken: null,
      nextAttemptAt: failed ? outbox.nextAttemptAt : new Date(Date.now() + backoffMs),
      lastError: message,
    },
  });
  if (!rescheduled.count) return { processed: true, status: 'OWNERSHIP_LOST', id: outbox.id };

  if (failed) {
    await recordAudit(prisma, {
      action: 'notification.email_delivery_failed',
      entityType: 'email_outbox',
      entityId: outbox.id,
      metadata: { attempts: outbox.attempts, error: message },
    });
  }
  if (logger && logger.warn) logger.warn({ event: 'email_delivery_attempt_failed', outboxId: outbox.id, attempts: outbox.attempts, terminal: failed, error: message });
  return { processed: true, status: failed ? 'FAILED' : 'PENDING', id: outbox.id };
}

module.exports = { enqueueEmail, processNextEmail, MAX_ATTEMPTS, LOCK_TIMEOUT_MS };
