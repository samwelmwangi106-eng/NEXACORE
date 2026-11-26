# NexaCore — Stage D Implementation Plan

**Checkpoint:** `d1e964dff00556be430e04b5780eb7d99b7185be`
**Assessment commit:** `67d8c24f0ad1bbe32a45abbcba607cd2c55e124f`
**Branch:** `arena/8c9954b6-nexacore`
**Plan written at HEAD:** `67d8c24` (working tree clean)
**Status:** planning only. No source, schema, migration, dependency or database change was made in producing this document.

---

## 0. Critical correction to the Stage C diagnosis

Before anything else, this plan must record a finding that **overturns part of the accepted Stage C record**.

Stage C concluded that `prisma generate` was blocked because `binaries.prisma.sh` is unreachable, and attributed the six failing integration tests to that single environmental cause. **That diagnosis was incomplete.** Two distinct failure modes exist, and they were conflated:

| Condition | Observed result | Real cause |
|---|---|---|
| `DATABASE_URL` **unset** (no `backend/.env` in the sandbox) | `request to …/libquery_engine.so.node.sha256 failed, TLS` | The `prisma.config.js` schema-engine adapter throws before Prisma can use the JS engine, so the CLI falls back to the native engine and tries to download it |
| `DATABASE_URL` **set** to any value, even an unreachable one | `Error code: P1012 … You must specify the same number of fields in fields and references` (2 errors) | **The schema is invalid.** Generation cannot succeed regardless of network |

The decisive experiment: with `DATABASE_URL` set to a deliberately dead address (`postgresql://u:p@127.0.0.1:1/x`) and the two relation errors corrected **in an isolated `/tmp` copy only**, generation completed:

```
✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 214ms
```

No network was available during that run. **`prisma generate` does not require network access in this configuration** — the project already uses `engine: 'js'` and `engineType = "client"`, the Rust-free path. The `binaries.prisma.sh` error is a *symptom of the missing `DATABASE_URL`*, not an environmental impossibility.

### 0.1 The schema defect (a new D1 blocker)

`backend/prisma/schema.prisma` declares two relations with mismatched arity:

- line 159 (`MemberRole.role`): `fields: [roleId, organisationId]` → `references: [id]`
- line 217 (`OrganisationInvitation.role`): `fields: [roleId, organisationId]` → `references: [id]`

The database migrations declare the corresponding **composite** foreign keys:

```
member_roles_role_id_organisation_id_fkey:
  FOREIGN KEY ("role_id","organisation_id") REFERENCES "roles"("id","organisation_id")
organisation_invitations_role_id_organisation_id_fkey:
  FOREIGN KEY ("role_id","organisation_id") REFERENCES "roles"("id","organisation_id")
```

`Role` already has `@@unique([id, organisationId])`, so the correct Prisma declaration is `references: [id, organisationId]`. The schema is simply out of sync with the migrations it is supposed to describe. **D1 must fix this before any test can run**, and it is also exactly the class of defect the drift check in D1.5 exists to prevent.

This correction is recorded openly: the Stage C conclusion that the six tests were "environment-blocked, not evidence of a code defect" was **half right**. They are blocked, but at least part of the blockage is a real defect in the repository, not the environment.

---

## D1 — Prisma and verification baseline

### D1.1 Problem and evidence

- Six tests in `backend/test/integration/postgres.integration.test.js` have never executed (§0).
- `backend/src/modules/organisations/organisation.service.js:1` imports `{ MembershipStatus }` from `@prisma/client`, a value only the generated client provides. No test can currently import that module, so `createOrganisation` — the route behind `POST /api/v1/organisations` — has **never been executed by any test**.
- The schema does not validate, so the generated types are unverifiable.

### D1.2 Affected files

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | Two `references: [id]` → `references: [id, organisationId]` (lines 159, 217) |
| `backend/.env.example` | Confirm `DATABASE_URL` documented as required for generation |
| `backend/README.md` | Correct the "network-blocked" explanation |
| `README.md` | Correct the test-evidence section |
| `STAGE_C_FINAL_VERIFICATION.md` | Add a correction note (do **not** rewrite history; annotate) |

### D1.3 Proposed technical changes

**Version and engine configuration — no change required.** Pin and document what already exists:

