# NexaCore — Stage C Final Verification and Corrections

**Date:** 2026-11-23
**Branch:** `arena/8c9954b6-nexacore`
**Head:** `4e21686b295e80fe4276164127c24d94ca3e2638`
**Parent:** `3afface71bda1b0ef97dda5ac1f6128d34d155c3`
**Remote:** `origin/arena/8c9954b6-nexacore` at `4e21686` (pushed `3afface..4e21686`)
**Working tree:** clean

This report supersedes the previous Stage C summary. It records only behaviour that was verified in this round; where something could not be verified, it says so and gives the reason.

---

## 1. Corrections made in this round

### 1.1 The ownership lock now fails closed

`lockOrganisationOwnership` previously did a silent `return` when `tx.$executeRaw` was unavailable. That early exit existed only to accommodate test doubles, and in a real process it could only ever mask a defect: the lock would be skipped and the last-owner guard would silently degrade to the racy read-then-write it was written to fix.

It now throws `AppError(500, 'OWNERSHIP_LOCK_UNAVAILABLE', ...)`.

The justification is checkable rather than assumed: `$executeRaw` is declared on the `PrismaClient` base class (`node_modules/@prisma/client/runtime/library.d.ts:199`), so every real client has it. A client that does not have it is broken, and failing loudly is the correct response.

`test/access-service.test.js` was updated to match: three fixtures gained `$executeRaw` stubs, and the old "the lock is optional" test was replaced by a fail-closed regression test that also asserts no membership write occurred. **7/7 pass.**

### 1.2 Duplicate invitations return 409 instead of 500

`organisation_invitations_one_live_email_key` is a partial unique index on `(organisation_id, lower(email))` where the invitation is still live, so a duplicate raises Prisma `P2002`. Nothing mapped it, so it surfaced as a generic `500 INTERNAL_ERROR`.

`createInvitation` now catches `P2002` and raises **`409 INVITATION_ALREADY_EXISTS`**. Non-`P2002` errors are re-thrown untouched, so a real database fault is never disguised as a conflict — there is a test for that specific distinction.

### 1.3 A suspended organisation cannot accept invitations

`acceptInvitation` loaded `invitation.organisation` and then never looked at it. An invitation issued before a suspension remained usable, so a suspended tenant could keep growing its membership.

Acceptance now requires `organisation.status === 'ACTIVE'` and otherwise raises **`403 ORGANISATION_NOT_ELIGIBLE`**. The check runs *before* the transaction opens, so a refused acceptance leaves no user, membership, role, auth token, email, or audit row behind — asserted directly with `assert.deepEqual(prisma.writes, [])`.

Invitation *creation* was already covered upstream: `requireTenant` resolves memberships only where `organisation.status` is `ACTIVE`, so a suspended tenant cannot be reached through that route at all.

### 1.4 Settings hardening (no production change; coverage added)

The settings implementation was re-reviewed adversarially. No defect was found, so production code is unchanged, but the guarantees are now pinned by tests rather than asserted in prose. Coverage added for prototype-pollution keys, inherited-property keys, non-object stored values, caller-state mutation, boundary values, and security-sensitive field names. See §5.

---

## 2. Ownership lock — real-database proof

This was the main open item from the previous round, and it is now closed.

`prisma generate` still cannot run (see §6), so the Prisma **client** is unavailable. However, the lock was exercised through **the real `@prisma/adapter-pg` driver adapter** — the same adapter `createPrismaClient` uses in production — against a real PostgreSQL 17 cluster started by `embedded-postgres`, with all four migrations applied via `applyMigrations`.

### 2.1 The exact SQL

```js
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organisationId}::text, 0))`;
```

Transaction-scoped (`_xact_`), keyed on the organisation, so it is released automatically at `COMMIT`/`ROLLBACK` and two different organisations never contend.

### 2.2 It executes, and it is released

```
(A) pg_advisory_xact_lock through @prisma/adapter-pg (PrismaPg driver adapter)
    advisory locks before        : 0
    executeRaw(lock) returned    : 1 (1 = statement executed)
    advisory locks while open    : 1 (1 = lock held)
    advisory locks after COMMIT  : 0 (0 = released, no permanent serialization)
