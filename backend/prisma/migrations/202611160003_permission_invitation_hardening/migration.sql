-- Add role-definition visibility without coupling it to role mutation.
INSERT INTO "permissions" ("id", "key", "description")
VALUES (gen_random_uuid(), 'roles.read', 'View organisation roles and permissions')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."key" = 'roles.read'
WHERE r."name" IN ('Organisation Owner', 'Organisation Administrator', 'Manager', 'Auditor')
ON CONFLICT DO NOTHING;

-- Do not retain or expose industry-specific capabilities on an organisation of another industry.
DELETE FROM "role_permissions" rp
USING "roles" r, "organisations" o, "permissions" p
WHERE rp."role_id" = r."id"
  AND r."organisation_id" = o."id"
  AND rp."permission_id" = p."id"
  AND ((p."key" LIKE 'school.%' AND o."industry" <> 'SCHOOL')
    OR (p."key" LIKE 'sacco.%' AND o."industry" <> 'SACCO')
    OR (p."key" LIKE 'clinic.%' AND o."industry" <> 'CLINIC')
    OR (p."key" LIKE 'rentals.%' AND o."industry" <> 'RENTAL'));

-- Normalize legacy pending invitation addresses before enforcing the case-insensitive live-email invariant.
UPDATE "organisation_invitations"
SET "email" = lower(btrim("email"));

-- Reconcile any legacy expired/duplicate pending rows before enforcing the live-email invariant.
UPDATE "organisation_invitations"
SET "revoked_at" = now()
WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expires_at" <= now();

WITH "ranked_live_invitations" AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "organisation_id", lower("email")
    ORDER BY "created_at" DESC, "id" DESC
  ) AS "rank"
  FROM "organisation_invitations"
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL
)
UPDATE "organisation_invitations" i
SET "revoked_at" = now()
FROM "ranked_live_invitations" r
WHERE i."id" = r."id" AND r."rank" > 1;

-- The partial unique index makes concurrent duplicate live invitations race-safe.
CREATE UNIQUE INDEX "organisation_invitations_one_live_email_key"
ON "organisation_invitations" ("organisation_id", lower("email"))
WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
