# NexaCore — Post-Stage C Repository Assessment

**Assessment date:** 2026-11-23
**Starting checkpoint:** `d1e964dff00556be430e04b5780eb7d99b7185be`
**Branch:** `arena/8c9954b6-nexacore`
**Nature of this document:** assessment only. No source code, schema, migration, dependency, or database was changed in producing it. Proposed Stage D scope is a recommendation for architectural review, not an implementation.

---

## 1. Repository state verification

| Item | Result |
|---|---|
| Current branch | `arena/8c9954b6-nexacore` |
| HEAD | `d1e964dff00556be430e04b5780eb7d99b7185be` |
| Working tree | **clean** (`git status --porcelain` empty) |
| Remote contains checkpoint | **Yes** — `git ls-remote origin refs/heads/arena/8c9954b6-nexacore` returns `d1e964d…` |
| Changes after Stage C | **None** |

Commit chain, confirmed by `git log`:

```
d1e964d docs: record final commit SHA and push confirmation in concurrency review
a4eaa94 fix(concurrency): close invitation-acceptance/suspension race; prove removal race
c15dc9e docs: Stage C final verification report
4e21686 fix(organisations): fail-closed ownership lock, invitation lifecycle, settings hardening
3afface fix(organisations): close last-owner race; validate and merge settings
5926380 feat(backend): recover shared hardening migrations, School module, and lease-fenced outbox
8393f14 fix(deps): override vulnerable Effect version
```

### 1.1 An environment incident occurred during this assessment — disclosed for completeness

The sandbox reset its git refs again at the start of this session: `HEAD` had fallen back to `8393f14` while the working tree retained every Stage C file. This is the same environmental fault recorded in `STAGE_C_CONCURRENCY_REVIEW.md` §5.

Recovery was non-destructive and verified, not assumed:

1. `git fetch` confirmed `d1e964d` intact on origin.
2. `git add -A` followed by `git diff --cached d1e964d…` returned **empty**, proving the working tree was byte-identical to the checkpoint — no work had been lost.
3. `git reset --mixed d1e964d…` restored the ref without touching the working tree.

No branch, commit, or file was created, deleted, or rewritten. The checkpoint is unchanged on the remote.

### 1.2 Test suite reproduction

`cd backend && npm ci && node --test` →

```
# tests 82
# pass 76
# fail 6
```

This reproduces the approved Stage C figures exactly. The 6 failures are unchanged and remain **environment-blocked** (§4.2).

---

## 2. Shared platform assessment

Legend: **Implemented** = works end-to-end and is tested. **Partial** = real code exists but has a named gap. **Missing** = absent. **Unverified** = code exists but no test or environment can currently prove it.

### 2.1 Authentication and session management — Implemented

`backend/src/modules/auth/auth.service.js`, `backend/src/routes/auth.routes.js`, `backend/src/lib/security.js`

Registration, email verification, login, refresh rotation, logout, password reset, and resend-verification all exist as routes and services. Refresh sessions are family-linked with reuse detection (`rotateSession`, `revokeRefreshFamily`) and reuse emits `auth.refresh_reuse_detected`. Passwords use bcrypt; tokens are stored as hashes. Rate limiters are applied per endpoint (`src/app.js:52-61`): 20/15min general auth, 3/hour for verification and reset emails.

Tests: `auth-service.test.js` (5), `session-rotation.test.js` (3), `security.test.js` (4), `app.test.js` (6). Real-PostgreSQL auth and immediate token-version revocation is one of the **6 blocked** integration tests — so the DB-level behaviour here is *unverified*, not disproven.

**Gap:** no MFA, no session listing/revocation UI, no device management. None of these were in Stage C scope.

### 2.2 Multi-tenancy and organisation isolation — Implemented

`backend/src/middleware/tenant.js`

`requireTenant` resolves membership only where `organisationId`, `userId`, `status: 'ACTIVE'`, **and** `organisation.status: 'ACTIVE'` all match. Permissions are industry-filtered via `permissionsForIndustry`. Cross-tenant rejection returns `404 ORGANISATION_NOT_FOUND` (non-enumerating) rather than 403.