- `@prisma/client` `6.19.3`, `@prisma/adapter-pg` `6.19.3`, `prisma` (dev) `6.19.3` — all `^6.19.3` in `backend/package.json`, resolved and verified at `6.19.3`.
- Generator: `provider = "prisma-client-js"`, `engineType = "client"`.
- `backend/prisma.config.js`: `experimental: { adapter: true }`, `engine: 'js'`, schema-engine adapter supplied by `PrismaPg`.
- **No dependency upgrade is proposed or needed.** The existing `effect@3.22.5` override and 0-vulnerability audit are preserved untouched.

**Required environment variables** for generation:

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Makes `prisma.config.js` construct its adapter | Any syntactically valid URL works for *generation*; it must be a **live** database only for `migrate`/`db pull` |

**Generation command:** `cd backend && npm run db:generate` → `prisma generate`.
**Validation command (cheap gate):** `npx prisma validate`.

**Database requirements:** generation needs **no database**. The six integration tests need none pre-provisioned either — `postgres.integration.test.js:68` starts an ephemeral cluster via `embedded-postgres` and applies migrations through `applyMigrations` (`src/lib/migrations.js`). **No Neon, staging, or shared database is contacted by any test.**

**Exact test commands:**

```sh
cd backend
npm ci
npx prisma validate                      # fast schema gate
npm run db:generate                      # requires DATABASE_URL set
npm test                                 # all 82 existing tests (all passing after D1)
npm run test:integration                 # the 6 previously-blocked tests
node --test test/concurrency-postgres.test.js
```

### D1.4 Environment separation (local / test / Neon)

This must be stated as a rule, because it is currently only implicit:

| Environment | Database | Configuration source |
|---|---|---|
| **Test** | Ephemeral `embedded-postgres` cluster, per-run temp dir, port `0`, destroyed after the run | Constructed in-test; never reads `DATABASE_URL` |
| **Local** | `docker-compose.yml` service `postgres` (17-alpine), `nexacore_dev` | `backend/.env`, gitignored |
| **Production / Neon** | The selected Neon database | Deployed environment secrets only |

Enforcement points to add:

1. `.env.example` must state that tests never use `DATABASE_URL`.
2. The integration test must **assert** its `connectionString` points at `127.0.0.1` and is not the configured `DATABASE_URL`, so a mis-set environment can never run destructive migrations against Neon.
3. No script may fall back to a default `DATABASE_URL`.
4. **This plan does not change the Neon database, its configuration, or any connection string.**

### D1.5 Schema-drift check (new, D1 addition)

`prisma migrate diff` is available (verified: `--from-url`, `--to-url`, `--from-empty`). Add a check comparing the Prisma datamodel against the migrated database:

```sh
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
```

Invoked against the ephemeral cluster, never Neon. `--exit-code` makes CI fail on drift. This is what would have caught the §0.1 defect.

### D1.6 Security and tenancy implications

- Generation is read-only apart from writing into `node_modules`.
- The drift check reads a throwaway local database only.
- Guarding the integration test against `DATABASE_URL` protects production data from a developer error — a real risk given `applyMigrations` will happily create and delete schema objects.

### D1.7 Required tests and acceptance criteria

1. `npx prisma validate` exits 0.
2. `npm run db:generate` exits 0 **offline** — proven by running with the network unavailable.
3. All **82 existing tests still pass** (76 pass / 6 fail becomes 82 pass).
4. The 6 integration tests pass; each failure that remains is documented with its real cause.
5. Drift check exits 0.
6. If any of the 6 fail, they are triaged as genuine defects — **not** re-labelled as environmental.

### D1.8 Dependencies and order

**First.** Everything else depends on a generated client, because no service touching `@prisma/client` can be tested.

### D1.9 Risks and rollback

| Risk | Mitigation |
|---|---|
| The composite-FK change might not be the only schema error | `prisma validate` is iterative; fix until clean before generating |
| Generated client could change behaviour of existing mocked tests | Those tests use doubles; run the full suite immediately |
| Drift check could report pre-existing intentional divergence | Establish the baseline as part of D1; if divergence is found, decide explicitly rather than suppressing |
| Rollback | Revert the two-line schema change; nothing in the database changes because no migration is altered |

---

## D2 — School module completion

### D2.0 Scope note — the assessment under-reported this area

Planning uncovered **two further defects** beyond the three accepted (D1/D2/D3 of the assessment), both invisible to the current suite:

- **D4 — `updateTerm` will throw on any activation.** `school.service.js:146` reads `current.academicYear.status`, but the query at `:138-140` has no `include: { academicYear: true }`. A real Prisma client returns `undefined` for an un-included relation, so `current.academicYear.status` raises `TypeError`. This path has never run because the client was never generated.
- **D5 — `gradeLevelId` is never validated against the organisation.** `createSection` and `updateSection` accept a `gradeLevelId` and write it straight through. Cross-tenant protection survives only because of the composite FK `(grade_level_id, organisation_id) → school_grade_levels(id, organisation_id)`, which raises a raw database error rather than a clean 400/404. The behaviour is *safe* but *untranslated*.

Neither was claimed in the accepted assessment; both are recorded here with evidence.

### D2.A — School profile provisioning

**Problem and evidence.** No code path creates a `SchoolProfile`. `grep -rn "schoolProfile\.\(create\|upsert\)" src/ prisma/` returns nothing; `prisma/seed.js` has no school handling. `getProfile`/`updateProfile` both `findUnique` then `update`, throwing `404 SCHOOL_PROFILE_NOT_FOUND`. Every SCHOOL organisation created by either path (`auth.service.js:113` at registration, `organisation.service.js:8` via `POST /organisations`) therefore gets all 14 school endpoints returning 404.

**Affected files**

| File | Change |
|---|---|
| `backend/src/modules/organisations/organisation.service.js` | Create profile after organisation creation when `industry === 'SCHOOL'` |
| `backend/src/modules/auth/auth.service.js` | Same, inside the registration transaction |
| `backend/src/modules/school/school.service.js` | `updateProfile`: `findUnique`→`update` becomes `upsert` (idempotent safety net) |
| `backend/prisma/schema.prisma` | **No change** — `schoolProfiles` relation and unique index already exist |

**Proposed approach.** Two layers, deliberately:

1. **Lifecycle provisioning (primary).** Both organisation-creation sites create the profile **inside their existing transaction**, guarded by `industry === 'SCHOOL'`. This satisfies "every new SCHOOL organisation", "no profiles for other industries", and "transactionally safe" in one place each.
2. **Idempotent upsert (safety net).** `updateProfile` uses `upsert` so a profile can still be established for a legacy tenant, and a retry cannot fail.

A shared helper — `ensureSchoolProfile(tx, organisation)` in `src/modules/school/school.service.js` — is used by both call sites rather than duplicating logic. It is a function call, not a new abstraction layer.

**Duplicate prevention.** Already guaranteed by the database: `school_profiles_organisation_id_key` is a **unique index on `organisation_id`** (migration 002, line 18). An upsert keyed on that column cannot duplicate. No new constraint is needed.

**Existing SCHOOL organisations lacking profiles.** These must be handled without a data migration in this stage:

- The `upsert` in `updateProfile` makes any tenant self-healing on first write.
- A **one-time backfill** is required for tenants that never touch the API. Proposed as an idempotent script (`prisma/backfill-school-profiles.js`), `INSERT … SELECT … WHERE industry='SCHOOL' ON CONFLICT (organisation_id) DO NOTHING`, run manually and audited. **It is not a migration** and must not run automatically.
- Decision required at approval: whether the backfill ships in D2 or is deferred with a documented known gap.

**Database and migration implications.** **None.** The table, unique index, and FK already exist. This is a code-only change — an important point given the constraint against migrations.

**Security and tenancy implications.** The profile is always keyed on the `organisationId` of the transaction that created it; a caller can never supply it. `updateProfile` already scopes by `req.tenant.id`. No cross-tenant surface is added.

**Required tests and acceptance criteria**

1. Registering a SCHOOL organisation produces exactly one profile.
2. Registering SACCO / CLINIC / RENTAL produces **none** (asserted by count, not by absence of a call).
3. `POST /organisations` with `industry: 'SCHOOL'` produces exactly one profile.
4. A rolled-back registration leaves **no** profile (`assert` count 0), proving transactional atomicity.
5. `PUT /school/profile` on a tenant with no profile creates it via upsert (201/200, not 404).
6. Calling provisioning twice yields one row (unique index honoured).

### D2.B — Date handling

**Problem and evidence.** Eight schema fields use `z.date()` (`school.schemas.js` lines 11, 12, 18, 19, 26, 27, 34, 35). JSON delivers strings, so every academic-year and term create/update fails `400 VALIDATION_ERROR` with `expected date, received string` — verified by direct execution in the assessment. All other schemas in the repository avoid this; the school module is the outlier.

**Affected files:** `backend/src/modules/school/school.schemas.js` only (`classSection` has no date fields, so it is unaffected).

**Date semantics — decided deliberately, not by indiscriminate coercion.** This is the crux of the sub-task, so the semantics are stated first:

1. **Wire format.** Dates are transmitted as ISO-8601 **calendar dates** (`YYYY-MM-DD`), because the database columns are `@db.Date` (`starts_on`, `ends_on` are `Date`, not `Timestamptz`). A time component would be silently discarded by PostgreSQL anyway, so accepting one would be misleading.
2. **Acceptance rule.** A value must match `^\d{4}-\d{2}-\d{2}$` **and** survive a real calendar check (`2026-02-30` must be rejected, which a regex alone cannot do).
3. **Timezone behaviour.** A bare calendar date carries no timezone and must not acquire one. Parse as UTC midnight (`Date.UTC`) so the stored `DATE` is the date the user wrote, independent of server locale. **Do not** use `new Date('2026-01-05')` semantics blindly, and **do not** use `z.coerce.date()` on arbitrary input, which accepts `1704067200000` and other surprising forms.
4. **Invalid dates.** Rejected with a field-level 400 via the existing `validate` middleware. No silent clamping, no default substitution.
5. **Range coherence.** `endsOn` must not precede `startsOn`; this requires a `.refine()` on the object schema, because it is a cross-field rule.
6. **Non-date fields unchanged.** `weekStartsOn` stays an integer 1–7; `timeZone` stays a string validated against the school profile.

**Proposed change.** A single shared `calendarDate` schema helper in `school.schemas.js`:

```js
const calendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO calendar date (YYYY-MM-DD)')
  .refine(isRealCalendarDate, 'Not a real calendar date')
  .transform(function toUtcMidnight(value) {
    return new Date(value + 'T00:00:00.000Z');
  });
```

Then each schema replaces `z.date()` with `calendarDate`, and create/update schemas gain `endsOn >= startsOn` refinements where both are present.

**Explicitly rejected alternative:** `z.coerce.date()`. It would "work", but it accepts numeric epochs and locale-dependent strings, which contradicts the stated semantics and would make the API unpredictable. The assessment asked not to apply indiscriminate coercion; this is why.

**Database and migration implications.** None; columns are already `DATE`.

**Security and tenancy implications.** None beyond existing tenant scoping. Input is strictly validated, which narrows rather than widens the attack surface.

**Required tests.** Valid date accepted and stored as the same calendar date; `2026-02-30` rejected; `05/01/2026` rejected; epoch number rejected; `endsOn < startsOn` rejected; a date near midnight in a non-UTC server timezone still stores the intended date; update schema behaves identically.

**Acceptance criteria.** All eight fields accept documented input, reject everything else with a field-level 400, and store the date the caller wrote.

### D2.C — Term lifecycle

**Problem and evidence.** Three vocabularies disagree:

| Source | Values |
|---|---|
| DB enum `SchoolTermStatus` (migration 002) | `PLANNED`, `ACTIVE`, `COMPLETED` |
| `school.schemas.js:28,36` | `PLANNED`, `ACTIVE`, `COMPLETED` |
| `school.service.js:144` transition map | `{ PLANNED: ['ACTIVE','CLOSED'], ACTIVE: ['CLOSED'] }` |

Consequence, verified by executing the guard logic exactly: `PLANNED→ACTIVE` is allowed; `PLANNED→COMPLETED`, `ACTIVE→COMPLETED`, and anything from `COMPLETED` are blocked; `CLOSED` is not a legal database value. **A term can be activated but never completed.**

Note also that the same map literal is used at `:274` for class sections, whose enum *does* contain `CLOSED` — so sections are correct and the defect is confined to terms.

**Decision required (this plan proposes, it does not decide).** Which is the term terminal state? The database and API both say `COMPLETED`, and renaming an enum value after data exists is far more invasive than editing a guard. **Recommendation: `COMPLETED` is correct; `CLOSED` is the mistake.**

**Proposed transition table**

| From | Allowed to | Notes |
|---|---|---|
| `PLANNED` | `ACTIVE`, `COMPLETED` | `COMPLETED` covers whole-year terms that are never explicitly activated |
| `ACTIVE` | `COMPLETED` | |
| `COMPLETED` | — | **Terminal.** No re-opening; a correction requires a new term |

`COMPLETED` becomes the sole terminal state and is immutable, which is the property that matters for downstream features keyed on term closure. Activating a term additionally keeps the existing guard requiring the academic year to be `ACTIVE`.

**Migration necessity.** **None.** The enum already contains all three values, so this is a code-only reconciliation of the guard. That is the lowest-risk option and satisfies the constraint against migrations. A migration would only be needed if the terminal state were chosen as `CLOSED`, which is the option recommended against.

