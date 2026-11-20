# NexaCore backend

This is the CommonJS/Express modular-monolith API and its PostgreSQL-backed workers. It owns authentication, organisation membership, tenant and platform permissions, audit events, notification delivery, and the limited School academic-structure foundation. Do not treat it as a production-ready system without the outstanding reviews below.

## Prerequisites and local setup

- Node.js 22+ and npm.
- Docker Compose for local PostgreSQL 17, or a PostgreSQL 17-compatible server.

From the repository root:

```sh
cp backend/.env.example backend/.env
# Replace JWT_ACCESS_SECRET and EMAIL_OUTBOX_ENCRYPTION_KEY with locally generated values.
openssl rand -base64 48
openssl rand -base64 32
# Keep the Compose-only development password out of production.
docker compose up -d postgres
```

Put the first generated value in `JWT_ACCESS_SECRET` and the second in `EMAIL_OUTBOX_ENCRYPTION_KEY`. The latter must decode to exactly 32 bytes. `DATABASE_URL` in the example matches the local Compose defaults; change both sides if you use different local credentials. Never commit `.env` files or use development credentials for deployment.

Then, from `backend/`:

```sh
npm ci
npx prisma validate
npm run db:generate
npm run db:deploy
npm test
npm run dev
```

The API listens on `0.0.0.0:4000`; `GET /health` is a liveness endpoint. The integration suite starts its own temporary PostgreSQL 17 cluster and does not need the Compose database.

## Dependencies and structure

- Express 5, Zod, bcrypt, JWT, Helmet, CORS, cookie-parser, express-rate-limit.
- Prisma 6.19.3 client with `@prisma/adapter-pg`; direct PostgreSQL access for the custom migration runner uses `pg`.
- `src/routes/` maps HTTP endpoints; `src/modules/` contains domain services; `src/middleware/` enforces identity, tenant and permission checks; `src/workers/` contains background processing.
- `prisma/schema.prisma` and checked-in SQL migrations define persistence. SQL migration files are immutable once applied; add a new timestamped migration for future schema changes.

## Configuration

`src/config/env.js` validates the required variables. [`.env.example`](.env.example) is the safe local template.

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT` | Runtime mode and API port |
| `DATABASE_URL` | PostgreSQL application connection |
| `MIGRATION_DATABASE_URL` | Optional direct PostgreSQL connection for the session-locking SQL migrator; falls back to `DATABASE_URL` |
| `JWT_ACCESS_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS` | Access-token signing and session lifetimes |
| `WEB_ORIGIN`, `COOKIE_SECURE` | CORS origin and refresh-cookie security |
| `BCRYPT_ROUNDS` | Password hash work factor |
| `MAIL_MODE`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | Development console or SMTP transport |
| `EMAIL_OUTBOX_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256-GCM key for outbox payloads |

Production rejects insecure cookies and console mail mode. Use a secrets manager, TLS, database least-privilege credentials and a documented key recovery/rotation procedure. Do not print or paste real configuration values into source control or issue reports.

## Database, Prisma and Neon

The verified migration command is `npm run db:deploy`. It applies the repository SQL files in lexical order, inside a transaction per migration, records checksums in `_prisma_migrations`, and uses a **session-level PostgreSQL advisory lock**. A second deployment of the same migration set is a no-op after checksum verification.

In this Prisma 6.19.3 configuration, native `prisma migrate deploy`/`prisma migrate status` previously failed against PostgreSQL with `Column type 'name' could not be deserialized from the database`. The SQL runner is the verified deployment path; Prisma Client generation and real PostgreSQL queries are separately tested. Do not edit an applied migration to work around this issue.

Neon is not yet verified. `DATABASE_URL` is used by the application; `MIGRATION_DATABASE_URL` may point the SQL runner to a separate direct connection and defaults to `DATABASE_URL`. The runner's session-level advisory lock must **not** be assumed to work through a transaction-pooled endpoint. Verify the direct endpoint, TLS, pool behavior, and migration idempotence against Neon before deployment. No hosting provider has been selected.