Tests: `tenant.test.js` (4) covers scoping, permission enforcement, and invalid-identifier rejection before any query. `organisation-settings.test.js` includes a cross-tenant PATCH that asserts 404 **and zero writes**. Composite foreign keys in migration 001 (`member_roles_member_id_organisation_id_fkey`, `member_roles_role_id_organisation_id_fkey`) enforce tenant consistency at the database level.

**Gap:** tenant isolation is enforced per-request, and there is no test asserting that *every* route in the app is tenant-scoped — coverage is by representative sample, not exhaustively. A route added later without `requireTenant` would not be caught by any current test.

### 2.3 Membership and RBAC — Implemented, with one structural caveat

`backend/src/modules/organisations/access.service.js`

Member listing, add-member, status changes, and role assignment all exist. Escalation guard (`actorCanAssignRole`) prevents assigning roles carrying permissions the actor lacks. Owner protection is enforced by `ensureOwnerNotRemoved` plus the per-organisation advisory lock in `src/lib/tenant-lock.js`. System-role immutability is enforced.

Tests: `access-service.test.js` (7), `concurrency-postgres.test.js` (8 real-PostgreSQL, including owner-removal race and a no-lock control that demonstrably leaves **0 active owners**).

**Caveat worth recording:** roles are identified by **name** in business logic (`role.name === 'Organisation Owner'`), not by a stable key or flag, while the schema has `is_system_role`. Renaming a system role — if that is ever permitted — would silently disable ownership protection. `updateRole` exists and its guards should be confirmed before Stage D builds on roles.

### 2.4 Organisation management — Implemented

`backend/src/modules/organisations/organisation.service.js`, `backend/src/routes/platform.routes.js`

Create organisation (on registration and separately), list user organisations, read details, and PATCH with an explicit allowlist (`name`, `settings`) that regenerates slug and merges settings in-transaction. A strict Zod schema rejects `status`, `industry`, `slug`, `id` — verified by test.

Tests: `organisation-settings.test.js` (19) covers merge/clear/validation/isolation/authorisation and prototype-pollution resistance.

**Gap:** slug uniqueness conflicts are mapped for creation, but there is no test covering a PATCH rename that collides with an existing slug.

### 2.5 Invitations and membership lifecycle — Implemented

`backend/src/modules/organisations/invitation.service.js`, `backend/src/routes/invitation.routes.js`

Create, inspect, accept, and revoke. Email normalised before persistence; 72-hour TTL; single-use enforced by a conditional `updateMany`; duplicate live invitations map Prisma `P2002` to `409 INVITATION_ALREADY_EXISTS`; acceptance is refused for suspended organisations both on a fast path and **authoritatively under the tenant lock inside the transaction**.

Tests: `invitation-lifecycle.test.js` (7), `invitation-routes.test.js` (1), plus `concurrency-postgres.test.js` (8) proving the suspension/acceptance race is closed on real PostgreSQL and that disabling the lock reproduces the bug.

### 2.6 Platform administration — Implemented

`backend/src/modules/platform/platform-admin.service.js`, `backend/src/routes/platform-admin.routes.js`

Separate from tenant roles by design: `PlatformPermission` + `PlatformAdminGrant`, guarded by `src/middleware/platform-permission.js`. Organisation status changes, user status changes with `tokenVersion` increment plus refresh-session revocation, admin permission grants, and platform audit listing all exist. Last-platform-admin protection is implemented for both suspension and grant removal.

Tests: platform-admin separation and non-escalation are among the **6 blocked** integration tests. Unit coverage of `changeOrganisationStatus` exists indirectly through the concurrency tests.

**Gap:** the `LAST_PLATFORM_ADMIN_REQUIRED` guards are **unverified** — no passing test exercises them, and the integration test that would is blocked.

### 2.7 Subscription and billing foundations — **Missing**

Evidence:

