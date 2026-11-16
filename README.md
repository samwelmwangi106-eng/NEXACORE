# NexaCore

NexaCore is a multi-tenant SaaS platform foundation built as a modular monolith. The shared platform layer currently covers accounts, organisations, membership/roles, invitations, platform-level administration, audit records, and queued email. School, SACCO, Clinic, and Rentals workflows are **not implemented** and are not part of this phase. No Kenyan legal or regulatory compliance has been assessed or certified.

## Architecture and tenant boundary

- Node.js CommonJS, Express 5, Zod, bcrypt, JWT, PostgreSQL, Prisma 6, and a React/Vite frontend stack planned for later.
- Organisation access is checked on every backend request using the authenticated user and active membership. The organisation identifier supplied in a URL is a selector, never proof of access.
- Organisation permissions and platform permissions are separate. Organisation roles cannot confer platform-admin rights.
- PostgreSQL composite tenant foreign keys guard role and membership assignments against cross-organisation references.
- Access JWTs include a session ID and token version. Protected requests check the live refresh session and current user version, enabling immediate revocation.
- Verification, reset, and invitation tokens are random, single-use, hashed in the database, and expire. Notification payloads are encrypted at rest in a retrying PostgreSQL outbox.
- Sensitive changes are recorded in append-oriented audit records. This is an application-level convention, not a separately privileged immutable audit store.

## Prerequisites

- Node.js 22+ and npm
- Docker Compose (or a PostgreSQL 17-compatible server)

## Local setup

1. Start PostgreSQL from the repository root:

   ```sh
   docker compose up -d postgres
   ```

2. Configure local secrets:

   ```sh
   cp backend/.env.example backend/.env
   # Set unique random values; do not commit backend/.env.
   openssl rand -base64 48       # JWT_ACCESS_SECRET (keep at least 32 characters)
   openssl rand -base64 32       # EMAIL_OUTBOX_ENCRYPTION_KEY (exactly 32 decoded bytes)
   ```

   Put those generated values into the matching variables in `backend/.env`. For deployed environments, use a secret manager, TLS, and managed PostgreSQL; do not use Compose's local default password.

3. Install backend dependencies, validate/generate the Prisma client, and deploy the committed SQL migrations:

   ```sh
   cd backend
   npm ci
   npx prisma validate
   npm run db:generate
   npm run db:deploy
   ```

   `db:deploy` runs the checked-in `prisma/migrations/*/migration.sql` files transactionally through PostgreSQL's `pg` driver, serializes deployments with a PostgreSQL advisory lock, and records checksums in `_prisma_migrations`. This is intentional: in the current Prisma 6.19.3 JS schema-engine adapter configuration, `prisma migrate deploy` fails against PostgreSQL with `Column type 'name' could not be deserialized from the database`. The SQL migration itself and Prisma Client have been exercised against PostgreSQL 17. Do not use `prisma migrate deploy` or `prisma migrate status` with this configuration until the schema-engine adapter limitation is resolved. New schema changes require a reviewed SQL migration and a matching `schema.prisma` update; do not edit already-applied migrations.

4. Run tests and start the API:

   ```sh
   npm test                  # unit, API, and embedded-PostgreSQL integration suite
   npm run test:integration  # real PostgreSQL suite only
   npm run dev
   ```

The API listens on `0.0.0.0:4000`; liveness is `GET /health`, API base path is `/api/v1`. The PostgreSQL integration suite starts an isolated PostgreSQL 17 cluster using `embedded-postgres`, applies the checked-in SQL migration, exercises the real Prisma PostgreSQL adapter and tears the cluster down. It does not need a separately running Compose database.

## Email delivery

Auth messages and organisation invitations are persisted to `email_outbox` in the same database transaction as the action that creates them. Payloads use AES-256-GCM with `EMAIL_OUTBOX_ENCRYPTION_KEY`; the key must be base64 encoding exactly 32 random bytes. Start the separate worker with:

```sh
cd backend
npm run email:worker
```

The worker uses `MAIL_MODE=console` only in development or SMTP when configured. It retries with exponential backoff, records terminal failures, and logs/audits delivery failure without storing the original message body in plaintext. Keep the encryption key stable and backed up; rotating it requires an explicit outbox re-encryption/retention plan. Console output can contain verification/reset links and must be treated as secret.

## Platform administrator bootstrap

There is deliberately no public self-service endpoint for granting platform powers. First create and verify an account through the normal auth flow, then, from `backend/`, run:

```sh
PLATFORM_BOOTSTRAP_EMAIL=verified-admin@example.com npm run platform:bootstrap-admin
```

This grants the initial account the distinct platform permission set and writes an audit record. Protect this one-time operational command and its database credentials. Thereafter, platform administrators can grant only permissions they themselves hold; the service prevents removal/suspension of the last active administrator. Platform routes are under `/api/v1/platform` and always require both authentication and the matching platform grant.

## Environment variables

See `backend/.env.example` and `backend/src/config/env.js` for validation. Main variables:

- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_ACCESS_SECRET`: random signing secret, at least 32 characters.
- `EMAIL_OUTBOX_ENCRYPTION_KEY`: base64 for exactly 32 random bytes.
- `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`: access and refresh lifetimes.
- `WEB_ORIGIN`: exact CORS origin.
- `COOKIE_SECURE`: enable in production behind HTTPS.
- `BCRYPT_ROUNDS`: password hashing work factor.
- `MAIL_MODE`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and paired optional `SMTP_USER`/`SMTP_PASSWORD`.

Production startup rejects insecure cookie settings and development console email mode. Use managed secrets, rate limits, TLS, least-privilege database credentials, backups, monitoring, and retention/deletion policies.

## API surface

All authenticated operations use `Authorization: Bearer <access-token>`. Error responses use a structured `error.code`, message, and request ID.

| Method and path | Purpose |
|---|---|
| `POST /api/v1/auth/register` | Create a pending account and initial organisation; enqueue email verification |
| `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/login` | Verify a one-time token or sign in |
| `POST /api/v1/auth/resend-verification`, `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password` | Account recovery with non-enumerating requests |
| `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` | Rotate or revoke refresh sessions |
| `GET /api/v1/me`, `GET /api/v1/organisations` | Read current account and accessible organisations |
| `/api/v1/organisations/:organisationId/...` | Tenant-scoped organisation, member, role and audit operations |
| `POST /api/v1/organisations/:organisationId/invitations` | Invite an unregistered email; defaults to the least-privileged Staff Member role |
| `DELETE /api/v1/organisations/:organisationId/invitations/:invitationId` | Revoke a pending tenant invitation |
| `POST /api/v1/accept`, `POST /api/v1/signup` | Inspect a valid invitation or create the invited account and membership |
| `/api/v1/platform/...` | Permission-separated organisation/user administration, platform grants and platform audit access |

Invitation signup is bound to the invitation email, selected organisation and role, and creates a pending account that must still verify its email. Organisation admins cannot assign a role containing permissions they do not have.

## Tests and verification evidence

- `npm test`: 43 tests passed in the last full run, including real PostgreSQL tests.
- `npm run test:integration`: 6 tests passed against PostgreSQL 17 in an isolated embedded cluster. They exercise real authentication and immediate access revocation, membership/tenant isolation, backend role permissions, invitation encryption/email binding/expiry/single use, platform-admin separation, unique identity constraints, and composite foreign-key rejection across tenants.
- `npx prisma validate` and `npx prisma generate`: passed with Prisma 6.19.3 after the current schema additions.
- SQL migrations were applied successfully to a fresh real PostgreSQL 17 cluster; the integration runner confirmed the expected tables and queried records through `@prisma/adapter-pg`.
- `prisma migrate deploy` through Prisma's JS schema engine remains blocked by the adapter deserialization error described above. The checked-in SQL deploy runner is the verified path; do not report native Prisma migration deployment as verified.

## Audit and sensitive operations

Audit events cover organisation and account lifecycle, tenant membership/role operations, invitations, platform status and grant changes, refresh-token reuse, password recovery, and terminal email delivery failures. Audit metadata must not contain passwords, raw access/refresh/invitation tokens, or unnecessary sensitive personal/health data. Financial workflows, payment providers, health records and the future AI adapter are not implemented. When built, payment initiation must remain pending until independently verified; approvals and disbursements require explicit authorized human action. AI must call authorized backend tools and must never have unrestricted database access. Clinic data requires additional controls and qualified legal/privacy review before real patient data is used; no compliance claim is made here.

## Deferred scope

This work preserves the shared modular monolith and does not begin Phase 4. No School, SACCO, Clinic or Rentals product workflow, frontend, payment workflow, independent AI engine, or direct AI database access is included. Additional launch hardening still needed includes independent security/privacy review, delivery-provider operational configuration, production secret management, and broader monitoring/recovery procedures.
