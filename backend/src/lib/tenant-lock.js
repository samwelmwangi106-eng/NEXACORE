const { AppError } = require('./errors');

/**
 * Take the per-organisation advisory lock for the current transaction.
 *
 * `pg_advisory_xact_lock` is transaction-scoped: PostgreSQL releases it
 * automatically on COMMIT or ROLLBACK, so there is nothing to unlock and no
 * lock can leak if a request throws. The key is `hashtextextended(organisationId)`,
 * so unrelated tenants never contend with each other.
 *
 * Every operation that reads organisation- or ownership-scoped state and then
 * writes based on it must take this lock, or two concurrent transactions can
 * each observe a state that the other is about to invalidate.
 *
 * This FAILS CLOSED. `$executeRaw` is a method on the PrismaClient base class,
 * so a real client always has it; an absent method means a misconfigured or
 * stubbed client, never a valid production state. Proceeding without the lock
 * would silently reintroduce the race, so the operation is refused instead.
 */
async function lockOrganisation(tx, organisationId) {
  if (!tx || typeof tx.$executeRaw !== 'function') {
    throw new AppError(
      500,
      'TENANT_LOCK_UNAVAILABLE',
      'This operation requires a client that can take an advisory lock; it was refused rather than applied unsafely',
    );
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organisationId}::text, 0))`;
}

module.exports = { lockOrganisation };