- `billing.read` and `billing.manage` exist in the permission catalog (`src/config/permissions.js:8-9`) and are assigned to `Accountant` and `Auditor` (read) and withheld from Owner/Administrator (`billing.manage` filtered).
- **No billing, subscription, invoice, payment, or plan table exists** — `grep -riE "create table.*(subscription|billing|invoice|payment|plan)" prisma/migrations/` returns nothing.
- **No route, service, or module** references billing beyond the permission strings.
- **No test** exercises billing behaviour; `access-service.test.js` merely uses `billing.manage` as an example permission key.

So the *permission vocabulary* anticipates billing, but there is no foundation beyond that. This is accurately "missing", not "partial". The root README already lists payment workflows as out of scope.

### 2.8 Notifications and email outbox — Implemented

`backend/src/modules/notifications/outbox.service.js`, `outbox.crypto.js`, `backend/src/workers/email-outbox.js`, migration `202611160004_outbox_lease_fencing`

Payloads encrypted AES-256-GCM; leases fenced by `lock_token` so a worker whose lease was taken cannot mark another worker's job sent or failed; terminal failures emit an audit event with redacted error text; stale locks are reclaimed via `cleanup_stale_outbox_locks`.

Tests: `outbox.test.js` (4), `env-mailer.test.js` (4).

**Gaps:** the worker is a single-process `while` loop with no metrics, no dead-letter queue, and no alerting on `FAILED`. Delivery has never been exercised against a real SMTP server. Reliability of the *mechanism* is tested; operational visibility is not.

### 2.9 Audit logging — Implemented (write side), Partial (read side)

`backend/src/modules/audit/audit.service.js`, `audit_logs` table

28 distinct actions are recorded across auth, organisation, membership, invitation, role, platform, and school. Reads are permission-gated (`audit.read`) and paginated with a validated cursor.

**Gaps:**

- Audit writes use `auditLog.create` directly inside each transaction. There is no constraint preventing a future code path from writing an audit entry without the organisation scoping, and no schema-level append-only enforcement (an `UPDATE`/`DELETE` on `audit_logs` is permitted by the database).
- No retention policy, no export, no tamper-evidence (no hash chain).
- The school module writes audit rows inline rather than through `recordAudit`, so the helper is not actually universal — a consistency risk for future modules.

### 2.10 Reporting — **Missing**

There is no reporting module, no aggregate/analytics route, and no report table. The closest artefacts are paginated *list* endpoints (audit logs, members) which are not reporting. No `report` string appears anywhere in `src/`.

### 2.11 Settings and configuration — Implemented

`backend/src/modules/organisations/organisation.settings.js`, `backend/src/config/env.js`

Organisation settings are a 7-key frozen allowlist with per-key type, format, and range validation; merge-not-replace semantics; `null` clears; unknown keys rejected; `hasOwnProperty` matching blocks prototype pollution; stored settings are copied, never mutated. Environment configuration is Zod-validated with production guards (refuses insecure cookies and the console mailer).

Tests: `organisation-settings.test.js` (19), `env-mailer.test.js` (4).

**Gap:** settings are document-store JSONB with validation only on write through this API. If a future feature writes `organisation.settings` directly, the invariants would not hold.

---

## 3. Industry module assessment

All four industries exist as an enum value (`Industry` in migration 001) and are selectable at registration. Only one has any implementation.

| Industry | DB tables | Service | Routes | Tests of logic | Verdict |
|---|---|---|---|---|---|
| **SCHOOL** | **5** (`school_profiles`, `school_academic_years`, `school_terms`, `school_grade_levels`, `school_class_sections`) | Yes, ~330 lines | 14 endpoints | **None** | **Partial — unusable end-to-end** |
| **SACCO** | 0 | No | No | No | **Missing** (permission string only) |
| **CLINIC** | 0 | No | No | No | **Missing** (permission string only) |
| **RENTAL** | 0 | No | No | No | **Missing** (permission string only) |

### 3.1 School — exists on paper, but cannot be used

The module gate works correctly: `requireSchoolModule` returns `404 SCHOOL_MODULE_NOT_ENABLED` for SACCO/CLINIC/RENTAL and lets SCHOOL through, verified by `school-module.test.js` (3).

Beyond the gate, **three defects were found and verified by direct execution** — not inferred from reading:

**D1 — No code path ever creates a `SchoolProfile`. (Blocking)**

