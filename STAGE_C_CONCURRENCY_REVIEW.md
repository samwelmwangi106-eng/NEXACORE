# NexaCore — Final Stage C Concurrency Review

**Date:** 2026-11-23
**Branch:** `arena/8c9954b6-nexacore`
**Base for this round:** `c15dc9ee737bab538e94d7318246906b55fdeab1`
**Status:** three technical matters addressed; awaiting review. No further phase started.

This document covers only what this round changed and proved. Earlier Stage C material remains in `STAGE_C_FINAL_VERIFICATION.md`.

---

## 1. Invitation acceptance versus organisation suspension

### The reported race was real

The previous round checked organisation status **before** opening the acceptance transaction and relied on that check. That is a textbook check-then-act window, and it was reproduced with unmodified production code before any fix was written:

```
suspension committed          : true
acceptance outcome            : ACCEPTED (created membership)
organisation status           : SUSPENDED
members created               : 1
INVARIANT VIOLATED (suspended org gained membership): true
```

The inspectable cause was asymmetric locking. `changeOrganisationStatus` took no explicit lock at all, and acceptance did not take one either, so nothing ordered the two transactions.

### The fix

Both sides now take **the same per-organisation advisory lock**, inside their own transaction:

- `acceptInvitation` calls `lockOrganisation(tx, invitation.organisationId)` as the first statement in its transaction, then **re-reads** `organisation.status` under that lock and refuses with `403 ORGANISATION_NOT_ELIGIBLE` if it is not `ACTIVE`.
- `changeOrganisationStatus` calls `lockOrganisation(tx, organisationId)` as its first statement, before reading and writing the status.

Whichever transaction acquires the lock first commits first; the second observes the committed state. The pre-transaction status check is retained but demoted to a fast path that avoids opening a transaction, and is documented as **not** the guarantee.

### No new abstractions

The lock function was extracted from `access.service.js` into `src/lib/tenant-lock.js` so all three call sites share one implementation. `lockOrganisationOwnership` is kept as a thin wrapper that maps the failure to the ownership-specific error code, so the existing unit-test contract is unchanged. This is reuse of the existing advisory-lock mechanism, not a new concurrency model.

### Verified interleaving

`suspension racing acceptance: the lock serialises them and acceptance is refused` forces the ordering deterministically: the suspension acquires the lock and stalls inside its transaction; acceptance then starts, reads `ACTIVE` in its pre-check, and **blocks on the advisory lock** rather than proceeding. While the lock is still held, the test asserts the organisation is still `ACTIVE` on disk and that no membership exists — i.e. acceptance is blocked, not merely slow. When released, suspension commits and acceptance is refused.

```
ok 1 - suspension racing acceptance: the lock serialises them and acceptance is refused
ok 2 - suspension that commits first wins: acceptance fast-path refuses without opening a transaction
ok 3 - control: without the lock the same interleaving does let a suspended organisation gain membership
```

Test 3 is a deliberate control: with the lock disabled the same interleaving reproduces the original bug, which proves the tests detect the regression rather than passing vacuously.

---

## 2. Ownership locking verification — precise scope

The request asked for an exact distinction between three things. They are **not** the same, and only two of them were exercised.

### (a) Direct adapter-level SQL verification — EXERCISED

The exact statement the service issues