The runner now rejects missing applied migration files, duplicate active history records, changed checksums, unfinished history, and migration directories without SQL. Each migration is atomic; a failed migration rolls back and reports rollback failure without hiding the cause. Applied SQL remains immutable. The session lock is still not verified on any Neon endpoint. Manual rollback procedures, schema/data drift comparison, concurrent deployment integration tests, deployment health checks, and pool-acquisition/release failure tests remain open.

## API overview

All URLs below are under `/api/v1`. Authenticated API routes take `Authorization: Bearer <access-token>`. Tenant routes resolve membership in the backend using both authenticated user ID and requested organisation ID.

| Route | Purpose |
|---|---|
| `/auth/register`, `/auth/verify-email`, `/auth/login` | Registration, one-use verification, sign-in |
| `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password` | Non-enumerating recovery requests and one-use reset |
| `/auth/refresh`, `/auth/logout` | Refresh-cookie rotation and revocation |
| `/me`, `/organisations` | Current account and its organisations |
| `/organisations/:organisationId/...` | Tenant-scoped organisation, member, role and audit endpoints |
| `/organisations/:organisationId/invitations` | Organisation invitation creation/revocation |
| `/accept`, `/signup` | Invitation validation and signup for a new account |
| `/organisations/:organisationId/school/...` | School profile, years/terms, grade levels and class sections |
| `/platform/...` | Separate platform-administration routes, guarded by platform grants |

School routes require `industry = SCHOOL`; reads require `school.read`, writes require `school.manage`. No learner/guardian, attendance, assessment, billing, Clinic, SACCO or Rental workflows are implemented.

## Authentication and session behavior

Passwords are bcrypt-hashed. Verification and password-reset tokens are random, single-use, stored as hashes, and expired. Access tokens include a session ID and token version; protected requests read the corresponding live refresh session and current user status/version. Password reset increments the token version and revokes refresh sessions.

The refresh credential is an HTTP-only, `SameSite=Strict` cookie scoped to `/api/v1/auth`; production requires `COOKIE_SECURE=true`. CORS is restricted to `WEB_ORIGIN`. Cross-origin / CSRF protection still needs a dedicated Origin/Fetch-Metadata review. Access tokens are returned in JSON and are not stored by the server.

Refresh rotation uses a conditional database update so only one request can consume an old refresh token. Reuse of a revoked token revokes its whole family. A legitimate simultaneous refresh can be indistinguishable from replay and may revoke the family; a future browser client should use a single-flight refresh queue, but no frontend exists. Token verification/reset replay checks are covered by tests.

Auth requests share an in-process IP limit of 20 per 15 minutes. Verification resend and password-reset email requests each also have a limit of 3 per normalized email per hour; verification/reset token checks are limited to 10 per IP per 15 minutes. Invitation endpoints share an in-process IP limit of 20 per 15 minutes. Limits use process memory and reset on restart; configure a shared distributed store before multi-instance deployment. Email-keyed request caps operate alongside the overall per-IP auth limit. Request IDs are assigned before JSON parsing and returned for malformed/oversized bodies; propagation into every authentication/recovery audit event still needs review.

## Organisation tenancy, permissions and lifecycle

- Organisation roles and platform permissions are separate. An organisation administrator cannot grant platform access.
- Tenant-owned records are queried with server-derived organisation IDs; composite foreign keys protect school year/grade/section and membership/role relationships.
- Industry-specific permissions are filtered at provisioning and authorization time; a forward-only migration removes mismatched stored permissions. Generic permissions remain shared.
- `roles.read` now gates role listing; `roles.manage` remains the mutation/assignment permission. Default Owner, Administrator, Manager, and Auditor roles receive read access. Active memberships cannot be assigned zero roles.
- Member listing is not paginated. Organisation settings accept only `timeZone` (valid IANA identifier) and `weekStartsOn` (0–6); partial settings updates merge rather than erase other common settings. Industry-specific settings remain in industry modules.
- Owner membership transitions and platform suspension serialize on organisation rows, and owner counts require an active membership plus an active, verified account. Platform grants can only be issued to active, email-verified users. Organisation suspension blocks tenant API and invite acceptance while retaining memberships and unexpired invites for possible reactivation.

## Invitations