`grep -rn "schoolProfile\.\(create\|upsert\)" src/ prisma/` returns nothing, and `prisma/seed.js` has no school handling. `getProfile` and `updateProfile` both `findUnique` and throw `404 SCHOOL_PROFILE_NOT_FOUND` when absent; `updateProfile` calls `update`, not `upsert`.

Consequence: for **every** organisation created through `POST /api/v1/auth/register` (which creates organisation, member, and roles but no profile), the school profile cannot be created through the API at all. Since academic years, terms, grade levels, and sections are all permission-gated behind the same module and several require an existing academic year, the practical result is that a newly registered SCHOOL tenant has **all 14 school endpoints returning 404**.

**D2 — Dates are rejected because `z.date()` does not accept JSON strings.**

`src/modules/school/school.schemas.js` lines 11-12, 18-19, 26-27, 34-35 use `z.date()`. JSON requests deliver strings. Executed directly:

```
POST with JSON date strings -> REJECTED
  issues: [{"path":"startsOn","msg":"Invalid input: expected date, received string"},
           {"path":"endsOn","msg":"Invalid input: expected date, received string"}]
POST with real Date objects -> PASSES
```

So every academic-year and term create/update with a normal JSON body fails `400 VALIDATION_ERROR`. Every other schema in the codebase uses `z.coerce` or plain strings; this is isolated to the school module. `z.coerce.date()` or an ISO-8601 string with transform is the conventional fix.

**D3 — Terms can never reach a terminal state; two status vocabularies disagree.**

- DB enum: `SchoolTermStatus = ('PLANNED','ACTIVE','COMPLETED')`
- API schema accepts exactly those three (`school.schemas.js:28,36`)
- Service transition map (`school.service.js:144`, and `:274` for sections) is `{ PLANNED: ['ACTIVE','CLOSED'], ACTIVE: ['CLOSED'] }`

Executing the exact `assertAllowedTransition` logic:

```
PLANNED -> ACTIVE   : ALLOWED
PLANNED -> COMPLETED: BLOCKED     <- API permits it, guard refuses
ACTIVE  -> COMPLETED: BLOCKED     <- the only real terminal state is unreachable
COMPLETED -> *      : BLOCKED     <- no rule exists for COMPLETED
CLOSED appears in the DB enum?   false
```

Consequence: a term can be activated but **never completed**. `CLOSED` is unreachable because the database would reject it, and `COMPLETED` is unreachable because the guard has no rule for it. Terms are permanently stuck in `ACTIVE`.

The same map is shared by class sections at `:274`, but sections' DB enum is `('PLANNED','ACTIVE','CLOSED')` — which *does* contain `CLOSED`. Sections are therefore consistent and unaffected; the defect is specific to terms.

**Architecture conformance:** School follows the shared architecture in its gate, permissions (`school.read`/`school.manage`), tenant scoping, and error shape. It deviates in two ways worth flagging before Stage D builds more modules: it writes `tx.auditLog.create` inline instead of using `recordAudit`, and it uses `isolationLevel: 'Serializable'` per transaction where the rest of the platform uses per-organisation advisory locks. Neither is a bug today; both are divergence that becomes costly once copied into three more modules.

### 3.2 SACCO, Clinic, Rentals — genuinely absent

Each has one industry-scoped permission string (`sacco.manage`, `clinic.manage`, `rentals.manage`), an enum value, and an industry prefix used by `permissionAppliesToIndustry`. There are no tables, services, routes, or tests. `school-module.test.js:45` uses SACCO/CLINIC/RENTAL only to prove the School gate rejects them.

No assumptions are made here about their requirements — no design work for these modules appears anywhere in the repository.

---

## 4. Engineering readiness

### 4.1 Database schema and migration integrity — Good

19 models across 4 migrations. Migration order is correct and deliberate: `001_platform_foundation` → `002_school_foundation` → `003_permission_invitation_hardening` → `004_outbox_lease_fencing`. Order matters because 003/004 rely on 001 objects.

