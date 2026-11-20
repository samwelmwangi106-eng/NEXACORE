CREATE TYPE "Industry" AS ENUM ('SCHOOL', 'SACCO', 'CLINIC', 'RENTAL');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED');
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(6),
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "industry" "Industry" NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organisations_slug_key" ON "organisations"("slug");
CREATE INDEX "organisations_industry_status_idx" ON "organisations"("industry", "status");

CREATE TABLE "organisation_members" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organisation_members_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "organisation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "organisation_members_organisation_id_user_id_key" ON "organisation_members"("organisation_id", "user_id");
CREATE UNIQUE INDEX "organisation_members_id_organisation_id_key" ON "organisation_members"("id", "organisation_id");
CREATE INDEX "organisation_members_user_id_status_idx" ON "organisation_members"("user_id", "status");
CREATE INDEX "organisation_members_organisation_id_status_idx" ON "organisation_members"("organisation_id", "status");

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_system_role" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "roles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roles_organisation_id_name_key" ON "roles"("organisation_id", "name");
CREATE UNIQUE INDEX "roles_id_organisation_id_key" ON "roles"("id", "organisation_id");

CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

CREATE TABLE "member_roles" (
    "organisation_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    CONSTRAINT "member_roles_pkey" PRIMARY KEY ("member_id", "role_id"),
    CONSTRAINT "member_roles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_roles_member_id_organisation_id_fkey" FOREIGN KEY ("member_id", "organisation_id") REFERENCES "organisation_members"("id", "organisation_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_roles_role_id_organisation_id_fkey" FOREIGN KEY ("role_id", "organisation_id") REFERENCES "roles"("id", "organisation_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "member_roles_organisation_id_role_id_idx" ON "member_roles"("organisation_id", "role_id");

CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id"),
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");
CREATE INDEX "refresh_sessions_user_id_expires_at_idx" ON "refresh_sessions"("user_id", "expires_at");
CREATE INDEX "refresh_sessions_family_id_revoked_at_idx" ON "refresh_sessions"("family_id", "revoked_at");

CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");
CREATE INDEX "auth_tokens_user_id_type_expires_at_idx" ON "auth_tokens"("user_id", "type", "expires_at");

CREATE TABLE "organisation_invitations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organisation_invitations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "organisation_invitations_role_id_organisation_id_fkey" FOREIGN KEY ("role_id", "organisation_id") REFERENCES "roles"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "organisation_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "organisation_invitations_token_hash_key" ON "organisation_invitations"("token_hash");
CREATE INDEX "organisation_invitations_organisation_id_email_expires_at_idx" ON "organisation_invitations"("organisation_id", "email", "expires_at");
CREATE INDEX "organisation_invitations_organisation_id_created_at_idx" ON "organisation_invitations"("organisation_id", "created_at");

CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "recipient" VARCHAR(320) NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_outbox_status_next_attempt_at_created_at_idx" ON "email_outbox"("status", "next_attempt_at", "created_at");

CREATE TABLE "platform_permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    CONSTRAINT "platform_permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_permissions_key_key" ON "platform_permissions"("key");

CREATE TABLE "platform_admin_grants" (
    "user_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_admin_grants_pkey" PRIMARY KEY ("user_id", "permission_id"),
    CONSTRAINT "platform_admin_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "platform_admin_grants_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "platform_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "platform_admin_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_admin_grants_permission_id_user_id_idx" ON "platform_admin_grants"("permission_id", "user_id");

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "actor_user_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entity_type" VARCHAR(100),
    "entity_id" VARCHAR(100),
    "request_id" VARCHAR(100),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "audit_logs_organisation_id_created_at_idx" ON "audit_logs"("organisation_id", "created_at");
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");