```

The lock counts were observed from a **second, independent session** querying `pg_locks`, not from the transaction's own connection.

### 2.3 A harness bug worth recording

An earlier version of this probe reported the lock as still held after commit. That was **my harness, not the application**: `PgTransaction.commit()` in `@prisma/adapter-pg` does not issue SQL `COMMIT` — it only releases the pooled connection (`node_modules/@prisma/adapter-pg/dist/index.js:699`):

```js
async commit() { this.cleanup?.(); this.client.release(); }
```

The real `COMMIT` is emitted by Prisma's query-compiler layer above the adapter. Driving the adapter by hand therefore leaves the session `idle in transaction`, holding the lock. Once the probe issued `COMMIT` explicitly — as the engine does — the lock released correctly. This is a limitation of hand-driving the adapter, **not** a defect in the service, and the app is unaffected because it never calls the adapter directly.

### 2.4 Concurrency: suspension, demotion, removal

| Scenario | Result on real PostgreSQL |
|---|---|
| Two owners suspended concurrently, **before** the lock | both committed → **0 owners** (real bug) |
| Two owners suspended concurrently, **with** the lock | 1 suspended, 1 blocked → **1 owner** |
| Two owners **demoted** concurrently, with the lock | 1 `demoted`, 1 `blocked(LAST_OWNER_REQUIRED)` → **1 owner** |
| Concurrent accept of one invitation token (8 racers) | exactly 1 winner, replays rejected |
| Concurrent duplicate invitations (6 case variants) | 1 created, 5 rejected `23505` |

Both `updateMemberStatus` and `setMemberRoles` take the same organisation-scoped lock **before** reading owner state, so suspension and demotion are protected identically.

> **Scope note.** Suspension and demotion are proven end-to-end against real PostgreSQL. **Removal was verified structurally, not by a live race**: `updateMemberStatus` is the single code path for `SUSPENDED` and `REMOVED`, and the lock and guard are taken before the status branch, so removal inherits exactly the suspension result. I am not claiming a separate removal race was executed.

---

## 3. Invitation lifecycle

| Property | Status | Evidence |
|---|---|---|
| Creation returns id, email, expiry, role | Verified | service + route tests |
| Email normalisation before persistence | Verified | `'  MiXeD@Example.TEST '` stored as `mixed@example.test` |
| Expiry bound to 72 h | Verified | `INVITATION_TTL_MS` |
| Single use under concurrency | Verified on Postgres | 8 racers → 1 winner |
| Replay after acceptance rejected | Verified | conditional `updateMany`, count-guarded |
| Duplicate live invitation → 409 | **Fixed + tested** | `P2002` → `INVITATION_ALREADY_EXISTS` |
| Suspended organisation → refusal | **Fixed + tested** | `403 ORGANISATION_NOT_ELIGIBLE`, zero writes |
| Organisation boundary | Verified | revoke scoped by `organisationId`; tenant guard resolves membership |
| Role boundary | Verified | `ROLE_PERMISSION_ESCALATION` when assigning permissions the inviter lacks |

Error contract, each code checked against source:

| Condition | Status | `error.code` |
|---|---|---|
| Duplicate live invitation (`P2002`) | 409 | `INVITATION_ALREADY_EXISTS` |
| Expired / accepted / revoked | 400 | `INVALID_INVITATION` |
| Email mismatch | 400 | `INVITATION_EMAIL_MISMATCH` |
| Suspended / ineligible organisation | 403 | `ORGANISATION_NOT_ELIGIBLE` |
| Email already registered | 409 | `INVITATION_REQUIRES_UNREGISTERED_EMAIL` |
| Role not in organisation | 404 | `ROLE_NOT_FOUND` |
| Role permission escalation | 403 | `ROLE_PERMISSION_ESCALATION` |

---

## 4. Settings security

| Requirement | Result |
|---|---|
| Explicit allowlisting | 7 keys in a frozen table; anything else → `SETTINGS_KEY_NOT_ALLOWED` |
| Per-setting type validation | string / integer / boolean enforced |
| Format validation | regex per key (locale, IANA timezone, ISO-4217, date format, hex colour) |
| Range validation | `academicYearStartMonth` 1–12 inclusive; strings ≤ 200 chars |
| Unknown-key rejection | rejected, **including alongside a valid key** (no smuggling) |
| Safe merging | merge-not-replace; omitted keys preserved |
| Null clears | `{ key: null }` deletes the key |
| Security-sensitive fields unreachable | `status`, `industry`, `slug`, `id`, `createdAt`, `plan`, `isPlatformAdmin` all rejected |
| Organisation isolation | cross-tenant PATCH → `404 ORGANISATION_NOT_FOUND`, zero writes |
| Authorisation | no `organisation.update` → `403 FORBIDDEN`, zero writes |
| Writes only permitted fields | asserted `Object.keys(update.data) === ['settings']` |

Additionally verified: `__proto__`, `constructor`, and `toString` are rejected via `hasOwnProperty` and never reach `Object.prototype`; non-object stored values are discarded rather than spread; `mergeSettings` never mutates its input.

**19/19 settings tests pass.**

---

## 5. Secret investigation — `backend/.env_key.txt`

**The file never entered this repository's history, locally or remotely.**

- Tracked files: the only environment file ever committed is `backend/.env.example`. No `*_key*` or `secrets/` path is tracked.
- Local history: `.env_key.txt` was never added on any local ref; a full-tree listing of every commit and a scan of every blob's contents found no reference.
- Remote history: all five remote branches (`main`, `feature/nexacore-platform-foundation`, `feature/nexacore-shared-platform-hardening`, `arena/8c9954b6-nexacore`, `arena/cb50e821-nexacore`) were fetched and scanned identically. Nothing. No tags exist.
- Ignore rules: `*_key.txt`, `*_key`, `secrets/` are present; `git check-ignore` matches all of them, and `git add -A --dry-run` stages no secret file.

**Rotation status:** not required by exposure through this repository — there is nothing to purge. It would still be prudent if the same key value was ever shared outside the repo (chat, email, a shared environment); the repository cannot answer that question.

**On `.gitignore`:** adding ignore rules does not resolve a historical exposure, and no such claim is made here. The assurance comes from the history scan above. No secret value is reproduced in this report.

---

## 6. Tests — actual results

```sh
cd backend
npm ci
npm test
```

**`74 tests, 68 pass, 6 fail, 0 skipped`**

All 6 failures are in `test/integration/postgres.integration.test.js`, and all fail with the same message:

```
'@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.'
```

Failing tests:

1. `real PostgreSQL supports authentication and immediate token-version revocation`
2. `real PostgreSQL enforces tenant membership and organisation-role permission checks`
3. `real PostgreSQL composite constraints prevent cross-tenant role assignment and duplicate identity`
4. `real PostgreSQL invitations are encrypted, tenant-bound, expiring, and single-use`
5. `organisation administrators do not receive platform-superadmin access`
6. `platform grants are separate, scoped, and cannot be escalated`

**These are environment-blocked and are not reported as passing.**

**Cause, established this round:** `prisma generate` unconditionally fetches a native schema engine from `binaries.prisma.sh`. That host is TLS-unreachable from this sandbox — the failure is on `schema-engine.gz.sha256`. Removing `prisma.config.js` made no difference, so the config is not implicated.

Attempted and exhausted: `--no-engine`; the `queryCompiler` preview feature; `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`; `PRISMA_CLI_QUERY_ENGINE_TYPE=wasm`; `PRISMA_SCHEMA_ENGINE_BINARY=/dev/null`. No `@prisma/query-engine-*` binary package is published to npm for this version (all E404); only `@prisma/engines@7.10.1` exists, which is the wrong version. There is no offline substitute.

**On mocked transactions:** the unit tests use doubles and are retained, but they are not offered as proof of concurrency safety. The concurrency claims in §2 rest on real PostgreSQL.

**Dependency decisions preserved:** `effect@3.22.5`, `supertest ^7.1.4`, overrides `deepmerge-ts ^8.0.2`; `npm audit` reports 0 vulnerabilities.

---

## 7. Git status

| Item | Value |
|---|---|
| Branch | `arena/8c9954b6-nexacore` |
| Stage C head | `4e21686b295e80fe4276164127c24d94ca3e2638` |
| Parent | `3afface71bda1b0ef97dda5ac1f6128d34d155c3` |
| Remote tip | `4e21686b295e80fe4276164127c24d94ca3e2638` (matches) |
| Push | `3afface..4e21686` → `origin/arena/8c9954b6-nexacore` |
| Working tree | clean |

Commit chain: `8393f14` → `5926380` → `3afface` → `4e21686`.

Files changed in `4e21686` (7 files, +553 / −13):

```
README.md                                              |  32 ++-
backend/README.md                                      |  19 +-
backend/src/modules/organisations/access.service.js    |  20 +-
backend/src/modules/organisations/invitation.service.js|  17 +-
backend/test/access-service.test.js                    |  20 +-
backend/test/invitation-lifecycle.test.js              | 227 ++++++++++
backend/test/organisation-settings.test.js             | 231 +++++++++++++
```

No unrelated work was reset, overwritten, or discarded, and no migration files were modified in this round.

---

## 8. Documentation

- **Root `README.md`** — updated: 74/68/6 evidence, invitation error contract, demotion and lock-release evidence, the secret investigation, and a documentation-status section.
- **`backend/README.md`** — updated: fail-closed lock, `P2002` mapping, suspended-organisation refusal, settings adversarial guarantees, and a rewritten Tests section naming the exact failure message and cause.
- **Frontend README** — **not written, deliberately.** There is no `frontend/` directory in this repository; the project is backend-only at this commit. Writing a frontend README would mean documenting a frontend that does not exist, so the remaining frontend documentation work is recorded as entirely ahead of the implementation: when the React/Vite client is added it will need setup, environment variables, API base URL, auth/cookie flow, and invitation/signup screens.

Only verified behaviour is documented. Where something is unverified, the READMEs say so.

---

## 9. Remaining blockers and open items

1. **Prisma client generation** — blocked on `binaries.prisma.sh` being unreachable. This, and only this, is what the 6 failing tests are waiting on. Close it with `npm run db:generate && npm test` on a networked machine; no code change should be needed.
2. **Removal race** — verified by structural identity with suspension, not by an independent live race (§2.4). Running the integration suite once generate succeeds would make this explicit.
3. **Key rotation** — no rotation forced by repository exposure; decide separately whether the same value was shared elsewhere.

No further NexaCore phase work has been started, pending review of this verification.