Integrity measures present: composite unique index `organisation_members(id, organisation_id)` backing composite FKs; tenant-consistent composite FKs on `member_roles`; a partial unique index `organisation_invitations_one_live_email_key` on `(organisation_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL`; CHECK constraint on `school_profiles.week_starts_on`; advisory-locked deterministic deploy via `src/lib/migrations.js` + `prisma/deploy.js`.

**Gaps:**

- `prisma migrate deploy` (Prisma's own engine) is documented as **not** the verified path; the checked-in JS runner is. Two migration mechanisms now coexist, which is a drift risk.
- Migrations were verified to apply and to re-run as already-applied, but **no test asserts schema drift** between `prisma/schema.prisma` and the applied migrations. D3 above is exactly the class of bug that a drift check would catch.
- `audit_logs` is not append-only at the database level.
- Like the rest of the repo, migrations are hand-written SQL; nothing prevents a future schema.prisma edit from being applied without a matching migration.

### 4.2 Automated test coverage — Strong where it exists, with named holes

82 tests, 76 passing. Distribution:

| Suite | Tests | Area |
|---|---|---|
| `organisation-settings.test.js` | 19 | Settings, isolation, authorisation, pollution |
| `concurrency-postgres.test.js` | 8 | Real-PostgreSQL races (locks) |
| `access-service.test.js` | 7 | RBAC, owner protection |
| `invitation-lifecycle.test.js` | 7 | Invitation contract |
| `app.test.js` | 6 | Error handling, health, 404 |
| `auth-service.test.js` | 5 | Auth flows |
| `security.test.js` | 4 | Tokens, hashing, policy |
| `env-mailer.test.js` | 4 | Config guards, mailer |
| `tenant.test.js` | 4 | Tenant boundary |
| `outbox.test.js` | 4 | Outbox, fencing |
| `session-rotation.test.js` | 3 | Refresh rotation |
| `school-module.test.js` | 3 | School **gate only** |
| `invitation-routes.test.js` | 1 | Signup validation |
| `integration/postgres.integration.test.js` | 6 | **All 6 blocked** |

**Outstanding verification item — the six Prisma-dependent tests.** These remain environment-blocked:

```
'@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.'
```

Cause: `prisma generate` unconditionally fetches a native schema engine from `binaries.prisma.sh`, which is TLS-unreachable here. `--no-engine`, the `queryCompiler` preview feature, `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING`, `PRISMA_CLI_QUERY_ENGINE_TYPE`, `PRISMA_SCHEMA_ENGINE_BINARY`, and removing `prisma.config.js` were all tried; no `@prisma/query-engine-*` npm package exists for this version. They are **not passing** and are not evidence of a defect. Running `npm run db:generate && npm test` on a networked machine is the closure step.

**Holes to record:**

- **Zero tests exercise School service logic.** `school-module.test.js` tests only the module gate and ID validation; D1/D2/D3 all survive a green suite. This is the single largest coverage gap relative to code volume.
- Platform-admin `LAST_PLATFORM_ADMIN_REQUIRED` guards are untested.
- No test for reporting/billing (nothing to test).
- No coverage metric is produced; "82 tests" says nothing about line or branch coverage.
- No mutation-testing or property-based tests outside the Stage C control experiments.

### 4.3 API validation and error handling — Good, with one inconsistency

`src/middleware/validate.js` returns structured `400 VALIDATION_ERROR` with per-field paths; `src/app.js` maps malformed JSON to `400 INVALID_JSON`, oversized bodies to `413`, and unknown routes to a structured `404`; 500s never leak internals (`'An unexpected error occurred'`). Prisma `P2002` is mapped to 409 at six call sites.

**Inconsistencies:**

- Strictness is uneven: platform/auth/invitation schemas use `.strict()`, but **no school schema does**, so unknown keys are silently stripped there rather than rejected. D2 is a direct consequence of schema drift going unnoticed.
- Not every route uses `.strict()`; a request body with an unexpected `organisationId` is silently dropped in the school module (harmless because the service takes `req.tenant.id`, but the pattern is inconsistent).
- Cursor validation is hand-rolled with a regex in some places and Zod in others.

### 4.4 Authorization and tenant isolation — Strong

Layered: `authenticate` → `requireTenant` (membership + organisation ACTIVE) → `requirePermission` (industry-filtered) → and for platform routes, `requirePlatformPermission`. Ownership mutations additionally take the per-organisation advisory lock. Concurrency guarantees are proven on a real database with control experiments that fail if the locks are removed.

**Gaps:** no route-coverage test asserting every mounted route is guarded (§2.2); role identity by name (§2.3); `audit_logs` not append-only.

### 4.5 Logging and observability — **Weak; a genuine readiness gap**

Evidence: `src/server.js:10` passes **`logger: console`**; the worker does the same. There is no structured logging library in dependencies (`pino`/`winston` absent). Log calls are ad hoc `console.info`/`console.error`, plus a few `logger.warn({event:...})` calls in the outbox that happen to be structured — but only because `console` is passed in.

There is **no**: request-scoped logging middleware (a `requestId` exists and reaches audit rows and error responses, but is not attached to a log line), no log levels, no correlation of work across worker and API, no metrics endpoint, no tracing, no error aggregation, and no alerting. `/health` returns `{status:'ok'}` unconditionally — it does **not** check the database, so a health check cannot detect a lost DB connection.

This is the weakest area relative to production readiness and should be treated as a first-class Stage D item rather than polish.

### 4.6 Background jobs and reliability — Partial

The outbox worker is correct within its scope: lease fencing, stale-lease reclamation, exponential-style retry via `nextAttemptAt`, `MAX_ATTEMPTS`, terminal `FAILED` with audit. All tested.

Reliability gaps: single process, no supervised restart beyond Docker/CI (absent), no concurrency limit beyond one-at-a-time, no dead-letter queue, no metrics on queue depth or age, no alert on terminal failure, and telemetry is `console`. Graceful shutdown sets a flag and drains via `finally`, which is reasonable, but an in-flight email can still be interrupted mid-delivery and relies on lease expiry to recover.

### 4.7 Docker and environment configuration — Partial

`docker-compose.yml` provides **only** PostgreSQL 17-alpine with a healthcheck and a named volume. There is **no Dockerfile** for the API, no service definition for the API or the worker, no `.dockerignore`, and no production compose.

Environment handling is better than average: `src/config/env.js` validates with Zod, defaults `PORT`/TTLs/bcrypt rounds, rejects insecure production cookies and the console mailer, and `.env.example` documents every variable. `.gitignore` covers `.env*`, `*_key.txt`, `*_key`, and `secrets/`.

Gaps: no `engines` field pinning Node (`engines: null`), no lockfile-enforced Node version, no per-environment config beyond env vars, and no secret-manager integration — production secrets are whatever the environment supplies.

### 4.8 CI/CD and deployment readiness — **Missing**

There is **no `.github/` directory**, no workflow, no pipeline configuration of any kind. Nothing runs the test suite automatically, nothing gates a merge, and nothing builds or publishes an image. `prisma deploy` is a manual script. Combined with §4.5, this means there is currently no automated signal that the repository is healthy.

### 4.9 Documentation — Good on the backend, no frontend exists

| Document | Lines | State |
|---|---|---|
| `README.md` | 178 | Current: architecture, setup, API surface, error contract, test evidence, secret investigation, deferred scope |
| `backend/README.md` | 118 | Current: layout, tenant boundary, migration table, guarantees, env, tests incl. blocked-test explanation |
| `STAGE_C_FINAL_VERIFICATION.md` | 245 | Accurate historical record |
| `STAGE_C_CONCURRENCY_REVIEW.md` | 223 | Accurate historical record |

**Frontend documentation:** there is **no `frontend/` directory**. The repository is backend-only at this commit. No frontend README exists and none should be invented; the root README already states the React/Vite client is planned, not implemented. When it is built it will need its own setup, environment, API base URL, auth/cookie flow, and invitation/signup documentation.

Documentation gaps: no API reference beyond a route table (no request/response schemas), no operational runbook (deploy, rollback, restore), no incident process, no architecture decision records.

---

## 5. Prioritised implementation priorities for Stage D

Ordered by dependency and risk. Each item states the gap, the evidence, impact, dependencies, and risk. This is a proposal for review.

### P0 — Verification that unblocks confidence (do first, cheap)

**P0.1 Generate the Prisma client and run the full suite on a networked machine**

- *Gap:* 6 tests have never executed.
- *Evidence:* §4.2; the message `@prisma/client did not initialize yet`; all bypasses exhausted.
- *Impact:* these are the only tests covering real auth revocation, tenant isolation at the DB level, cross-tenant FK rejection, invitation single-use, platform-admin separation, and platform escalation. Six security-critical behaviours are currently unverified.
- *Dependencies:* none — an environment with `binaries.prisma.sh` reachable.
- *Risk:* **low** effort, **high** information value. If any of the 6 fail, that is a real finding and must be triaged before other work.
- *Order:* **first**, because it may change the priority of everything below.

**P0.2 Add a schema-drift check**

- *Gap:* nothing compares `prisma/schema.prisma` to applied migrations.
- *Evidence:* D3 is exactly the class of defect that drift checking catches; the two status vocabularies diverged silently.
- *Impact:* prevents a whole category of "compiles, tests green, wrong at runtime" defects.
- *Dependencies:* P0.1 benefits it (a generated client enables `prisma migrate diff`).
- *Risk:* low.

### P1 — Correctness defects in the only implemented industry module

School was approved as implemented. Three verified defects mean it is not actually usable, so this is defect repair, not new scope.

**P1.1 Create the school profile on organisation creation (or make the endpoints upsert)**

- *Gap:* D1 — no code path creates `SchoolProfile`; all 14 school endpoints 404 for every tenant created through registration.
- *Evidence:* `grep -rn "schoolProfile\.\(create\|upsert\)" src/ prisma/` → nothing; `school.service.js:22-25` uses `findUnique` then `update`.
- *Impact:* **blocking** — the module is unusable end-to-end.
- *Dependencies:* none. Either create the profile when a SCHOOL organisation is registered, or switch `updateProfile` to `upsert`. The second is smaller and avoids touching the registration transaction.
- *Risk:* low. Prefer `upsert` + a backfill decision for existing tenants, and state explicitly which is chosen.
- *Order:* before any other school work.

**P1.2 Accept ISO-8601 date strings**

- *Gap:* D2 — `z.date()` rejects JSON date strings; every academic-year and term create/update fails 400.
- *Evidence:* executed schema probe, §3.1 D2.
- *Impact:* **blocking** for all date-bearing endpoints.
- *Dependencies:* none.
- *Risk:* low; use `z.coerce.date()` and add a regression test with a JSON string body.

**P1.3 Reconcile the term status vocabulary**

- *Gap:* D3 — terms can never reach `COMPLETED`; `CLOSED` is unreachable.
- *Evidence:* §3.1 D3; DB enum vs service transition map.
- *Impact:* terms are permanently stuck in `ACTIVE`; any downstream feature keyed on term completion will be blocked.
- *Dependencies:* a **decision** is required first — is the correct terminal state `COMPLETED` (matching the DB and API) or `CLOSED` (matching the guard)? Because the DB enum says `COMPLETED`, the lowest-risk fix is to change the guard to `{ PLANNED: ['ACTIVE','COMPLETED'], ACTIVE: ['COMPLETED'] }` and leave the schema alone. This must not be decided silently in code.
- *Risk:* **medium** — it is a semantic decision about the school calendar, and changing a DB enum later requires a migration. Decide explicitly now.

**P1.4 Add School service tests**

- *Gap:* zero tests exercise school service logic; D1/D2/D3 all pass the current suite.
- *Evidence:* `grep -rn "schoolService\|school.service" test/` → nothing.
- *Impact:* without these, Stage D modules will repeat the pattern of untested service logic.
- *Dependencies:* P1.1–P1.3.
- *Risk:* low. This is the highest-leverage test investment available.

### P2 — Operational readiness (needed before real deployment)

**P2.1 Structured logging + request correlation**

- *Gap:* `logger: console`; no structured logger; `requestId` not attached to logs; `/health` does not check the database.
- *Evidence:* §4.5; `src/server.js:10`; `src/app.js:50`.
- *Impact:* without this, production incidents are nearly undiagnosable and a broken DB looks healthy to a health checker.
- *Dependencies:* none. Keep the existing injection point (`createApp({logger})`) so tests are unaffected.
- *Risk:* low. Add a logger dependency deliberately, preserving the `effect@3.22.5` override and the existing audit of 0 vulnerabilities.

**P2.2 CI pipeline**

- *Gap:* no `.github/`, no automated test run, no build.
- *Evidence:* §4.8.
- *Impact:* nothing currently prevents a broken commit from being merged; every claim in this document was produced by manual runs.
- *Dependencies:* P0.1 ideally, so CI can run the full suite rather than a subset.
- *Risk:* low. Start with install + `node --test` on push; add the integration suite once engine access is available in CI.

**P2.3 Container image and deployable compose**

- *Gap:* compose has only PostgreSQL; no Dockerfile for API or worker.
- *Evidence:* §4.7.
- *Impact:* the application cannot currently be deployed as a container from this repository.
- *Dependencies:* P2.1 (a container needs sane logging).
- *Risk:* low–medium; pin the Node version (`engines`) at the same time.

### P3 — Platform breadth (after the above)

**P3.1 Decide and document the School module architecture pattern before adding industries.** School diverges from the shared platform in audit writes and locking strategy. Building SACCO/Clinic/Rentals on the diverging pattern would multiply the inconsistency fourfold. This is an alignment task, not a rewrite, and it directly serves the instruction not to open unnecessary rewrites.

**P3.2 SACCO, Clinic, Rentals.** Genuinely missing (no tables, services, routes, or tests). Do not sequence them until P1 and P3.1 are complete, otherwise three more untested, diverging modules will be produced. No requirements for these modules exist in the repository, so specification work precedes any implementation.

**P3.3 Reporting.** Missing. Must follow the data it reports on, and should not be built before audit and domain data are stable.

**P3.4 Billing and subscription.** Missing beyond permission strings. This is the largest genuinely-new capability and carries payment and compliance risk. It was explicitly out of Stage C scope and should remain deferred until the platform above is operational, with independent review of any payment integration.

### P4 — Hardening backlog (track, do not block on)

- Role identity by name rather than stable key (§2.3).
- `audit_logs` append-only enforcement and, if required, hash chaining; retention and export (§2.9).
- Route-coverage test asserting every mounted route is tenant- and permission-guarded (§2.2).
- School schemas to `.strict()` for consistency (§4.3).
- Dead-letter queue and alerting for the outbox; SMTP integration test (§4.6).
- Operational runbook and ADRs (§4.9).

---

## 6. Proposed Stage D scope (for architectural review)

A defensible Stage D, in order:

1. **Verification gate** — generate Prisma client, run all 82 tests, record actual results; add schema-drift checking. (P0)
2. **Repair School to a genuinely usable state** — profile provisioning, date coercion, term status decision, and a service-level test suite. (P1)
3. **Operational baseline** — structured logging with request correlation, health that reflects the database, and a CI pipeline that runs the suite. (P2)
4. **Decide the industry-module pattern** and align School to it, *before* any new industry work. (P3.1)

Explicitly **out of Stage D scope**: SACCO/Clinic/Rentals implementation, reporting, billing, and the frontend. These depend on Stage D outcomes or carry risk that warrants separate approval.

This ordering deliberately puts verification and repair before breadth. The repository currently has one industry module that is documented as implemented but is unusable end-to-end, and that gap was invisible to a fully green test suite — closing that class of gap is worth more than adding three more modules of the same shape.

---

## 7. Assumptions and limits of this assessment

- Every defect reported here (D1, D2, D3) was verified by **direct execution or exhaustive grep**, not inferred from reading. Where a first attempt at verification was invalid — an early probe called a function that is not exported — it was discarded and re-done rather than reported.
- Test results are from `node --test` in this sandbox. The 6 integration tests did **not** run and are not counted as passing.
- No source file, migration, schema, dependency, or database was modified. The only repository change is the addition of this document.
- The git ref reset described in §1.1 was repaired without altering any commit, branch, or remote history.