**Affected files:** `backend/src/modules/school/school.service.js` (line 144), plus a shared constant so the map is not duplicated and sections/terms cannot drift again.

**D4 fix in the same change.** `updateTerm` must add `include: { academicYear: true }` — otherwise the activation path throws `TypeError` regardless of the transition table, and the table would appear to work in tests that never reach that line.

**Database and migration implications.** None. **Deletes/edits to migration history: none.**

**Security and tenancy implications.** Unchanged; the guard is an additional constraint on an already tenant-scoped write.

**Required tests.** Every legal transition succeeds; every illegal transition returns `409 INVALID_STATUS_TRANSITION` with a stable code; `COMPLETED` is terminal and immutable; activating a term under a non-`ACTIVE` year returns `409 ACADEMIC_YEAR_NOT_ACTIVE`; the transition table and the database enum are asserted **equal**, so the three vocabularies cannot silently diverge again.

**Acceptance criteria.** A term can reach `COMPLETED` through the API, and no path can move it out again.

### D2.D — School test coverage

**Problem and evidence.** Zero tests exercise School service logic. `grep -rn "schoolService\|school.service" test/` returns nothing; `school-module.test.js` (3 tests) covers only the industry gate and UUID validation. Defects D1–D5 all survive a green suite.

**New test file:** `backend/test/school-service.test.js`, plus a real-database file reusing the existing harness at `backend/test-support/real-pg-harness.js`.

| Area | Required cases |
|---|---|
| Profile provisioning | SCHOOL creates one; other industries create none; rollback leaves none; upsert idempotence; duplicate rejected by unique index |
| Academic years | create/list/update; unique name per organisation; `endsOn < startsOn` rejected; status transitions `DRAFT→ACTIVE→CLOSED` |
| Terms | create; sequence uniqueness per (org, year); **all** transitions per D2.C; terminal immutability; activation blocked when year not ACTIVE |
| Grade levels | create/list/update; unique name and code per organisation; `ACTIVE→INACTIVE` |
| Class sections | create/list/update; requires existing year; activation requires ACTIVE year; **invalid `gradeLevelId` returns a clean 4xx, not a raw FK error** (D5) |
| Date validation | every case from D2.B |
| Tenant isolation | org B cannot read, update, or reference org A's year/term/level/section by ID; cross-tenant `gradeLevelId` rejected |
| Unauthorised | each endpoint returns 403 without `school.manage` (writes) or `school.read` (reads); non-SCHOOL industry gets `404 SCHOOL_MODULE_NOT_ENABLED` |
| Invalid transitions | each illegal transition asserted individually, not as a single loop |

**Test mechanism.** Service-level tests against the real ephemeral PostgreSQL via the existing harness, so behaviour is asserted against real constraints rather than mocks. Route-level permission and gate tests stay in `school-module.test.js`.

**Coverage acceptance criteria.** Every exported function in `school.service.js` is called by at least one test; every documented error code is asserted; the suite fails if any of D1–D5 is reintroduced (each gets a dedicated regression test).

### D2.E — Dependency and order

1. **D2.A + D2.C/D4 together** (both touch `school.service.js`; the profile work also needs a working client from D1).
2. **D2.B** (schemas only, independent).
3. **D2.D** alongside each change — tests written with the fix, not after.
4. **D5** with D2.D, since it needs a clean-error decision.

**D1 must complete first**, because profile provisioning depends on the generated client and the composite-FK fix.

### D2.F — Risks and rollback

| Risk | Mitigation |
|---|---|
| Profile provisioning in `register()` changes a hot path | It is one insert inside an existing transaction; asserted by a rollback test |
| Backfill could create profiles for industries with stale data | Guarded by `WHERE industry='SCHOOL'`; run manually; idempotent |
| Choosing `COMPLETED` over `CLOSED` may conflict with a product expectation | **Requires explicit product confirmation at approval**; the alternative is a migration, which this plan avoids |
| Upsert could mask a genuine missing-profile bug | Provisioning at creation remains primary; upsert is a documented safety net with its own test |
| Rollback | Code-only; revert commits. No migration to reverse |

---

## D3 — Operational baseline

Four separately deployable scopes, in dependency order. Each is independently revertible.

### D3.1 Structured logging

**Problem and evidence.** `src/server.js:10` and `src/workers/email-outbox.js:12` pass **`logger: console`**. No structured logging library is in dependencies. Outbox emits `logger.warn({event:…})` only because `console` is passed in.

