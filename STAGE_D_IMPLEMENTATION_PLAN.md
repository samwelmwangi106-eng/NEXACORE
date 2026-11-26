# NexaCore — Stage D Implementation Plan (Revision 2)

**Branch:** `arena/8c9954b6-nexacore`
**Stage C code checkpoint:** `d1e964dff00556be430e04b5780eb7d99b7185be`
**Post-Stage C assessment:** `67d8c24f0ad1bbe32a45abbcba607cd2c55e124f`
**Plan revision 1 commit:** `6a8967f9095b70323ca219ea1a06dc7c188a8546`
**Status:** planning document only. No source, schema, migration, dependency or database change was made in producing this revision.

> **Revision note.** This document updates `STAGE_D_IMPLEMENTATION_PLAN.md` in place rather than replacing it, preserving its history. Revision 2 incorporates every correction from the Stage D review: the D1 integration-test safety safeguards, the D2.A provisioning-boundary and backfill revisions, D2.B cross-field persisted-record validation, the narrowed D2.C transition set, the new D2.D grade-level section, the D2.E test matrix, the D3 correlation/timeout/deployment corrections, and the strict reduction of D4 to assessment only.

---

## 0. Correction to the Stage C diagnosis (retained)

Stage C concluded that `prisma generate` was blocked because `binaries.prisma.sh` is unreachable. **That diagnosis was incomplete.** Two distinct failure modes were conflated:

| Condition | Observed result | Real cause |
|---|---|---|
| `DATABASE_URL` **unset** (no `backend/.env` in the sandbox) | `request to …/libquery_engine.so.node.sha256 failed, TLS` | `prisma.config.js`'s schema-engine adapter `throw`s before Prisma can use the JS engine, so the CLI falls back to the native engine and attempts a download |
| `DATABASE_URL` **set** to any syntactically valid value, even an unreachable one | `Error code: P1012 … You must specify the same number of fields in fields and references` (2 errors) | **The schema is invalid.** Generation cannot succeed regardless of network |

Decisive experiment: with `DATABASE_URL` set to a deliberately dead address (`postgresql://u:p@127.0.0.1:1/x`) and the two relation errors corrected **in an isolated `/tmp` copy only**, generation completed:

```
✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 214ms
```

No network was available during that run. **`prisma generate` does not require network access in this configuration** — the project already uses `engine: 'js'` (`prisma.config.js`) and `engineType = "client"` (`schema.prisma:3`), the Rust-free path.

### 0.1 The schema defect (D1 blocker)

`backend/prisma/schema.prisma` declares two relations with mismatched arity:

- line 159 (`MemberRole.role`): `fields: [roleId, organisationId]` → `references: [id]`
- line 217 (`OrganisationInvitation.role`): `fields: [roleId, organisationId]` → `references: [id]`

Migrations 001 declare the corresponding **composite** foreign keys:

```
member_roles_role_id_organisation_id_fkey:
  FOREIGN KEY ("role_id","organisation_id") REFERENCES "roles"("id","organisation_id")
organisation_invitations_role_id_organisation_id_fkey:
  FOREIGN KEY ("role_id","organisation_id") REFERENCES "roles"("id","organisation_id")
```

`Role` already carries `@@unique([id, organisationId])`, so the correct declaration is `references: [id, organisationId]`. The schema is out of sync with the migrations it describes.

This is recorded openly: the Stage C conclusion that the six tests were "environment-blocked, not evidence of a code defect" was **half right**. They are blocked, but at least part of the blockage is a real repository defect.

---

## D1 — Prisma and verification baseline

### D1.1 Problem and evidence

- Six tests in `backend/test/integration/postgres.integration.test.js` have never executed (§0).
- `backend/src/modules/organisations/organisation.service.js:1` imports `{ MembershipStatus }` from `@prisma/client`, a value only the generated client provides. No test can currently import that module, so `createOrganisation` — behind `POST /api/v1/organisations` — **has never been executed by any test**.
- The schema does not validate, so generated types are unverifiable.

### D1.2 Affected files

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | Lines 159, 217: `references: [id]` → `references: [id, organisationId]` |
| `backend/test/integration/postgres.integration.test.js` | Add the connection-safety assertion (§D1.5) |
| `backend/.env.example` | Document `DATABASE_URL` as required for generation; state tests never use it |
| `backend/README.md`, `README.md` | Correct the "network-blocked" explanation |
| `STAGE_C_FINAL_VERIFICATION.md` | Append a correction note; do **not** rewrite past content |

### D1.3 Versions and engine configuration — no change

Pin and document what already exists. **No dependency upgrade is proposed.**

| Package | Declared | Resolved |
|---|---|---|
| `@prisma/client` | `^6.19.3` | `6.19.3` |
| `@prisma/adapter-pg` | `^6.19.3` | `6.19.3` |
| `prisma` (dev) | `^6.19.3` | `6.19.3` |

- Generator: `provider = "prisma-client-js"`, `engineType = "client"`.
- `prisma.config.js`: `experimental: { adapter: true }`, `engine: 'js'`, adapter supplied by `PrismaPg`.
- **`effect@3.22.5` and the existing `supertest ^7.1.4` / `deepmerge-ts ^8.0.2` overrides are preserved untouched.** The 0-vulnerability audit baseline is retained.

### D1.4 Environment variables and commands

**Generation vs live-database commands — an explicit distinction.**

Commands that require **no** live database:

| Command | Purpose | Requires |
|---|---|---|
| `npx prisma validate` | Schema/relation validation | `DATABASE_URL` set to *any* valid URL (only to satisfy config construction) |
| `npm run db:generate` | Emit the client into `node_modules` | Same — **no database contact, no network** |

Commands that **do** require a live database:

| Command | Purpose | Requires |
|---|---|---|
| `npx prisma migrate diff --from-migrations … --to-schema-datamodel …` | Schema-drift detection | A reachable PostgreSQL for the shadow/migration side |
| `npm run db:deploy` | Apply migrations via the checked-in JS runner | `DATABASE_URL` pointing at the target |
| `npm run db:seed` | Seed permission catalog | Target database |
| `node prisma/backfill-school-profiles.js` (new, D2) | Profile backfill | Target database |

**Required environment variables**

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | `prisma.config.js`, deploy, seed, CI generation | For generation/validation any valid URL suffices. **Never** required by unit tests |
| `SHADOW_DATABASE_URL` | Drift check | Disposable local database only |
| `JWT_ACCESS_SECRET` | Runtime auth | ≥32 chars; not needed for D1 |

**Exact commands**