Invitations are restricted to unregistered email addresses. A tenant may have one live invitation per normalized email; expired invites are marked revoked before reissue, and a partial unique index closes the concurrent-creation race. The selected role ID is stored and current permissions are effective at acceptance/use (no permission snapshot); Organisation Owner cannot be granted through invitation. A successful signup creates a `PENDING_VERIFICATION` account and an `INVITED` membership; email verification activates that invited membership. Invitation acceptance and status validation are rejected while the organisation is suspended, while the invitation remains available until expiry/reactivation. Active invites and verification-gated membership activation are covered by database integration tests. Existing accounts are intentionally rejected by this new-account-only flow; reconsider only if product scope changes. Background cleanup of expired invitation records, queued email pause during suspension, and unusual duplicate races still need further review.

## Email worker

Auth and invitation messages are enqueued transactionally in `email_outbox`; payload content is AES-256-GCM encrypted, while recipient addresses remain plaintext. Run it with:

```sh
npm run email:worker
```

The worker retries failures with exponential backoff and records a terminal failure. Each claim has a random lease token; success/failure acknowledgements are conditional on the current token, so a stale worker cannot overwrite a reclaimed row. SMTP send and database acknowledgement cannot be atomic: if SMTP accepts a message but the worker loses its DB acknowledgement, a retry can duplicate the email. A send lasting beyond the five-minute lease can also overlap a later attempt. Delivery is therefore **at least once**, not exactly once. SMTP failure classification, real crash/concurrency integration tests, health checks, alerts, queue inspection, bounded graceful shutdown, key rotation, recipient retention, and production SMTP connectivity remain to be addressed.

Console transport is development-only; console output can contain bearer-style one-time links and must not be captured in shared logs. SMTP is not tested against a production provider.

## Audit and request attribution

Audit rows include optional organisation, actor, action, target, request ID and JSON metadata. Tenant audit queries are scoped to one organisation; platform audit queries select platform-level rows. Application code uses append-oriented events, but the database does not enforce immutability. Audit contract/schema validation, redaction, pagination edge cases, retention, archival/legal hold, index review, and failure behavior still need dedicated work. Never log passwords or raw one-time/session tokens.

## Testing

```sh
npm test
npm run test:integration
npm audit --audit-level=low
```

The integration suite uses temporary real PostgreSQL 17 and covers authentication/session revocation, tenant membership/permissions, key database constraints, invitations, platform permission boundaries, and School foundation rules. It does not establish Neon compatibility, production SMTP behavior, distributed concurrency guarantees, migration rollback/reconciliation, or production hosting readiness. Coverage thresholds, lint/format checks, CI quality gates and broader infrastructure-failure tests are not configured yet.

## Open decisions and deferred risks

The invitation lifecycle, `roles.read` audience, no-zero-role rule, usable-owner invariant, platform-grant eligibility, two common settings, and baseline organisation-suspension behavior in this guide reflect the product choices approved for this phase. Remaining work includes:

- CSRF/Origin/Fetch-Metadata policy for refresh-cookie requests, browser refresh single-flight behavior, and endpoint-specific password/login defenses.
- Organisation lifecycle beyond ACTIVE/SUSPENDED, account removal/deletion, suspended-account membership reactivation, and handling industry customer/client identities.
- Consequences of suspending a tenant for already-queued invitation emails; currently the email may still send even though its acceptance endpoint rejects while suspended.
- Audit schema validation, field redaction, immutable/append-only database enforcement, retention, archival/legal hold, and access review.
- SMTP delivery classification, monitoring/alert thresholds, outbox retention/key rotation, credential rotation, and branded templates.
- Neon pooler/direct endpoint verification, connection limits, operational migration lock testing, zero-downtime migration policy, rollback procedure, and backup/restore testing.
- Hosting provider, production privacy/security review, distributed rate-limit store, and quality gates/coverage thresholds.

## Deployment and security status

No backend Dockerfile, CI deployment pipeline, hosting-specific configuration, backup/restore runbook, or disaster-recovery plan is present. Do not add provider-specific deployment artifacts until hosting is approved. Before launch, resolve the open decisions above; test migrations on the actual database provider; configure pool limits and secrets; exercise backup restore, SMTP, worker recovery, rate limiting, CSRF and concurrent authorization changes; and obtain qualified privacy/security review. No regulatory-compliance claim is made.