```js
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organisationId}::text, 0))`;
```

was executed through the real `@prisma/adapter-pg` (`PrismaPg`) against real PostgreSQL 17. A **second, independent session** observed `pg_locks`:

```
advisory locks before        : 0
executeRaw(lock) returned    : 1
advisory locks while open    : 1
advisory locks after COMMIT  : 0
```

This proves the SQL is valid, that it actually takes a lock, and that it is transaction-scoped and released at commit.

### (b) The actual application service path — EXERCISED

`test/concurrency-postgres.test.js` imports and calls the **real, unmodified** service functions:

- `invitation.service.acceptInvitation`
- `platform-admin.service.changeOrganisationStatus`
- `access.service.updateMemberStatus`

Assertions are made against a real database: membership counts, organisation status, active-owner counts, and error codes. The `pg_advisory_xact_lock` call inside those services is the production code path, and the tests prove acceptance blocks on it (test 1) and that its absence causes the exact bug it exists to prevent (test 3, and §3).

**Lock acquisition failure prevents the write** — confirmed on the real database, not just with doubles:

- `a client that cannot take the tenant lock performs no write` → `500 OWNERSHIP_LOCK_UNAVAILABLE`, membership stays `ACTIVE`, owner count stays 2.
- `invitation acceptance also fails closed when the lock cannot be taken` → `500 TENANT_LOCK_UNAVAILABLE`, zero memberships created.

### (c) The Prisma Client generated runtime path — NOT EXERCISED

`prisma generate` remains blocked: the CLI unconditionally fetches a native schema engine from `binaries.prisma.sh`, which is TLS-unreachable here. `--no-engine`, the `queryCompiler` preview feature, and `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING` / `PRISMA_CLI_QUERY_ENGINE_TYPE` / `PRISMA_SCHEMA_ENGINE_BINARY` were all tried; removing `prisma.config.js` changed nothing; no `@prisma/query-engine-*` package exists on npm for this version.

Consequently the generated Prisma Client runtime is **not** exercised by any test in this round. The concurrency tests use a shim that implements only the Prisma Client methods those services call and delegates every query to the real driver adapter. **I do not claim Prisma Client itself was exercised.**

| Layer | Real or shimmed |
|---|---|
| Service logic under test | **Real**, unmodified |
| PostgreSQL 17 database | **Real** |
| Transactions, isolation, rollback | **Real** |
| `pg_advisory_xact_lock` behaviour | **Real** |
| Every SQL statement issued | **Real** |
| `@prisma/adapter-pg` driver adapter | **Real** |
| Prisma Client generated runtime (query compiler, method dispatch) | **Shimmed** |

The residual risk is confined to Prisma's own argument marshalling. Closing it requires one run of `npm run db:generate && npm test` on a networked machine; no code change is expected to be needed.

---

## 3. Owner removal concurrency

Previously this was justified by structural similarity to suspension. That is no longer the basis.

`suspension racing` and `removal racing` are now **both** exercised through the real `updateMemberStatus` path, and the invariant was measured directly rather than argued:

```
WITHOUT lock -> ["removed","removed"] | active owners: 0
WITH lock    -> ["removed",{"err":"LAST_OWNER_REQUIRED"}] | active owners: 1
```

Both runs are the same forced interleaving — each transaction reads "another owner exists" before either writes. The only difference is the advisory lock. Without it the read-then-write race produces an organisation with **zero active owners**; with it, exactly one removal commits, the other is refused with `409 LAST_OWNER_REQUIRED`, and one active owner remains.

Tests covering it:

```
ok 4 - owner removal racing owner removal cannot leave zero active owners
ok 5 - owner removal race: the invariant is decided by the lock, proven by a no-lock control
ok 6 - owner removal is refused when it is the only owner
```

Test 5 contains the no-lock control inline and asserts `active owners === 0` for the unprotected case, so the test fails if the guarantee is ever removed.

---

## 4. Evidence

### Files changed in this round

| File | Change |
|---|---|
| `backend/src/lib/tenant-lock.js` | **New.** Shared `lockOrganisation`, fails closed with `TENANT_LOCK_UNAVAILABLE` |
| `backend/src/modules/organisations/access.service.js` | Delegates to the shared lock; keeps `OWNERSHIP_LOCK_UNAVAILABLE` wrapper and export |
| `backend/src/modules/organisations/invitation.service.js` | Takes the lock in-transaction and re-reads status before writing |
| `backend/src/modules/platform/platform-admin.service.js` | `changeOrganisationStatus` takes the same lock before reading/writing status |
| `backend/test/concurrency-postgres.test.js` | **New.** 8 real-PostgreSQL concurrency tests |
| `backend/test-support/real-pg-harness.js` | **New.** Real-DB harness with deterministic lock gates and controls (outside `test/` so it is not collected as a test) |
| `backend/README.md` | Corrected guarantees; new "what the concurrency tests exercise" section |
| `README.md` | Corrected guarantees, totals, and a scope-of-evidence note |
| `STAGE_C_CONCURRENCY_REVIEW.md` | **New.** This document |

### New concurrency tests and results

`node --test test/concurrency-postgres.test.js` → **8 tests, 8 pass, 0 fail**

```
ok 1 - suspension racing acceptance: the lock serialises them and acceptance is refused
ok 2 - suspension that commits first wins: acceptance fast-path refuses without opening a transaction
ok 3 - control: without the lock the same interleaving does let a suspended organisation gain membership
ok 4 - owner removal racing owner removal cannot leave zero active owners
ok 5 - owner removal race: the invariant is decided by the lock, proven by a no-lock control
ok 6 - owner removal is refused when it is the only owner
ok 7 - a client that cannot take the tenant lock performs no write
ok 8 - invitation acceptance also fails closed when the lock cannot be taken
```

**Mutation checks performed during development** (the fix was temporarily removed and the tests re-run):

- Tenant lock removed from both acceptance and suspension → tests 1 and 7 fail.
- Ownership lock disabled via a temporary env-var mutant → the no-lock control measures 0 active owners, and the guarded path cannot reach its gate.

Both mutants were reverted; the final suite was re-run green afterwards. No mutant code remains.

### Full suite

`node --test` → **82 tests, 76 pass, 6 fail, 0 skipped**

Reconciles exactly: **74 previous + 8 new = 82**, and **68 previous passes + 8 new passes = 76**, with the same 6 failures. No previously passing test regressed.

> A counting error was caught and corrected here. An earlier run reported 83 because `node --test` discovers *every* file under `test/`, so the helper at `test/helpers/real-pg-harness.js` was itself collected and counted as a passing test (`ok 6 - test/helpers/real-pg-harness.js`). The helper now lives in `test-support/`, outside the discovery path, and the totals reconcile.

The 6 failures are unchanged and remain **environment-blocked**:

```
'@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.'
```

They are the `test/integration/postgres.integration.test.js` suite, blocked solely by engine generation. They are not reported as passing and are not evidence of a defect.

### Git

| Item | Value |
|---|---|
| Branch | `arena/8c9954b6-nexacore` |
| Commit | `a4eaa94bbf02785cacfda2ce8c7810ff06e82051` |
| Parent commit | `c15dc9ee737bab538e94d7318246906b55fdeab1` |
| Remote tip | `a4eaa94bbf02785cacfda2ce8c7810ff06e82051` (matches local) |
| Push | `c15dc9e..a4eaa94` → `origin/arena/8c9954b6-nexacore` |
| Working tree | clean |

Files in `a4eaa94` (9 files, +1096 / −23):

```
README.md                                          |   7 +-
STAGE_C_CONCURRENCY_REVIEW.md                      | 206 ++++++++++
backend/README.md                                  |  15 +-
backend/src/lib/tenant-lock.js                     |  31 ++
backend/src/modules/organisations/access.service.js|  31 +-
backend/src/modules/organisations/invitation.service.js | 21 +-
backend/src/modules/platform/platform-admin.service.js  |  6 +
backend/test-support/real-pg-harness.js            | 375 ++++++++++
backend/test/concurrency-postgres.test.js          | 427 +++++++++++
```

Commit chain: `8393f14` → `5926380` → `3afface` → `4e21686` → `c15dc9e` → `a4eaa94`.

---

## 5. One incident worth recording

During this round the sandbox reset its git refs: `HEAD` reverted to the original base `8393f14` while the working tree kept every edit. This is a known failure mode of this environment. Recovery was non-destructive — `git fetch` confirmed `c15dc9e` was intact on origin, and `git reset --mixed c15dc9e` restored `HEAD` without touching the working tree, so no work was lost and no unrelated commit was rewritten. The three modified service files were re-verified byte-for-byte against their intended content before proceeding.