```sh
cd backend
npm ci
npx prisma validate                       # no live DB
npm run db:generate                       # no live DB, no network
npm run db:generate && npm test           # full suite incl. the 6 previously-blocked
npm run test:integration                  # ephemeral embedded PostgreSQL
node --test test/concurrency-postgres.test.js
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
```

**Database requirements.** Generation requires none. The integration suite requires none pre-provisioned: `postgres.integration.test.js:68` starts an ephemeral `embedded-postgres` cluster on a dynamically allocated port and applies migrations through `applyMigrations` (`src/lib/migrations.js`). **No test contacts Neon or any external database by design.**

### D1.5 Integration-test isolation safeguards (new in revision 2)

The previous plan asserted isolation but did not enforce it. Revision 2 requires a **positive allowlist**, not a denylist:

1. **Explicitly permitted loopback addresses only.** The guard accepts exactly `127.0.0.1` and `::1` (and the literal `localhost` **only** after resolution is confirmed to be loopback). Anything else fails the suite before any connection is made.
2. **Do not assume the embedded library returns a single hostname.** `embedded-postgres` may yield `127.0.0.1` or `::1` depending on platform and IPv6 availability. The guard must accept the documented set, not a hard-coded string, and the test must derive the expectation from the cluster it actually started rather than from an assumption.
3. **Refuse any externally resolvable host.** Neon hostnames (e.g. `*.neon.tech`), any non-loopback DNS name, and any non-loopback IP are rejected outright — including private ranges, because a staging database could live in one.
4. **Refuse the ambient `DATABASE_URL`.** If the cluster's connection string equals or resolves to the same host/port as `process.env.DATABASE_URL`, abort. This is the highest-value check: it stops a mis-set environment from running `applyMigrations` against production.
5. **Assert before connecting**, not after, so a misconfiguration cannot execute a single DDL statement.
6. Apply the same guard to `concurrency-postgres.test.js` and any future real-database test, by putting it in one shared helper rather than duplicating it.

### D1.6 Schema-drift check

`prisma migrate diff` is available (verified: `--from-url`, `--to-url`, `--from-migrations`, `--from-empty`, `--exit-code`). Run against a **disposable** database only. `--exit-code` makes CI fail on drift. This is precisely what would have caught the §0.1 defect.

### D1.7 Security and tenancy implications

- Generation is read-only apart from writing into `node_modules`.
- The drift check reads a throwaway local database.
- The §D1.5 guard protects production data from developer error — material, because `applyMigrations` will happily create and drop schema objects.

### D1.8 Tests and acceptance criteria

1. `npx prisma validate` exits 0.
2. `npm run db:generate` exits 0 **with the network unavailable** (proven by running it offline).
3. **All 82 existing tests pass** (76 pass + 6 previously-blocked → 82 pass, 0 fail).
4. The 6 integration tests pass; any residual failure is documented with its real cause and triaged as a defect, **not** relabelled environmental.
5. Drift check exits 0.
6. A deliberately drifted schema makes the drift check exit non-zero.
7. The isolation guard rejects a simulated non-loopback `DATABASE_URL`.

### D1.9 Dependencies and order

**First.** Every later stage depends on a generated client, because no service touching `@prisma/client` is testable without it.

### D1.10 Risks and rollback

| Risk | Mitigation |
|---|---|
| Composite-FK change may not be the only schema error | `npx prisma validate` iteratively until clean before generating |
| Generated client could alter behaviour of mocked tests | Those tests use doubles; run the full suite immediately |
| Drift check may surface pre-existing intentional divergence | Establish the baseline during D1; decide explicitly rather than suppressing |
| Rollback | Revert the two-line schema change and the guard; no database object changes because no migration is altered |

---

## D2 — School module completion

### D2.0 Defects in scope

The three accepted defects (profile provisioning, date handling, term lifecycle) plus three discovered during planning. Each gets a dedicated regression test.

| ID | Defect | Evidence |
|---|---|---|
| **A1** | No code path creates a `SchoolProfile`; all 14 school endpoints 404 for new tenants | `grep -rn "schoolProfile\.\(create\|upsert\)" src/ prisma/` → nothing |
| **B1** | `z.date()` rejects JSON date strings; every date-bearing write returns 400 | Executed probe: `expected date, received string` |
| **C1** | Terms can never reach a terminal state; `CLOSED` is not a DB enum value | Transition map at `school.service.js:144` vs enum `('PLANNED','ACTIVE','COMPLETED')` |
| **C2** | `updateTerm` reads `current.academicYear.status` (`:146`) but its query (`:138-140`) has no `include`, so term activation would raise `TypeError` under a real client | Line-by-line inspection |
| **D1** | `gradeLevelId` is never validated against the organisation; isolation survives only via the composite FK, surfacing a raw database error | `school.service.js` `createSection`/`updateSection` |
| **E1** | Zero tests exercise school **service** logic; A1–D1 all survive a green suite | `grep -rn "schoolService\|school.service" test/` → nothing |

**Additional hardening observation (not a claimed vulnerability).** `updateGradeLevel` (`school.service.js:212`) updates with `where: { id: gradeLevelId }` alone. Tenant safety holds because the org-scoped read at `:202` throws `404` first, and the transaction is `Serializable`. The write is nonetheless not org-scoped itself, which is a defence-in-depth inconsistency with the pattern used elsewhere. Recorded for consideration; **not** scheduled as a change in Stage D unless approved.

### D2.A — School profile provisioning

**Problem.** No path creates a `SchoolProfile`. `getProfile`/`updateProfile` both `findUnique` then `update`, throwing `404 SCHOOL_PROFILE_NOT_FOUND`.

**Required fields, defaults and nullability — verified from the model and DDL**

| Field | Type | Nullability | Default | Constraint |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `uuid()` | PK |
| `organisationId` | UUID | NOT NULL | — | **UNIQUE** (`school_profiles_organisation_id_key`), FK → `organisations(id)` ON DELETE CASCADE |
| `schoolCode` | VARCHAR(40) | **NULLABLE** | none | `UNIQUE (organisationId, schoolCode)` |
| `timeZone` | VARCHAR(80) | NOT NULL | `'Africa/Nairobi'` | — |
| `weekStartsOn` | INTEGER | NOT NULL | `1` | `CHECK BETWEEN 1 AND 7` |
| `createdAt` | TIMESTAMPTZ | NOT NULL | `CURRENT_TIMESTAMP` | — |
| `updatedAt` | TIMESTAMPTZ | NOT NULL | **NO DEFAULT** | must be supplied explicitly by any raw SQL |

`updatedAt` having no database default is the operationally important detail: a backfill implemented as raw `INSERT … SELECT` must set it (`now()`) or the insert fails. An ORM insert populates it via `@updatedAt`.

**Which fields may safely be defaulted, and which must come from the business**

