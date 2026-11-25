# NexaCore backend

Express 5 + Prisma 6 API for a multi-tenant SaaS platform, structured as a modular monolith.

## Layout

```
src/
  app.js                     Express app assembly, rate limiting, error/404 handling
  server.js                  HTTP entry point
  config/
    env.js                   Zod-validated environment loading
    permissions.js           Permission catalogue + industry scoping
    platform-permissions.js  Platform-level (cross-tenant) permissions
  middleware/
    authenticate.js          Access-token + live account/tokenVersion check
    tenant.js                Membership resolution, permission guard, industry filter
    platform-permission.js   Platform-admin guard
    validate.js              Zod request validation
  modules/
    auth/                    Registration, verification, sessions, mailer
    organisations/           Organisation, invitations, membership/roles, settings
    notifications/           Encrypted email outbox + crypto
    audit/                   Audit records
    school/                  School module service + schemas  <- industry module
  routes/                    Route factories (auth, platform, invitation, school)
  lib/                       Prisma adapter, security primitives, SQL migration runner
  workers/                   Email outbox worker
prisma/
  schema.prisma              Data model
  migrations/                Checked-in SQL migrations (see below)
  deploy.js                  Migration deployment entry point
test/                        Unit, API, tenant, and embedded-PostgreSQL suites
```

## Tenant boundary

Every tenant-scoped route uses `createRequireTenant`, which resolves a membership scoped to **both** the authenticated user and the requested organisation, and requires `status: ACTIVE` with an `ACTIVE` organisation. Failures return `404 ORGANISATION_NOT_FOUND` rather than `403`, so organisation existence is not disclosed to non-members.

`req.tenant.id` is the organisation id; `req.tenant.membershipId` is the membership row.

Permissions are resolved from the member's roles and filtered by industry: a permission that belongs to another industry is not granted even if a role contains it.

## Migrations

Applied in lexical order by `src/lib/migrations.js` (raw SQL over `pg`, serialized with a PostgreSQL advisory lock, checksummed in `_prisma_migrations`):

| Migration | Contents |
|---|---|
| `202611160001_platform_foundation` | Users, organisations, members, roles, permissions, invitations, refresh sessions, auth tokens, audit log, email outbox |
| `202611160002_school_foundation` | **School module**: profile, academic years, terms, grade levels, class sections |
| `202611160003_permission_invitation_hardening` | `roles.read` permission, industry-scoped role-permission cleanup, email normalisation, one-live-invitation invariant |
| `202611160004_outbox_lease_fencing` | `lock_token` column, `fence_email_outbox_lease()`, `cleanup_stale_outbox_locks()` |

The School migration is deliberately separate from the shared platform migrations so the industry module can be enabled or dropped per deployment. Because migrations run in lexical order, a fresh environment must include the School migration before the hardening migrations are applied.

```sh
npm run db:deploy   # apply pending SQL migrations
```

Do **not** use `prisma migrate deploy` with the current JS schema-engine adapter configuration — see the root README.

## Guarantees worth knowing before you change this code

These are backed by tests (`npm test`) and, where marked, verified directly against PostgreSQL.