**Affected files:** `src/lib/logger.js` (new), `src/server.js`, `src/workers/email-outbox.js`, `src/config/env.js` (log level, format), `backend/package.json` (one dependency), `.env.example`.

**Proposed changes.** Introduce a structured logger behind the **existing injection point** — `createApp({ logger })` already accepts one, so no call sites change. JSON lines with `timestamp`, `level`, `requestId`, `event`, and redaction of `password`, `token`, `authorization`, and encrypted payloads. Library choice is proposed at implementation time with a preference for `pino` (small, no native deps); **no upgrade of existing dependencies** and the `effect@3.22.5` override is untouched.

**Security.** Redaction is mandatory and tested; secrets must never appear in logs. Log level configurable, defaulting to `info` in production and `debug` in development.

**Tests.** Redaction of secret-shaped fields; logger injected rather than global; level filtering.

### D3.2 Request correlation

**Problem and evidence.** A `requestId` **already exists** (`app.js:44-46`: generated via `crypto.randomUUID()`, returned as `X-Request-Id`, written into audit rows and error bodies). It is simply **never attached to a log line**. The gap is small and well-defined — this is correlation, not generation.

**Affected files:** `src/app.js` (attach a child logger to `req`), `src/routes/*` where handlers log.

**Proposed changes.** Bind `req.log = logger.child({ requestId: req.requestId })` in the existing middleware; accept an inbound `X-Request-Id` **only if** it matches a UUID, otherwise generate one (prevents log injection). Propagate the same id into the worker's own log context per job.

**Security.** Caller-supplied ids are validated before use; no header injection into log output.

**Tests.** Correlation id appears on request logs; malformed inbound header replaced, not trusted; response header still matches.

### D3.3 Database-aware health checks

**Problem and evidence.** `app.js:50` returns `{status:'ok'}` unconditionally. A dead database reports healthy, so an orchestrator would never restart the service.

**Affected files:** `src/app.js` (or `src/routes/health.routes.js`), `src/lib/prisma.js`.

**Proposed changes.** Split liveness from readiness:

- `GET /health` — **liveness**, no I/O, unchanged contract, so existing probes and tests keep working.
- `GET /health/ready` — **readiness**, runs `SELECT 1` with a short timeout, returns `503` with a non-sensitive reason on failure.

**Security.** The body must not leak connection strings, hosts, or driver internals. Timeouts prevent the health endpoint becoming a DoS vector against the pool.

**Tests.** Ready returns 200 with DB up; 503 with DB down; liveness unaffected by DB state; no sensitive detail in the body.

### D3.4 CI pipeline

**Problem and evidence.** No `.github/` directory; nothing runs the suite on push; every result in Stage C and the assessment was produced manually.

**Affected files:** `.github/workflows/ci.yml` (new).

**Proposed changes.** On push and PR: install Node (pinned), `npm ci`, `npx prisma validate`, `npm run db:generate` (with `DATABASE_URL` from a dummy secret so the config adapter builds), `npm test`, drift check. Cache npm. Upload the test report on failure. A second job runs the integration suite — possible once D1 removes the network dependency.

**Security.** No production secrets in CI; `DATABASE_URL` is a non-secret placeholder used only to satisfy config construction. Optional dependency-audit step reporting the existing 0-vulnerability baseline.

**Tests.** The workflow itself is verified by a deliberately failing branch before merge.

### D3.5 Automated migration validation

**Problem and evidence.** `applyMigrations` (`src/lib/migrations.js`) is the verified deploy path, but nothing validates migrations automatically, and `migration_lock.toml` is ignored by the runner (it filters to directories). Two migration mechanisms coexist (`prisma migrate deploy` documented as unverified, plus the JS runner).

