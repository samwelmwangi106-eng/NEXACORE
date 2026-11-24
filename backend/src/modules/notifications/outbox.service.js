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

/**
 * Claim and deliver the next due outbox message.
 *
 * Lease fencing: when a `workerToken` is supplied the claim stamps `lockToken`
 * on the row and every terminal write is conditioned on that token still
 * matching. A worker whose lease was reclaimed by another worker (stale-lease
 * takeover) therefore cannot mark a message SENT or FAILED — its write hits
 * zero rows and it reports `LEASE_LOST` instead.
 *
 * Without a token the function keeps the original non-fenced behaviour so
 * lightweight callers (and tests using an in-memory stub) work unchanged.
 */
async function processNextEmail(prisma, mailer, config, logger, workerToken) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  const fencing = Boolean(workerToken);
  const unowned = function unowned() {
    return fencing ? { OR: [{ lockToken: null }, { lockToken: workerToken }] } : {};
  };

  const candidate = await prisma.emailOutbox.findFirst({
    where: {
      OR: [
        { status: 'PENDING', nextAttemptAt: { lte: now }, ...unowned() },
        { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!candidate) return { processed: false };

  const claimWhere = candidate.status === 'PENDING'
    ? { id: candidate.id, status: 'PENDING', nextAttemptAt: { lte: now }, ...unowned() }
    : { id: candidate.id, status: 'PROCESSING', lockedAt: candidate.lockedAt };
  const claimData = { status: 'PROCESSING', lockedAt: now, attempts: { increment: 1 } };
  if (fencing) claimData.lockToken = workerToken;

  const claim = await prisma.emailOutbox.updateMany({ where: claimWhere, data: claimData });
  if (!claim.count) return { processed: false };

  const outbox = await prisma.emailOutbox.findUnique({ where: { id: candidate.id } });

  // Every terminal write is fenced on the token that won the claim.
  const guard = fencing ? { id: outbox.id, lockToken: workerToken } : { id: outbox.id };

  try {
    const message = decryptPayload(outbox.encryptedPayload, config.outboxEncryptionKey);
    await mailer.send({ to: outbox.recipient, subject: message.subject, text: message.text });
    const sentData = { status: 'SENT', lockedAt: null, deliveredAt: new Date(), lastError: null };
    if (fencing) sentData.lockToken = null;
    await prisma.emailOutbox.update({ where: guard, data: sentData });
    return { processed: true, status: 'SENT', id: outbox.id };
  } catch (error) {
    const message = safeErrorMessage(error);
    const leaseLost = fencing && error && error.code === 'P2025';
    if (leaseLost) {
      if (logger && logger.warn) {
        logger.warn({ event: 'email_lease_lost', outboxId: outbox.id, error: message });
      }
      return { processed: false, status: 'LEASE_LOST', id: outbox.id };
    }

    const failed = outbox.attempts >= MAX_ATTEMPTS;
    const backoffMs = Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.max(0, outbox.attempts - 1)));
    const retryData = {
      status: failed ? 'FAILED' : 'PENDING',
      lockedAt: null,
      nextAttemptAt: failed ? outbox.nextAttemptAt : new Date(Date.now() + backoffMs),
      lastError: message,
    };
    if (fencing) retryData.lockToken = null;
    await prisma.emailOutbox.update({ where: guard, data: retryData });

    if (failed) {
      await recordAudit(prisma, {
        action: 'notification.email_delivery_failed',
        entityType: 'email_outbox',
        entityId: outbox.id,
        metadata: { attempts: outbox.attempts, error: message },
      });
    }
    if (logger && logger.warn) {
      logger.warn({ event: 'email_delivery_attempt_failed', outboxId: outbox.id, attempts: outbox.attempts, terminal: failed, error: message });
    }
    return { processed: true, status: failed ? 'FAILED' : 'PENDING', id: outbox.id };
  }
}

module.exports = { enqueueEmail, processNextEmail, safeErrorMessage, MAX_ATTEMPTS, LOCK_TIMEOUT_MS };
