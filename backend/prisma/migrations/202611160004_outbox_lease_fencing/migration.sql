--- Add lock token to email outbox for lease fencing.
ALTER TABLE "email_outbox"
ADD COLUMN "lock_token" UUID;

--- Ensure stale workers cannot complete jobs. The worker must match the lock token.
CREATE OR REPLACE FUNCTION fence_email_outbox_lease(p_job_id UUID, p_worker_token UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- Attempt to lock the job if it's PENDING and not already locked by another token
  UPDATE "email_outbox"
  SET "locked_at" = now(), "lock_token" = p_worker_token
  WHERE "id" = p_job_id
    AND "status" = 'PENDING'
    AND ("locked_at" IS NULL OR "locked_at" < now() - INTERVAL '5 minutes')
    AND ("lock_token" IS NULL OR "lock_token" = p_worker_token);

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

--- Cleanup expired locks (5 minutes threshold)
CREATE OR REPLACE FUNCTION cleanup_stale_outbox_locks()
RETURNS VOID AS $$
BEGIN
  UPDATE "email_outbox"
  SET "locked_at" = NULL, "lock_token" = NULL
  WHERE "status" = 'PENDING'
    AND "locked_at" IS NOT NULL
    AND "locked_at" < now() - INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql;

--- Index for finding pending jobs to lease.
--- Partial index predicates must be IMMUTABLE, so this cannot reference now().
--- Staleness is evaluated by the query, not by the index predicate.
CREATE INDEX "email_outbox_lease_candidate_idx"
ON "email_outbox" ("status", "next_attempt_at")
WHERE "status" = 'PENDING';