**Affected files:** `src/lib/migrations.js` (assert the lock file's provider), new script `scripts/check-migrations.js`, CI wiring.

**Proposed changes.** In CI, against a throwaway cluster: apply all migrations to an empty database, re-apply to confirm the `already-applied` path, and run `prisma migrate diff` to prove the datamodel matches the migrations. Assert `migration_lock.toml` declares `postgresql`.

**Security.** Runs only against an ephemeral local cluster; **never Neon.**

**Tests.** A deliberately drifted schema fails the check (this is the drift guard from D1.5, reusing the same mechanism).

### D3.6 Deployment and environment verification

**Problem and evidence.** `docker-compose.yml` defines only PostgreSQL. No Dockerfile, no `.dockerignore`, no `engines` field (`engines: null`). The API and worker cannot be containerised from this repository.

**Affected files:** `Dockerfile` (new), `.dockerignore` (new), `docker-compose.yml` (add `api` and `worker` services), `backend/package.json` (`engines.node`), `backend/README.md`.

**Proposed changes.** Multi-stage Dockerfile (install → prune → runtime, non-root user, `NODE_ENV=production`), separate compose services for API and worker sharing the image with different commands, healthcheck wired to `/health/ready`, and a `DEPLOYMENT.md` runbook covering migrate → rollout → rollback.

**Security.** Non-root runtime; no build secrets in layers; `.dockerignore` excludes `.env*`, `*_key*`, and `secrets/`; production refusal of insecure cookies and the console mailer already exists in `config/env.js` and is preserved.

**Tests.** Image builds; container starts and passes readiness; worker starts with the same image; a config test asserts production refuses insecure settings (already covered by `env-mailer.test.js`).

### D3.7 D3 acceptance criteria

Liveness and readiness behave distinctly under DB failure; every request log carries a correlation id; no secret appears in any log; CI runs validate + generate + full suite on every push; drift and migration checks pass; the API and worker both build and run as non-root containers.

---

## D4 — Industry module architecture

Assessment only. **No SACCO, Clinic or Rentals module is built in Stage D.**

### D4.1 The concrete problem

Three of four industries are empty, and the one implemented module (School) has **already diverged** from the shared platform in four observable ways:

| Divergence | Shared platform | School module |
|---|---|---|
| Audit writes | `recordAudit(tx, …)` helper | Inline `tx.auditLog.create` at **9** sites (`grep -c` verified) |
| Concurrency strategy | Per-organisation `pg_advisory_xact_lock` (`src/lib/tenant-lock.js`) | `isolationLevel: 'Serializable'` per transaction |
| Schema strictness | `.strict()` on write schemas | **Zero** `.strict()` usage |
| Route gate | `requireTenant` + `requirePermission` | Adds its own `requireSchoolModule` |

Copying this shape into three more modules would quadruple the inconsistency. D4 therefore defines the foundation **before** any new module is written — which is also the cheapest point to fix School.

### D4.2 Reusable foundation to define (not yet build)

| Concern | Proposed shared mechanism | Why |
|---|---|---|
| **Model placement** | Industry models live in `prisma/schema.prisma` with an `organisationId` field and a composite unique `(id, organisationId)`; no industry-specific database. | Preserves the single-database, single-tenant-column model that all isolation depends on. |
| **Migrations** | One migration directory per feature with a lexical prefix, as today; no per-industry branches. | Keeps the deterministic ordering already relied on (`002` before `003`/`004`). |
| **Tenant isolation** | Every industry table carries `organisation_id` with a composite FK to `organisations(id)`; every query filters `organisationId`; cross-tenant references caught by composite FKs. | This is exactly what makes School safe today — the pattern is already proven. |
| **Module gate** | Generalise `requireSchoolModule` into a data-driven `requireIndustryModule('SCHOOL')` fed from `INDUSTRY_PERMISSION_PREFIX` in `src/config/permissions.js`. | Replaces a bespoke middleware per module with one table. |
| **Permissions** | Keep `INDUSTRY_PERMISSION_PREFIX` as the single registry; add `sacco.read`/`clinic.read`/`rentals.read` only when the modules exist. | `sacco.manage` etc. already exist and are already industry-filtered. |
| **Services** | Mandate `recordAudit` and `lockOrganisation`; forbid inline audit inserts and ad-hoc isolation levels. | Removes the two divergences that matter most for correctness. |
| **Validation** | A shared date/phone/currency schema module; `.strict()` mandatory on all write schemas. | D2.B and D2.C are both validation-drift bugs. |
| **Routes** | A shared factory applying `authenticate → requireTenant → industry gate → permission → validate` in a fixed order. | Makes a missed guard structurally impossible rather than a review catch. |
| **Tests** | A shared conformance suite every module must satisfy: gate 404, permission 403, tenant isolation, invalid transition, audit row written. | Generalises the D2.D list so a new module cannot ship untested. |

### D4.3 Sequencing and rationale

1. **D1** — generate the client; nothing else is testable first.
2. **D2** — repair School, and in doing so establish the corrected pattern.
3. **D3** — operational baseline; needed before any real deployment, independent of feature work.
4. **D4** — write the foundation (gate factory, shared validators, conformance suite) and **refactor School onto it**, proving the foundation against a real module before adding three.

Only after that should SACCO/Clinic/Rentals be specified. **Requirements for those modules do not exist anywhere in the repository**, so specification precedes implementation and belongs to a later stage with its own approval.

### D4.4 Risks

| Risk | Mitigation |
|---|---|
| Refactoring School onto a new foundation becomes a rewrite | Bound it: the four named divergences only, proven by the existing plus new tests. No file moves, no renaming of endpoints |
| Premature generalisation for modules whose requirements are unknown | Define only what School has already proven necessary; defer anything speculative |
| The foundation silently weakens isolation | Every module must pass the shared conformance suite, including cross-tenant assertions |

---

## 5. Execution order and dependency graph

```
D1 (schema fix → generate → 6 tests pass)
 └─> D2.A  profile provisioning   ─┐
     D2.B  date handling          ─┤ (D2.B independent; A/C/D4 share files)
     D2.C  term lifecycle + D4    ─┤
     D2.D  school test suite      ─┘
      └─> D3 (logging → correlation → health → CI → migration checks → deploy)
           └─> D4 (foundation + School refactor)
                └─> [separate approval] SACCO / Clinic / Rentals specification
```

**D1 strictly first.** D2 before D3 is a judgement call: D2 restores a module already documented as delivered, and D3 is new operational scope. Either order is defensible; this plan favours finishing what was claimed before adding capability. D4 last because it generalises patterns that D2 will have just corrected.

---

## 6. Acceptance criteria for the whole of Stage D

1. `npx prisma validate` and `npm run db:generate` succeed offline.
2. **All 82 existing tests pass, 0 fail** (76 pass + 6 previously-blocked). Any remaining failure is reported as a real defect, not as environmental. D2 adds new tests on top of that baseline; the suite total therefore rises above 82, and the exact number is fixed at implementation time rather than predicted here.
3. Drift check and migration validation pass in CI.
4. A newly registered SCHOOL organisation can use all 14 school endpoints successfully, end to end.
5. A term can reach `COMPLETED` and cannot leave it.
6. Dates are accepted as `YYYY-MM-DD` and stored as the same calendar date regardless of server timezone.
7. No secret appears in logs; every request log carries a correlation id.
8. `/health/ready` returns 503 when the database is unreachable and 200 when it is not.
9. CI runs validate, generate, and the full suite on every push.
10. The API and worker both run as non-root containers.
11. School conforms to the D4 foundation, proven by the shared conformance suite.
12. No SACCO, Clinic or Rentals module has been created.

---

## 7. Explicit non-goals and constraints honoured

- **No source changes** in producing this plan — the only change is this document.
- **No database or Neon changes**, no connection strings altered, no data touched.
- **No migrations**, no edits to migration history. Every D2 fix is deliberately code-only.
- **No dependency upgrades.** Prisma stays `6.19.3`; `effect@3.22.5` and the `supertest ^7.1.4` / `deepmerge-ts` overrides are untouched.
- **No new industry modules.**
- **Existing commits and branches preserved.** The `d1e964d` checkpoint and `67d8c24` assessment commit are unchanged.
- **Settled architecture decisions not reopened:** shared modular monolith, single database with `organisation_id` tenancy, advisory-lock concurrency, PostgreSQL, Prisma.

### 7.1 Environment incident during planning

The sandbox again reset its git refs at session start (`HEAD` reverted to `8393f14` while the worktree retained everything). Recovery was verified, not assumed: `git add -A` followed by `git diff --cached 67d8c24…` returned **empty**, proving the worktree was byte-identical to the assessment commit, after which `git reset --mixed 67d8c24…` restored the ref. No commit, branch, or file was altered. This is the third occurrence of the same environmental fault and is recorded so it is not mistaken for repository tampering.

---

## 8. Items requiring a decision at approval

1. **Term terminal state:** confirm `COMPLETED` (recommended, code-only) rather than `CLOSED` (requires a migration).
2. **Backfill for existing SCHOOL organisations:** ship the idempotent backfill in D2, or defer with a documented gap.
3. **D5 clean-error behaviour:** return `404 GRADE_LEVEL_NOT_FOUND` when `gradeLevelId` is not in the organisation (recommended) rather than relying on the FK.
4. **Logging library:** approve adding one dependency (`pino` proposed) or accept a minimal hand-rolled JSON logger with no new dependency.
5. **D2-before-D3 ordering:** confirm, or invert.