- **Safely defaulted:** `timeZone` (`Africa/Nairobi`, the product's operating locale and an explicit column default) and `weekStartsOn` (`1` = Monday). Both are non-semantic display/scheduling preferences with valid, revisable defaults.
- **Business-supplied, and legitimately absent at creation:** `schoolCode` is **nullable by design** — an onboarding tenant may not have one yet. Leaving it `NULL` is a *correct* state, not an incomplete placeholder, because the schema models "not yet assigned" explicitly and the composite unique index permits multiple `NULL`s per organisation.
- **Never invented:** no fabricated school code, no guessed timezone override, no synthetic identifiers.

This is the answer to the review's "valid and usable, not an incomplete placeholder" requirement: a created profile is valid because every NOT NULL column is populated by a verified default, and `schoolCode`'s absence is modelled by the schema rather than hidden.

**Dependency-graph inspection and the provisioning boundary**

The require graph was inspected before choosing a location:

- `src/modules/school/school.service.js` imports **only** `src/lib/errors` — it is a leaf.
- `src/modules/auth/auth.service.js` imports `config/permissions`, `lib/security`, `lib/errors`, `audit`, `notifications`.
- `src/modules/organisations/organisation.service.js` imports `config/permissions`, `audit`, **`../auth/auth.service`** (for `slugify`).

Two consequences:

1. Calling `school.service` from `auth.service` or `organisation.service` creates **no cycle**, because `school.service` is a leaf.
2. Putting the helper in `auth.service` **would** create a cycle-adjacent dependency: `organisation.service` imports `auth.service`, and both would import the beginner. Placing it in `school.service` keeps the graph acyclic and keeps School knowledge inside the School module.

**Proposed boundary.** A single exported function in the School module:

```js
// src/modules/school/school.service.js
async function ensureSchoolProfile(tx, organisation) {
  if (organisation.industry !== 'SCHOOL') return null;
  return tx.schoolProfile.upsert({
    where: { organisationId: organisation.id },
    create: { organisationId: organisation.id },
    update: {},
  });
}
```

- It accepts the **existing transaction client** (`tx`), so it composes with the caller's transaction and cannot open its own.
- It is idempotent by construction (`upsert` on the unique `organisationId`).
- It is a function in an existing module, **not** a new abstraction layer.
- Industry filtering lives in the helper, so neither caller can forget it.

**Call sites — both organisation-creation paths**

| Site | File | Timing |
|---|---|---|
| Registration | `auth.service.js:113` (organisation created inside `$transaction`) | Immediately after `organisation.create`, same transaction |
| Direct creation | `organisation.service.js:8` (`POST /api/v1/organisations`) | Immediately after `organisation.create`, same transaction |

**Transactional safety.** Because both call sites pass their own `tx`, a failure rolls back the organisation too. Acceptance test asserts that a rolled-back registration leaves **zero** profiles.

**Duplicate prevention.** Already guaranteed: `school_profiles_organisation_id_key` is a UNIQUE index on `organisation_id` (migration 002, line 18). **No new constraint is required.**

**`updateProfile` upsert must not create an invalid profile.** `updateProfile` will use `upsert` keyed on `organisationId` so a legacy tenant can be established lazily. It creates with **defaults only** — exactly the values the database itself would supply. It must **not**:

- invent a `schoolCode`,
- accept `organisationId` from the request,
- relax the `1..7` constraint on `weekStartsOn`,
- write `NULL` into a NOT NULL column.

Validated fields remain validated on the update path; the create branch supplies no user input at all.

**Existing SCHOOL organisations without profiles — backfill script**

Deliverable: `backend/prisma/backfill-school-profiles.js`. **Manually executed only. Never invoked from application startup, never from a migration, never from `seed.js`.**

Requirements:

| Requirement | Design |
|---|---|
| Dry-run / preview | `--dry-run` (default when `--apply` absent) prints the exact set of organisations that would be created, with ids and names, and changes nothing |
| Strictly SCHOOL-only | `WHERE o.industry = 'SCHOOL'` in both preview and apply |
| Conflict-safe | `INSERT … SELECT … WHERE NOT EXISTS` plus `ON CONFLICT (organisation_id) DO NOTHING` — belt and braces |
| Auditable summary | Prints and returns `{ previewed, created, skipped, failed[] }`; failures reported per-organisation with reason, never aborting the whole run |
| Idempotent | Re-running creates 0 rows and reports them as `skipped` |
| `updatedAt` correctness | Raw SQL sets `updated_at = now()` (§D2.A table) |
| No automatic execution | Not referenced by `server.js`, `migrations.js`, `seed.js`, or any npm lifecycle hook |
| Audit trail | Writes a platform audit row per run summarising counts (actor `null`, action `school.profile_backfill`) |

**Execution prerequisites:** a verified backup or snapshot; `DATABASE_URL` explicitly confirmed as the intended target; the script prints the resolved database host/database name and requires `--confirm <database-name>` before applying.

**Recovery behaviour:** because insertion is conflict-safe and idempotent, recovery is "re-run". There is no partial state to unwind; any organisation already provisioned is skipped. If a run is interrupted, re-running completes it.

**Database and migration implications: none.** Table, unique index and FK already exist. Code-only plus a standalone script.

**Security and tenancy:** the profile is always keyed to the `organisationId` of the transaction that created it; never caller-supplied. `updateProfile` remains scoped by `req.tenant.id`.

**Acceptance criteria:** SCHOOL registration yields exactly one profile; SACCO/CLINIC/RENTAL yield none (asserted by count); `POST /organisations` with SCHOOL yields one; rollback yields zero; `PUT /school/profile` on a profile-less tenant succeeds via upsert; double provisioning yields one row; dry-run changes nothing; apply creates only SCHOOL rows; re-run creates zero.

### D2.B — Date handling

**Problem.** Eight schema fields use `z.date()` (`school.schemas.js` lines 11, 12, 18, 19, 26, 27, 34, 35). JSON delivers strings, so every academic-year and term create/update returns `400 VALIDATION_ERROR`. Class sections have no date fields and are unaffected.

**Semantics — stated before any coercion is chosen**

1. **Wire format:** ISO-8601 calendar dates, `YYYY-MM-DD`. The columns are `@db.Date` (`starts_on`, `ends_on`), so a time component would be discarded by PostgreSQL anyway; accepting one would mislead.
2. **Validation:** must match `^\d{4}-\d{2}-\d{2}$` **and** survive a real calendar check (`2026-02-30` rejected — a regex cannot do this alone).
3. **Timezone:** a bare calendar date carries no timezone and must not acquire one. Parse to UTC midnight so the stored `DATE` equals the date written, independent of server locale.
4. **Rejected forms:** impossible dates; locale-dependent strings (`05/01/2026`); epoch numbers (`1704067200000`); unsupported timestamp formats (`2026-01-05T10:00:00Z`).
5. **Explicitly rejected alternative:** `z.coerce.date()`. It accepts numeric epochs and locale-dependent strings, contradicting the semantics above. The review asked not to apply indiscriminate coercion; this is why.

```js
const calendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO calendar date (YYYY-MM-DD)')
  .refine(isRealCalendarDate, 'Not a real calendar date')
  .transform(function toUtcMidnight(v) { return new Date(v + 'T00:00:00.000Z'); });
```

**Cross-field validation must validate the resulting persisted record (new in revision 2)**

Validating only the fields present in a PATCH is insufficient. Counter-example supplied by the review, and it is correct:

- Stored: `startsOn = 2026-01-05`, `endsOn = 2026-01-20`.
- Client PATCHes **only** `startsOn = 2026-01-25`.
- The request contains no `endsOn`, so a request-scoped `refine` has nothing to compare and passes.
- The record would persist with start after end. **Must be rejected.**

**How the service obtains and validates existing values.** The check belongs in the **service transaction**, not the schema, because only there are the current values readable and the write atomic:

```
BEGIN
  SELECT starts_on, ends_on FROM school_academic_years
    WHERE id = $id AND organisation_id = $org        -- org-scoped read
  effectiveStart = data.startsOn ?? stored.startsOn  -- merge
  effectiveEnd   = data.endsOn   ?? stored.endsOn
  if (effectiveEnd < effectiveStart) -> 400 DATE_RANGE_INVALID
  UPDATE ... (org-scoped)
COMMIT
```

**Avoiding the read/write race.** The read and the update occur in the same transaction, and the row is selected with `FOR UPDATE` semantics (`SELECT … FOR UPDATE`, or an equivalent Prisma pattern) so a concurrent writer cannot change `endsOn` between the check and the write. Where the row cannot be locked (for example a pure ORM path), the existing `isolationLevel: 'Serializable'` on the school transactions already forces a serialization failure rather than a silent anomaly. **Chosen policy:** keep `Serializable` on these transactions and add the explicit lock, so both defence layers apply. The service also re-validates on the *merged* record, so a schema-level check and a service-level check cannot disagree.

The same rule applies to `updateSection` (no dates) and to `updateTerm` (dates plus the academic-year guard), so `updateTerm` gets both the date-range check and the D2.C academic-year check in one transaction.

**Database and migration implications: none** — columns are already `DATE`.

**Acceptance criteria:** valid dates accepted and stored as written; every rejected form returns a field-level 400; the review's partial-update counter-example is rejected with `400 DATE_RANGE_INVALID`; a valid partial update succeeds; the same date near midnight under a non-UTC server timezone stores the intended calendar date; the check holds under a concurrent competing update.

### D2.C — Term lifecycle

**Problem.** Three vocabularies disagree:

| Source | Values |
|---|---|
| DB enum `SchoolTermStatus` (migration 002) | `PLANNED`, `ACTIVE`, `COMPLETED` |
| `school.schemas.js:28,36` | `PLANNED`, `ACTIVE`, `COMPLETED` |
| `school.service.js:144` transition map | `{ PLANNED: ['ACTIVE','CLOSED'], ACTIVE: ['CLOSED'] }` |

Verified by executing the guard: `PLANNED→ACTIVE` allowed; `PLANNED→COMPLETED`, `ACTIVE→COMPLETED` and anything from `COMPLETED` blocked; `CLOSED` is not a legal database value. **A term can be activated but never completed.** The same literal is used at `:274` for class sections, whose enum *does* contain `CLOSED`, so sections are correct and the defect is confined to terms.

**Approved transition set (narrowed per review)**

| From | Allowed to | Notes |
|---|---|---|
| `PLANNED` | `ACTIVE` | |
| `ACTIVE` | `COMPLETED` | |
| `COMPLETED` | — | **Terminal. Immutable.** |

**`PLANNED → COMPLETED` is deliberately excluded.** The review is right that this should not be added reflexively. The investigation:

- **Plausible use case:** an institution that adopts NexaCore mid-year may need to record a term that has already finished, without fabricating an `ACTIVE` period it never had. Recording it as `ACTIVE` and immediately `COMPLETED` would create two audit events describing a state the institution never occupied.
- **Counter-consideration:** allowing `PLANNED→COMPLETED` lets a term skip `ACTIVE` entirely, which weakens "was this term ever running?" as a queryable fact and complicates any future attendance/assessment feature that keys on `ACTIVE`.
- **Status: UNRESOLVED.** This plan does **not** add the transition. It is recorded as an open product decision (§7.2, U1) requiring confirmation with a named workflow before inclusion. Until then the guard omits it.

**Companion fixes required in the same change**

1. **C2 — missing relation load.** `updateTerm` must add `include: { academicYear: true }` to the `findUnique` at `:138-140`. Without it, `current.academicYear.status` at `:146` raises `TypeError` under a real client, and the academic-year guard appears to work only because that line is never reached in tests.
2. **Academic-year guard executes correctly.** After the relation is loaded, activating a term must still require `academicYear.status === 'ACTIVE'`, returning `409 ACADEMIC_YEAR_NOT_ACTIVE` otherwise. This behaviour is currently unreachable and must be proven by a test that would fail without the `include`.
3. **Single source of truth.** The transition table is extracted to one named constant exported by the School module module-scope (not a new module, not a new abstraction layer — a constant in `school.service.js`), referenced by both terms and sections so the two cannot drift again. Terms and sections keep *different* tables because their enums differ; the constant merely stops the literal being copy-pasted.
4. **Consistency assertion.** A test asserts the term transition table, the API enum, and the database enum agree — so a future edit to any one of the three fails the suite.

**Migration necessity: none.** The enum already contains all three values. This is a code-only reconciliation, which is why `COMPLETED` was chosen over `CLOSED`. A migration would be required only if the terminal state were changed to `CLOSED`, which is recommended against.

**Database implications:** none. **Migration history untouched.**

**Acceptance criteria:** `PLANNED→ACTIVE` and `ACTIVE→COMPLETED` succeed; `PLANNED→COMPLETED` is refused with `409 INVALID_STATUS_TRANSITION`; every transition out of `COMPLETED` is refused; activating a term under a non-ACTIVE year returns `409 ACADEMIC_YEAR_NOT_ACTIVE`; the enum-consistency test passes.

### D2.D — Grade-level validation (new section in revision 2)

**Problem (D1).** `createSection` and `updateSection` accept `gradeLevelId` and write it through without checking it belongs to the organisation. Cross-tenant safety currently survives only because the composite FK `(grade_level_id, organisation_id) → school_grade_levels(id, organisation_id)` rejects a foreign row — which surfaces as a **raw database foreign-key error** rather than a clean client error.

**Approved behaviour.** Return **`404 GRADE_LEVEL_NOT_FOUND`** when the grade level does not exist within the current organisation. Never leak a raw FK error.

**Implementation shape.** Within the same transaction, before the write:

```js
const gradeLevel = await tx.schoolGradeLevel.findUnique({
  where: { id: data.gradeLevelId, organisationId },   // org-scoped
});
if (!gradeLevel) throw new AppError(404, 'GRADE_LEVEL_NOT_FOUND', 'Grade level not found');
```

Applied to `createSection` and to `updateSection` **only when `gradeLevelId` is present** in the request (a PATCH omitting it must not require it).

**Tenant scoping and concurrency.** The lookup is organisation-scoped, so a grade level from another tenant is indistinguishable from a non-existent one — the 404 does not disclose existence elsewhere. The check runs inside the same transaction as the write; under the school module's `Serializable` isolation, a concurrent deletion of the grade level causes a serialization failure or an FK violation rather than a silently invalid reference.

**The composite constraints remain the final integrity boundary.** The service check improves the *error contract*; it does not replace the database guarantee. Both are retained, and a test asserts that the FK still rejects a cross-tenant reference even if the service check were bypassed.

**Also in scope:** `createSection`/`updateSection` should reject a `gradeLevelId` that exists but belongs to another organisation with the same 404, and `updateSection` must continue to require an existing academic year.

**Database and migration implications: none.** The constraints exist.

**Acceptance criteria:** invalid UUID-shaped but unknown grade level → `404 GRADE_LEVEL_NOT_FOUND`; a real grade level from another organisation → `404 GRADE_LEVEL_NOT_FOUND`, never a 500 or a raw FK message; a valid in-tenant grade level succeeds; a PATCH omitting `gradeLevelId` succeeds; the FK still blocks a bypassed cross-tenant write.

### D2.E — School test coverage

**Problem (E1).** Zero tests exercise School service logic; A1–D1 and the hardening observation all survive a green suite.

**New files**

- `backend/test/school-service.test.js` — service-level, real PostgreSQL via the existing harness `backend/test-support/real-pg-harness.js`.
- `backend/test/school-profile-provisioning.test.js` — provisioning and backfill safety.
- `backend/test/school-module.test.js` — **retained** for route gate and permission coverage.

| Area | Required cases |
|---|---|
| Profile creation | SCHOOL registration creates exactly one; `POST /organisations` SCHOOL creates exactly one |
| Other industries | SACCO/CLINIC/RENTAL create **none** (asserted by count, not absence of call) |
| Transaction rollback | rolled-back registration leaves zero profiles |
| Idempotency | provisioning twice yields one row; unique index honoured |
| Upsert validity | `PUT /school/profile` on a profile-less tenant creates with defaults only, `schoolCode` NULL, no invented values |
| Backfill | dry-run changes nothing; apply creates only SCHOOL rows; re-run reports 0 created / all skipped; summary counts are accurate; failure of one row does not abort others |
| Academic years | create/list/update; unique name per org; `endsOn < startsOn` rejected; status transitions `DRAFT→ACTIVE→CLOSED` |
| Partial date updates | the review's counter-example (start-only PATCH beyond stored end) rejected with `DATE_RANGE_INVALID`; a valid partial update succeeds |
| Terms | create; sequence uniqueness per (org, year); every permitted transition; **every forbidden transition individually**; `COMPLETED` terminal; activation blocked when year not ACTIVE; `include` regression (C2) fails without the fix |
| Enum consistency | term transition table, API enum and DB enum asserted equal |
| Grade levels | create/list/update; unique name and code per org; `ACTIVE→INACTIVE` only |
| Class sections | create/list/update; requires existing year; activation requires ACTIVE year; invalid `gradeLevelId` → `404 GRADE_LEVEL_NOT_FOUND`; cross-tenant `gradeLevelId` → 404 |
| Date validation | all forms from D2.B, on both create and update schemas |
| Tenant isolation | org B cannot read, update or reference org A's year/term/level/section |
| Permissions | writes without `school.manage` → 403; reads without `school.read` → 403 |
| Industry gate | non-SCHOOL → `404 SCHOOL_MODULE_NOT_ENABLED` |
| Coverage completeness | every exported function in `school.service.js` invoked by at least one test |

**Mechanism.** Service tests run against the real ephemeral cluster so behaviour is asserted against real constraints, not mocks. Route-level permission and gate tests remain in `school-module.test.js`.

**Acceptance criteria:** each defect A1–E1 has a dedicated regression test that fails if the fix is reverted; every documented error code is asserted; the suite fails if the transition tables, API enums and DB enums diverge.

### D2.F — Dependency and order

1. **D2.A + D2.C/C2** together — both touch `school.service.js`; profile work needs the client from D1.
2. **D2.B** — schemas plus the service-level merged-record check.
3. **D2.D** — sections/grade levels.
4. **D2.E** written alongside each fix, not after.

**D1 must complete first.**

### D2.G — Risks and rollback

| Risk | Mitigation |
|---|---|
| Provisioning in `register()` touches a hot path | One upsert inside an existing transaction; rollback test proves atomicity |
| Backfill could create profiles for stale data | `WHERE industry='SCHOOL'`; dry-run default; `--confirm <db>` gate |
| Choosing `COMPLETED` conflicts with a product expectation | Explicit approval recorded (§7.1); alternative requires a migration this plan avoids |
| Upsert could mask a genuine missing-profile bug | Lifecycle provisioning remains primary; upsert documented as a safety net with its own test |
| Merged-record date check could regress existing updates | Both schema-level and service-level checks; explicit partial-update tests |
| Rollback | Code-only plus a standalone script; revert commits. No migration to reverse |

---

## D3 — Operational engineering

Four separately reviewable scopes. Each independently revertible.

### D3.1 Structured logging

**Problem.** `src/server.js:10` and `src/workers/email-outbox.js:12` pass **`logger: console`**. No structured logger is in dependencies.

**Decision: Pino approved, subject to review.** Verified facts for that review:

- Current release `10.4.0`.
- Dependencies are pure JavaScript (`sonic-boom`, `thread-stream`, `@pinojs/redact`, `safe-stable-stringify`, …) — **no native compilation**, so no toolchain is required in CI or the container.
- It ships `@pinojs/redact` for built-in redaction.

Conditions attached to the approval:

1. **Dependency/version compatibility review** before merge, pinning an exact version and confirming Node 22 support.
2. **Redaction is mandatory and tested**: `password`, `passwordHash`, `token`, `refreshToken`, `accessToken`, `authorization`, `cookie`, `secret`, `EMAIL_OUTBOX_ENCRYPTION_KEY`, `encryptedPayload`, and any `*.password` / `*.token` path. Reuse the existing redaction intent already present in `outbox.service.js` `safeErrorMessage`.
3. **No unnecessary dependency upgrades.** `effect@3.22.5` and all existing overrides untouched; audit baseline preserved.
4. **Preserve the existing injection design** — `createApp({ logger })` already accepts a logger, so no call site changes and tests keep injecting doubles.

**Affected files:** `src/lib/logger.js` (new), `src/server.js`, `src/workers/email-outbox.js`, `src/config/env.js`, `backend/package.json`, `.env.example`.

**Tests:** redaction of each listed field; injected (not global) logger; level filtering; no secret appears in serialised output.

### D3.2 Request correlation

**Problem, stated accurately.** A `requestId` **already exists** (`app.js:44-46`: `crypto.randomUUID()`, returned as `X-Request-Id`, present in audit rows and error bodies). It is simply **never attached to a log line**. This is correlation, not generation.

**Required behaviour**

1. **Validate inbound `X-Request-Id` before accepting** — accept only `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (UUID). Invalid values are **replaced** with a generated id, not trusted, which also prevents header/log injection.
2. Attach the id to structured request logs (`req.log = logger.child({ requestId })`).
3. Preserve correlation across operations: audit rows already carry `requestId`; the worker stamps its own per-job correlation and includes `outboxId`.
4. Response `X-Request-Id` reflects the accepted or generated value consistently.

**Affected files:** `src/app.js`, `src/workers/email-outbox.js`.

**Tests:** valid inbound echoed; malformed/oversized/injection-shaped inbound replaced; id present on request logs; response header matches the log.

### D3.3 Readiness and liveness

**Problem.** `app.js:50` returns `{status:'ok'}` unconditionally, so a dead database reports healthy.

**Correction accepted: `Promise.race()` does not cancel the underlying query.** A raced timeout only stops the *await*; the Prisma query and its connection remain live, so an unhealthy database accumulates abandoned queries and can exhaust the pool — degrading the very endpoint meant to report health.

**Required: a genuinely bounded probe** covering both connection acquisition and query execution.

Design:

- Use a **dedicated, single-connection client** for readiness, not the shared application pool, so a probe cannot starve request traffic.
- Bound **connection acquisition** with the adapter/pool connection timeout (`connectionTimeoutMillis`), not a JavaScript race.
- Bound **statement execution** with PostgreSQL's own `statement_timeout` set on that session (`SET LOCAL statement_timeout = '2000ms'`), so the server aborts the query and releases the connection.
- Additionally guard the whole probe with an overall deadline, but treat that as a last resort rather than the mechanism — if it fires, the connection is closed explicitly rather than abandoned.
- Cache the result for a short interval (e.g. 1s) so a probe storm cannot itself become the outage.

**Response contract**

| Endpoint | Semantics | Behaviour |
|---|---|---|
| `GET /health` | **Liveness** | No I/O; unchanged `{status:'ok'}` contract, so existing probes and tests keep working |
| `GET /health/ready` | **Readiness** | `200 {status:'ready'}` or `503 {status:'unavailable'}` |

**Information discipline:** the readiness body must not expose database URLs, hosts, ports, credentials, pool internals or driver error text. Failure returns a stable opaque reason code (e.g. `DB_UNAVAILABLE`); detail goes to logs only.

**Affected files:** `src/routes/health.routes.js` (new) or `src/app.js`, `src/lib/prisma.js`, `src/config/env.js` (timeout).

**Tests:** ready 200 with DB up; 503 with DB down; liveness unaffected by DB state; no sensitive fields in the body; abandoned-connection behaviour bounded (repeated failing probes do not grow the connection count).

### D3.4 CI

**Problem.** No `.github/` directory; nothing runs the suite on push.

**Required properties**

1. **No production or Neon credentials in any ordinary CI job.** `DATABASE_URL` for generation is a **documented, non-secret placeholder** (e.g. `postgresql://ci:ci@127.0.0.1:5432/ci_placeholder`) used only to satisfy `prisma.config.js` construction. It is never connected to.
2. **All migration and integration checks run against isolated PostgreSQL instances** — a CI service container or `embedded-postgres`, never an external database.
3. Jobs and dependencies are **clearly distinguished**:

| Job | Depends on | Steps |
|---|---|---|
| `validate` | — | checkout, Node (pinned), `npm ci`, `npx prisma validate` |
| `test` | `validate` | `npm run db:generate` (placeholder URL), `npm test` |
| `integration` | `validate` | start isolated PostgreSQL, `npm run db:generate`, `npm run test:integration` |
| `drift` | `validate` | apply migrations to the CI database, `prisma migrate diff` |

4. Test reports uploaded on failure; npm cache enabled.
5. An optional audit step records the 0-vulnerability baseline without introducing upgrades.

**Affected files:** `.github/workflows/ci.yml` (new).

**Verification:** the workflow is proven by a deliberately failing branch before merge.

### D3.5 Migration validation

**Required, against disposable databases only**

1. Apply all migrations to a **clean** database.
2. Re-apply to prove `already-applied` behaviour (the runner already supports this).
3. **Verify migration provider configuration** — assert `migration_lock.toml` declares `provider = "postgresql"`; the runner currently filters to directories and ignores the lock file, so this must be an explicit check.
4. **Compare the resulting database schema with the Prisma datamodel** via `prisma migrate diff`.
5. **Prove that intentional drift causes failure** — a fixture with a deliberate mismatch must exit non-zero (this is what would have caught §0.1).
6. **Never execute against Neon.**

**Affected files:** `scripts/check-migrations.js` (new), `src/lib/migrations.js` (assert provider), CI wiring.

### D3.6 Docker and deployment

**Correction accepted: the previous plan blurred six distinct concerns.** They are separated explicitly, and **no production provider or infrastructure is assumed** — none has been selected.

| # | Concern | Scope in Stage D |
|---|---|---|
| 1 | **Local development Compose** | Extend existing `docker-compose.yml`: PostgreSQL (already present) + optional `api` and `worker` for developer convenience. Local-only defaults; never used for production |
| 2 | **Production API image** | `Dockerfile` (multi-stage: install → prune → runtime, **non-root user**, `NODE_ENV=production`), `.dockerignore` |
| 3 | **Production worker image/service** | Same image, different command (`src/workers/email-outbox.js`); no separate Dockerfile |
| 4 | **Production environment configuration** | Documented required variables and validation; `config/env.js` already refuses insecure cookies and the console mailer in production. **No secrets invented** |
| 5 | **Migration execution** | **A single, controlled step run before application rollout** — see below |
| 6 | **Deployment and rollback** | `DEPLOYMENT.md` runbook: pre-checks → migrate → rollout → verify → rollback |

**Migrations must not race.** The API and worker must **never** each run migrations on startup. Required design:

- Migrations run as a **discrete one-shot job/command** (`node prisma/deploy.js`) executed by the deployment process **before** any application instance starts.
- Application containers perform **no** schema mutation at boot; `server.js` and `email-outbox.js` are unchanged in this respect (they already do not migrate).
- The existing advisory lock in `applyMigrations` (`pg_advisory_lock`) provides defence in depth if two migration jobs are ever launched concurrently, but the operational contract is a single job.
- A failed migration halts rollout.

**Docker requirements:** non-root runtime user; **build secrets excluded** (no `ARG`/`ENV` carrying secrets; `.dockerignore` excludes `.env*`, `*_key.txt`, `*_key`, `secrets/`); healthcheck wired to `/health/ready`; image does not include `node_modules` dev dependencies or test files.

**Explicitly not done:** no assumption about Kubernetes, ECS, Fly, Railway or any other provider; no production secret creation; **no Neon configuration change**.

**Affected files:** `Dockerfile` (new), `.dockerignore` (new), `docker-compose.yml` (local section), `DEPLOYMENT.md` (new), `backend/package.json` (`engines.node`), `backend/README.md`.

### D3.7 D3 acceptance criteria

Liveness and readiness behave distinctly under database failure; the readiness probe is bounded at the *connection* and *statement* level, not by a JavaScript race; repeated failing probes do not accumulate connections; every request log carries a correlation id; malformed inbound ids are replaced; no secret appears in any log; CI requires no production credentials and runs validate/generate/test/integration/drift; migration checks prove a deliberate drift fails; API and worker run as non-root with migrations executed as a single pre-rollout step.

---

## D4 — Industry architecture: **ASSESSMENT ONLY**

> **Scope restriction (revision 2).** The previous revision overstepped by proposing a shared middleware factory, shared validators, an implemented conformance suite and a School refactor. **All of that is removed from Stage D.** D4 in this stage produces documentation and recommendations only.
>
> **Not authorised in Stage D:** implementing any shared abstraction; refactoring School; creating SACCO, Clinic or Rentals modules. Any future shared-abstraction implementation requires **separate architectural approval**.

### D4.1 The problem this assessment addresses

Three of four industries are empty, and the one implemented module has already diverged from the shared platform in four observable ways:

| Divergence | Shared platform | School module |
|---|---|---|
| Audit writes | `recordAudit(tx, …)` helper | Inline `tx.auditLog.create` at **9** sites (`grep -c` verified) |
| Concurrency strategy | Per-organisation `pg_advisory_xact_lock` (`src/lib/tenant-lock.js`) | `isolationLevel: 'Serializable'` per transaction |
| Schema strictness | `.strict()` on write schemas (platform: 2, auth: 5) | **Zero** `.strict()` usage |
| Route gate | `requireTenant` + `requirePermission` | Adds bespoke `requireSchoolModule` |

Copying this shape into three more modules would quadruple the inconsistency. D4 records the recommended destination **without moving toward it in this stage**.

### D4.2 Recommended architecture (documentation only)

| Concern | Recommendation | Rationale |
|---|---|---|
| **Registration and enablement** | A data-driven industry→module map in `src/config/permissions.js` (extending the existing `INDUSTRY_PERMISSION_PREFIX`), replacing one bespoke middleware per module | One registry instead of N middlewares; add an industry by adding an entry |
| **Model placement** | Industry models in `prisma/schema.prisma`, each with `organisationId` and a composite unique `(id, organisationId)` | Preserves the single-database, single-tenant-column model all isolation depends on |
| **Tenant isolation** | Every industry table carries `organisation_id` with a composite FK; every query filters `organisationId` | This is what makes School safe today — the pattern is already proven |
| **Composite FKs** | Prefer composite `(id, organisationId)` references so cross-tenant references are rejected by the database, not only by application code | Turns a class of tenancy bug into a constraint violation |
| **Permissions** | Keep `INDUSTRY_PERMISSION_PREFIX` as the single registry; add `sacco.read`/`clinic.read`/`rentals.read` only when modules exist | `*.manage` keys already exist and are industry-filtered |
| **Route conventions** | Fixed order `authenticate → requireTenant → industry gate → permission → validate` | Makes a missed guard a convention violation rather than a review catch |
| **Service boundaries** | Services accept `(prisma|tx, organisationId, actorUserId, …, requestId)`; never trust an organisation id from the request body | Matches every existing service |
| **Transaction management** | Callers own transactions; services accept a `tx` and do not open their own | Enables composition and atomic provisioning (D2.A) |
| **Audit logging** | Mandate `recordAudit(tx, …)`; forbid inline inserts | Removes the most consequential divergence |
| **Concurrency and locking** | See D4.3 — **no categorical prohibition** | Different tools suit different invariants |
| **Validation** | `.strict()` on all write schemas; a shared date/currency/phone schema module; cross-field rules validated against the merged persisted record (D2.B) | D2.B and D2.C are both validation-drift bugs |
| **Migrations** | One directory per feature, lexical prefix, hand-written SQL reviewed against the datamodel; drift check in CI | Preserves the deterministic ordering already relied on (`002` before `003`/`004`) |
| **Module tests** | A shared conformance expectation per module: industry-gate 404, permission 403, tenant isolation, invalid transition, audit row written | Generalises the D2.E matrix so a new module cannot ship untested |

### D4.3 Concurrency policy — corrected, not categorical

The previous revision implied advisory locks were the standard and School's `Serializable` was a deviation to be removed. **That was too strong and is corrected here.** These are complementary tools:

| Mechanism | Appropriate when | Trade-offs |
|---|---|---|
| **PostgreSQL `SERIALIZABLE`** | Multi-row invariants where no single row is the natural serialization point; correctness matters more than throughput. School's academic-structure transactions are a defensible example | Requires retry-on-`40001` handling in callers; can abort under contention. **Retry handling is a gap worth reviewing** |
| **Advisory locks** (`pg_advisory_xact_lock`) | A small number of invariants keyed on one entity (per-organisation ownership); predictable, low contention, no retries | Must be taken consistently by *every* writer of that invariant, or it protects nothing (as the pre-Stage-C suspension race demonstrated) |
| **Database constraints** (unique, composite FK, CHECK) | Whenever the invariant can be expressed declaratively | Cannot express "at least one active owner"; do not replace application logic |

**Policy recommendation:** choose per invariant and document it per module; never mix two mechanisms for the same invariant without stating which is authoritative; every `SERIALIZABLE` transaction must have a retry path; every advisory lock must be taken by all writers of its invariant. **The `40001` retry gap in the School module is recorded as a technical observation for a future stage, not scheduled here.**

### D4.4 School refactoring strategy (recommendation only, not authorised)

When separately approved, the sequence would be: adopt `recordAudit`, settle the concurrency policy per invariant, add `.strict()` to write schemas, and generalise the gate — each a small, independently revertible change proven by the D2.E tests. **No file moves, no endpoint renames, no rewrite.**

### D4.5 Distinction from Stage D scope

| Item | Stage D | Future stage (separate approval) |
|---|---|---|
| Assess industry architecture | **Yes** | — |
| Implement shared registry/gate/validators | No | Yes |
| Refactor School onto it | No | Yes |
| SACCO / Clinic / Rentals | No | Yes, after specification |

Requirements for SACCO/Clinic/Rentals **do not exist anywhere in the repository**, so specification precedes implementation and belongs to a later stage.

---

## 5. Execution order

```
D1 (schema fix → generate → all 82 tests pass → isolation guard)
 └─> D2.A  profile provisioning + backfill      ─┐
     D2.B  dates incl. merged-record validation  ─┤ (A/C/C2 share school.service.js;
     D2.C  term lifecycle + C2 relation fix      ─┤  B is schemas + service check)
     D2.D  grade-level validation                ─┤
     D2.E  school test suite                     ─┘
      └─> D3 (logging → correlation → health → CI → migration validation → deployment)
           └─> D4 (assessment only — no implementation)
                └─> [separate approval] shared abstraction + School refactor
                     └─> [separate approval] SACCO / Clinic / Rentals
```

**D1 strictly first.** D2 before D3 is **approved** (§7.1). Tests are written alongside each implementation change. Each stage is independently reviewable, and **commits are not combined**: D1, each D2 sub-part, each D3 scope, and D4 are separate commits.

---

## 6. Stage D acceptance criteria

1. `npx prisma validate` and `npm run db:generate` succeed **offline**.
2. **All 82 existing tests pass, 0 fail.** Any residual failure is reported as a real defect, not environmental. D2 adds tests on top; the exact total is fixed at implementation time rather than predicted here.
3. Drift check and migration validation pass in CI, and a deliberate drift fails.
4. The integration-test guard rejects non-loopback and ambient-`DATABASE_URL` targets.
5. A newly registered SCHOOL organisation can use all 14 school endpoints end to end.
6. A term reaches `COMPLETED` and cannot leave it; `PLANNED→COMPLETED` remains excluded.
7. A partial date update producing an end-before-start record is rejected.
8. Dates are accepted as `YYYY-MM-DD` and stored as the same calendar date regardless of server timezone.
9. Invalid or cross-tenant `gradeLevelId` returns `404 GRADE_LEVEL_NOT_FOUND`, never a raw FK error.
10. No secret appears in logs; every request log carries a validated correlation id.
11. `/health/ready` returns 503 when the database is unreachable and 200 when not, without leaking internals and without accumulating abandoned connections.
12. CI runs validate, generate, tests, integration and drift checks with no production credentials.
13. API and worker run as non-root containers; migrations execute as one controlled pre-rollout step.
14. **D4 contains no implementation**, and no SACCO/Clinic/Rentals module exists.

---

## 7. Approval decisions

### 7.1 Decisions recorded

| Decision | Direction |
|---|---|
| Term terminal state | **`COMPLETED`** |
| `PLANNED → COMPLETED` | **Excluded** unless justified and confirmed |
| Existing School profile backfill | **Included** — manual idempotent script with preview/dry-run and audited summary |
| Invalid grade-level reference | **`404 GRADE_LEVEL_NOT_FOUND`** |
| Logging library | **Pino**, subject to dependency review and redaction tests |
| D2 before D3 | **Approved** |
| D4 implementation | **Not authorised** — assessment only |
| Neon changes | **Not authorised** |
| New industry modules | **Not authorised** |
| Prisma version | **`6.19.3` unchanged** |
| `effect@3.22.5` and existing overrides | **Preserved** |

### 7.2 Unresolved decisions — listed, not silently decided

| # | Question | Why it needs a decision | Default if unanswered |
|---|---|---|---|
| **U1** | Is there a legitimate workflow for completing a term that was never `ACTIVE` (e.g. mid-year adoption)? | The review explicitly requires justification before adding `PLANNED→COMPLETED` | Transition **stays excluded**; such terms must be activated then completed, producing two audit events |
| **U2** | Which `SERIALIZABLE` retry strategy should School use for `40001`? | D4.3 identifies the retry gap; without a policy, contended writes fail as 500s | Deferred; recorded as a technical observation |
| **U3** | Should the `updateGradeLevel` write be org-scoped for defence in depth? | Identified hardening observation; not a claimed vulnerability | No change in Stage D |
| **U4** | Exact Pino version and transport/format (JSON only or pretty in dev)? | Approval is conditional on compatibility review | Pin exact version; JSON only |
| **U5** | Is the local development Compose extension in scope, or is only the production image in scope? | D3.6 separates concerns; scope of #1 is ambiguous | Provide the Dockerfile and `.dockerignore`; extend Compose minimally |
| **U6** | Which deployment provider, if any, is targeted? | Affects the runbook's concreteness | **No provider assumed**; runbook stays provider-neutral |

---

## 8. Constraints honoured

- **Documentation-only.** The only repository change is this document.
- **No source, schema, migration, dependency or database change.**
- **No migrations executed.** None of the D2 fixes requires a migration.
- **No Neon configuration or credential change.**
- **Existing commits and branches preserved** — `d1e964d`, `67d8c24`, `6a8967f` all verified intact.
- **No history rewritten**; no force-push.
- **Settled architecture decisions not reopened:** shared modular monolith; single PostgreSQL database with `organisation_id` tenancy; Prisma; the advisory-lock precedent for ownership invariants.

### 8.1 Environment incident during this revision

The sandbox again reset its git refs at session start (`HEAD` reverted to `8393f14` while the worktree retained everything). Recovery was **verified, not assumed**: all three checkpoints were confirmed present, `git diff --cached 6a8967f…` returned **empty**, proving the worktree was byte-identical to the pushed commit, after which `git reset --mixed 6a8967f…` restored the ref. No commit, branch or file was altered. This is the fifth occurrence of the same environmental fault and is recorded so it is not mistaken for repository tampering.