- **One live invitation per email per organisation.** Enforced by a partial unique index on `(organisation_id, lower(email))` where `accepted_at is null and revoked_at is null`. Concurrent duplicates are rejected by the database (`23505`), not only by application checks. *(Verified under 6-way concurrency.)*
- **Invitations are single-use.** Acceptance is a conditional `UPDATE ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`; only a row count of 1 proceeds. *(Verified with 8 concurrent acceptors: exactly one winner.)*
- **Duplicate live invitations return 409, not 500.** The partial unique index raises Prisma `P2002`; `invitation.service.js` maps that code to `409 INVITATION_ALREADY_EXISTS`. Other error codes are re-thrown unchanged, so a genuine database fault is never disguised as a conflict.
- **A suspended organisation cannot be joined by invitation, even under a concurrent suspension.** Acceptance takes the per-organisation advisory lock *inside* its transaction and re-reads `organisation.status` under that lock; `changeOrganisationStatus` takes the same lock before writing. Whichever commits first wins, and acceptance can never commit membership into a suspended organisation. The pre-transaction status check is only a fast path that avoids opening a transaction — it is not the guarantee. *(Verified on real PostgreSQL with a forced interleaving: with the lock, acceptance is refused with `403 ORGANISATION_NOT_ELIGIBLE` and zero memberships; with the lock disabled, the same interleaving lets the suspended organisation gain a member.)*
- **Invitation *creation* is covered upstream** because `requireTenant` only resolves memberships whose `organisation.status` is `ACTIVE`.
- **An organisation always retains one active owner.** Ownership mutations (`updateMemberStatus`, `setMemberRoles`) take `pg_advisory_xact_lock` keyed on the organisation before reading owner state, because the guard is a read-then-write and is otherwise lost-update-prone. *(Verified against real PostgreSQL. Owner **removal** race, measured directly: without the lock both concurrent removals commit and the organisation is left with **0 active owners**; with the lock one commits and the other is refused with `409 LAST_OWNER_REQUIRED`, leaving **1 active owner**. Two concurrent suspensions without the lock likewise left zero owners; with the lock, one is blocked and one owner remains. Concurrent owner **demotion** behaves the same way — one `demoted`, one `blocked(LAST_OWNER_REQUIRED)`, one owner remaining. The advisory lock is transaction-scoped and released at `COMMIT`, confirmed by a second session observing the lock count return to 0, so it does not serialise that organisation permanently.)*
- **Organisation settings are allowlisted and merged.** `organisation.settings.js` rejects unknown keys and type/shape violations; a `PATCH` merges over the stored value so omitted keys are preserved. `null` clears a key. Organisation writes build an explicit `data` object — never spread `req.body` into a Prisma update.
- **Settings cannot be used to pollute prototypes or reach sensitive columns.** Keys are matched with `hasOwnProperty` against a frozen allowlist, so `__proto__`, `constructor`, and `toString` are rejected as unknown. `mergeSettings` copies into a fresh object and never mutates the stored value or `Object.prototype`. Security-sensitive fields (`status`, `industry`, `slug`, `id`, `createdAt`, `plan`, `isPlatformAdmin`) are unreachable: the PATCH schema is `.strict()` and admits only `name` and `settings`.
- **Outbox delivery is lease-fenced.** When the worker passes a `workerToken`, the claim stamps `lock_token` and every terminal write is guarded on it, so a worker whose lease was taken over cannot mark another worker's job sent or failed. Terminal failures emit an audit event with redacted error text.
- **Errors are non-enumerating.** Login, password reset, and invitation inspection do not reveal whether an account exists. Audit metadata must never contain passwords or raw tokens.

## Environment

See `.env.example`. Required highlights: `DATABASE_URL`, `ACCESS_TOKEN_SECRET` (≥32 chars), `EMAIL_OUTBOX_ENCRYPTION_KEY` (base64 32 bytes), and either console or SMTP mailer configuration. Production refuses insecure cookies and the console mailer.

Generate a key with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never commit `.env` or key files; both are gitignored.

## Tests

```sh
npm ci
npm test                  # everything
npm run test:integration  # embedded PostgreSQL only
```

Unit and API suites need no external database. The integration suite starts an isolated PostgreSQL 17 cluster via `embedded-postgres`, applies all migrations, and requires a generated Prisma client (`npm run db:generate`).

### Current result

`node --test` -> **82 tests, 76 pass, 6 fail** (repository state as of this verification).

All 6 failures are in `test/integration/postgres.integration.test.js` and every one of them fails with the same message:

```
'@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.'
```

They are **environment-blocked, not passing, and not evidence of a code defect**. The cause is that `prisma generate` unconditionally downloads a native schema engine from `binaries.prisma.sh`; that host is unreachable from the verification sandbox (TLS handshake fails on `schema-engine.gz.sha256`). `--no-engine`, the `queryCompiler` preview feature, and the environment overrides `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING`, `PRISMA_CLI_QUERY_ENGINE_TYPE`, and `PRISMA_SCHEMA_ENGINE_BINARY` were all tried and none bypass the fetch. No `@prisma/query-engine-*` binary package is published to npm for this version, so there is no offline substitute.

### What the real-PostgreSQL concurrency tests actually exercise

`test/concurrency-postgres.test.js` (8 tests, all passing, driven by `test-support/real-pg-harness.js`) starts a real PostgreSQL 17 cluster, applies every migration, and calls the **real** `invitation.service.acceptInvitation`, `platform-admin.service.changeOrganisationStatus`, and `access.service.updateMemberStatus`. Interleavings are forced deterministically by stalling a transaction immediately after it acquires the advisory lock, rather than by sleeping.

One limitation must be stated plainly: because `prisma generate` is blocked here, the generated Prisma Client runtime does not exist, so these tests use a shim that implements only the Prisma Client methods those services call, delegating every query to the real `@prisma/adapter-pg` driver adapter. **The Prisma Client generated runtime itself is therefore not exercised.** What is real in these tests: the service logic (unmodified), the PostgreSQL database, the transactions, the advisory locks, and every SQL statement. What is shimmed: the ORM method surface. To close that gap, run `npm run db:generate && npm test` on a machine that can reach `binaries.prisma.sh`.

The tests include controls that fail if the guarantee is removed: disabling the tenant lock makes the suspended-organisation-gains-membership test reproduce the bug, and disabling the ownership lock is shown to leave an organisation with zero active owners. These were confirmed by mutation runs during development.
