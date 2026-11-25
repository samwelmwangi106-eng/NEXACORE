/**
 * Real-PostgreSQL concurrency tests.
 *
 * These are NOT mocked. They start an isolated PostgreSQL 17 cluster, apply every
 * migration, and call the real service functions. Only the ORM surface is shimmed,
 * because `prisma generate` is environment-blocked (see README). Interleavings are
 * forced deterministically with a lock-acquisition gate, not with sleeps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startPostgres, createHandle, createGate, outboxEncryptionKey } = require('../test-support/real-pg-harness');
const invitationService = require('../src/modules/organisations/invitation.service');
const platformAdmin = require('../src/modules/platform/platform-admin.service');
const access = require('../src/modules/organisations/access.service');
const { hashRefreshSecret } = require('../src/lib/security');

const ORG = '11111111-1111-4111-8111-111111111111';
const ROLE_STAFF = '22222222-2222-4222-8222-222222222222';
const ROLE_OWNER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const OWNER_A_USER = '55555555-5555-4555-8555-555555555555';
const OWNER_B_USER = '66666666-6666-4666-8666-666666666666';
const OWNER_A_MEMBER = '77777777-7777-4777-8777-777777777777';
const OWNER_B_MEMBER = '88888888-8888-4888-8888-888888888888';

const INVITEE_EMAIL = 'invitee@race.test';

let cluster;
let connectionString;
let setup;

test.before(async function startCluster() {
  const started = await startPostgres();
  cluster = started.pg;
  connectionString = started.connectionString;
  setup = started.setup;
});

test.after(async function stopCluster() {
  if (setup) await setup.end();
  if (cluster) await cluster.stop();
});

async function resetTenant(organisationStatus) {
  await setup.query('DELETE FROM audit_logs');
  await setup.query('DELETE FROM member_roles');
  await setup.query('DELETE FROM organisation_invitations');
  await setup.query('DELETE FROM organisation_members');
  await setup.query('DELETE FROM auth_tokens');
  await setup.query('DELETE FROM email_outbox');
  await setup.query('DELETE FROM users WHERE id <> $1', [ADMIN]);
  await setup.query('DELETE FROM roles');
  await setup.query('DELETE FROM organisations');

  await setup.query(
    "INSERT INTO organisations (id,name,slug,industry,status,settings,created_at,updated_at) VALUES ($1,'Race Org','race-org','SCHOOL',$2,'{}'::jsonb,now(),now())",
    [ORG, organisationStatus || 'ACTIVE'],
  );
  await setup.query(
    "INSERT INTO roles (id,organisation_id,name,is_system_role,created_at) VALUES ($1,$2,'Staff Member',true,now()),($3,$2,'Organisation Owner',true,now())",
    [ROLE_STAFF, ORG, ROLE_OWNER],
  );
  await setup.query(
    "INSERT INTO users (id,email,password_hash,first_name,last_name,status,email_verified_at,created_at,updated_at) " +
    "VALUES ($1,'admin@race.test','x','A','D','ACTIVE',now(),now(),now()) ON CONFLICT (id) DO NOTHING",
    [ADMIN],
  );
}

async function seedInvitation() {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  await setup.query(
    'INSERT INTO organisation_invitations (id,organisation_id,role_id,invited_by_id,email,token_hash,expires_at,created_at) ' +
    "VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now() + interval '1 hour',now())",
    [ORG, ROLE_STAFF, ADMIN, INVITEE_EMAIL, hashRefreshSecret(rawToken)],
  );
  return rawToken;
}

async function seedTwoOwners() {
  for (const pair of [[OWNER_A_USER, OWNER_A_MEMBER], [OWNER_B_USER, OWNER_B_MEMBER]]) {
    await setup.query(
      "INSERT INTO users (id,email,password_hash,first_name,last_name,status,email_verified_at,created_at,updated_at) " +
      "VALUES ($1,$2,'x','O','W','ACTIVE',now(),now(),now())",
      [pair[0], pair[1] + '@race.test'],
    );
    await setup.query(
      "INSERT INTO organisation_members (id,organisation_id,user_id,status,joined_at) VALUES ($1,$2,$3,'ACTIVE',now())",
      [pair[1], ORG, pair[0]],
    );
    await setup.query(
      'INSERT INTO member_roles (organisation_id,member_id,role_id) VALUES ($1,$2,$3)',
      [ORG, pair[1], ROLE_OWNER],
    );
  }
}

function config() {
  return { webOrigin: 'http://localhost:5173', outboxEncryptionKey: outboxEncryptionKey() };
}

const REGISTRATION = { email: INVITEE_EMAIL, passwordHash: 'hashed-password', firstName: 'In', lastName: 'Vitee' };

async function countMembers() {
  const rows = await setup.query('SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id=$1', [ORG]);
  return rows.rows[0].n;
}

async function organisationStatus() {
  const rows = await setup.query('SELECT status FROM organisations WHERE id=$1', [ORG]);
  return rows.rows[0].status;
}

async function activeOwners() {
  const rows = await setup.query(
    'SELECT count(*)::int AS n FROM member_roles mr ' +
    'JOIN organisation_members m ON m.id = mr.member_id AND m.organisation_id = mr.organisation_id ' +
    "JOIN roles r ON r.id = mr.role_id AND r.organisation_id = mr.organisation_id " +
    "WHERE mr.organisation_id = $1 AND r.name = 'Organisation Owner' AND m.status = 'ACTIVE'",
    [ORG],
  );
  return rows.rows[0].n;
}

// ---------------------------------------------------------------------------
// 1. Invitation acceptance racing organisation suspension
// ---------------------------------------------------------------------------

test('suspension racing acceptance: the lock serialises them and acceptance is refused', async function acceptanceLoses() {
  await resetTenant('ACTIVE');
  const token = await seedInvitation();
  const gate = createGate();

  // Suspension takes the tenant lock first and stalls inside its transaction.
  const suspendHandle = createHandle(connectionString, {
    onAfterLock: async function stallSuspension() {
      gate.arrive();
      await gate.wait();
    },
  });
  const suspender = await suspendHandle.connect();
  const suspension = platformAdmin.changeOrganisationStatus(suspender, ADMIN, ORG, 'SUSPENDED', 'req-suspend')
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await gate.arrivedWithin();

  // Acceptance starts while the suspension holds the lock. It must block on the
  // advisory lock, not proceed on the stale ACTIVE snapshot it read before it.
  const acceptorHandle = createHandle(connectionString);
  const acceptor = await acceptorHandle.connect();
  const acceptance = invitationService.acceptInvitation(acceptor, config(), token, REGISTRATION)
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  // Prove the lock is doing the work: the organisation is still ACTIVE on disk
  // (suspension uncommitted) yet acceptance cannot get in.
  await new Promise(function tick(r) { setTimeout(r, 250); });
  assert.equal(await organisationStatus(), 'ACTIVE', 'suspension has not committed yet');
  assert.equal(await countMembers(), 0, 'acceptance must be blocked on the lock, not have written');

  gate.release();
  const suspended = await suspension;
  const accepted = await acceptance;

  assert.equal(suspended.ok, true, 'suspension commits once it wins the lock');
  assert.equal(suspended.value.status, 'SUSPENDED');
  assert.equal(accepted.ok, false, 'acceptance must be refused, not committed');
  assert.equal(accepted.error.status, 403);
  assert.equal(accepted.error.code, 'ORGANISATION_NOT_ELIGIBLE');
  assert.equal(await organisationStatus(), 'SUSPENDED');
  assert.equal(await countMembers(), 0, 'a suspended organisation must not gain membership');

  await suspendHandle.close();
  await acceptorHandle.close();
});

test('suspension that commits first wins: acceptance fast-path refuses without opening a transaction', async function suspensionWins() {
  await resetTenant('ACTIVE');
  const token = await seedInvitation();

  const suspendHandle = createHandle(connectionString);
  const suspender = await suspendHandle.connect();
  await platformAdmin.changeOrganisationStatus(suspender, ADMIN, ORG, 'SUSPENDED', 'req-suspend-2');
  await suspendHandle.close();

  const acceptorHandle = createHandle(connectionString);
  const acceptor = await acceptorHandle.connect();
  const result = await invitationService.acceptInvitation(acceptor, config(), token, REGISTRATION)
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ORGANISATION_NOT_ELIGIBLE');
  assert.equal(await countMembers(), 0);
  await acceptorHandle.close();
});

test('control: without the lock the same interleaving does let a suspended organisation gain membership', async function controlShowsTheBug() {
  await resetTenant('ACTIVE');
  const token = await seedInvitation();
  const gate = createGate();

  // This handle deliberately does NOT take the advisory lock (control only).
  const acceptorHandle = createHandle(connectionString, {
    disableTenantLock: true,
    onAfterLock: async function neverCalled() { gate.arrive(); },
  });
  const acceptor = await acceptorHandle.connect();
  const acceptance = invitationService.acceptInvitation(acceptor, config(), token, REGISTRATION)
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await new Promise(function tick(r) { setTimeout(r, 150); });

  const suspendHandle = createHandle(connectionString);
  const suspender = await suspendHandle.connect();
  await platformAdmin.changeOrganisationStatus(suspender, ADMIN, ORG, 'SUSPENDED', 'req-suspend-3');
  gate.release();

  const accepted = await acceptance;
  assert.equal(await organisationStatus(), 'SUSPENDED');
  assert.equal(accepted.ok, true, 'control: acceptance succeeds despite the suspension');
  assert.equal(await countMembers(), 1, 'control: the suspended organisation gained a member (the bug the lock prevents)');

  await acceptorHandle.close();
  await suspendHandle.close();
});

// ---------------------------------------------------------------------------
// 2. Owner removal racing another owner removal
// ---------------------------------------------------------------------------

test('owner removal racing owner removal cannot leave zero active owners', async function removalRace() {
  await resetTenant('ACTIVE');
  await seedTwoOwners();
  const gateA = createGate();
  const gateB = createGate();

  // Both removals are stalled at the last-owner guard: A by holding the lock,
  // B by having already read "another owner exists" and not yet written.
  const handleA = createHandle(connectionString, {
    onAfterLock: async function stallA() {
      gateA.arrive();
      await gateA.wait();
    },
  });
  const prismaA = await handleA.connect();
  const removalA = access.updateMemberStatus(prismaA, OWNER_A_USER, ORG, OWNER_A_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-a')
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await gateA.arrivedWithin();

  // B is honest: it takes the lock. It must therefore block and never reach its guard.
  const handleB = createHandle(connectionString);
  const prismaB = await handleB.connect();
  const removalB = access.updateMemberStatus(prismaB, OWNER_B_USER, ORG, OWNER_B_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-b')
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await new Promise(function tick(r) { setTimeout(r, 250); });
  gateA.release();

  const results = await Promise.all([removalA, removalB]);
  await gateB.release();

  assert.equal(results.filter(function isOk(r) { return r.ok; }).length, 1, 'exactly one removal commits');
  const blocked = results.filter(function isBlocked(r) { return !r.ok; });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].error.code, 'LAST_OWNER_REQUIRED');
  assert.equal(await activeOwners(), 1, 'the organisation must retain an active owner');

  await handleA.close();
  await handleB.close();
});

test('owner removal race: the invariant is decided by the lock, proven by a no-lock control', async function removalRaceProven() {
  await resetTenant('ACTIVE');
  await seedTwoOwners();
  const gate = createGate();

  // CONTROL (no advisory lock): hand-drive the real last-owner guard so both
  // transactions read "another owner exists" before either writes. This is exactly
  // the window the lock exists to close, and it must produce zero owners.
  async function demoteWithoutLock(memberId) {
    const handle = createHandle(connectionString, { disableTenantLock: true });
    const prisma = await handle.connect();
    const tx = prisma.$transaction(async function work(txClient) {
      const memberships = await txClient.organisationMember.findFirst({ where: { id: memberId, organisationId: ORG } });
      const others = await txClient.memberRole.count({
        where: {
          organisationId: ORG,
          memberId: { not: memberId },
          role: { name: 'Organisation Owner' },
          member: { status: 'ACTIVE' },
        },
      });
      if (!memberships.assignments.some(function isOwner(a) { return a.role.name === 'Organisation Owner'; }) || others === 0) {
        throw Object.assign(new Error('LAST_OWNER_REQUIRED'), { code: 'LAST_OWNER_REQUIRED' });
      }
      await new Promise(function tick(r) { setTimeout(r, 120); });
      await txClient.organisationMember.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
      return 'removed';
    });
    try {
      return await tx;
    } finally {
      await handle.close();
    }
  }

  const controlResults = await Promise.allSettled([
    demoteWithoutLock(OWNER_A_MEMBER),
    demoteWithoutLock(OWNER_B_MEMBER),
  ]);
  const controlRemoved = controlResults.filter(function ok(r) { return r.status === 'fulfilled'; }).length;
  assert.equal(controlRemoved, 2, 'control: without the lock both removals commit');
  assert.equal(await activeOwners(), 0, 'control: the organisation is left with zero active owners (the bug)');

  // Now the real service path, with the lock in place, on a fresh tenant.
  await resetTenant('ACTIVE');
  await seedTwoOwners();

  const handleA = createHandle(connectionString, {
    onAfterLock: async function stallA() {
      gate.arrive();
      await gate.wait();
    },
  });
  const prismaA = await handleA.connect();
  const removalA = access.updateMemberStatus(prismaA, OWNER_A_USER, ORG, OWNER_A_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-a')
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await gate.arrivedWithin();

  const handleB = createHandle(connectionString);
  const prismaB = await handleB.connect();
  const removalB = access.updateMemberStatus(prismaB, OWNER_B_USER, ORG, OWNER_B_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-b')
    .then(function ok(v) { return { ok: true, value: v }; })
    .catch(function failed(e) { return { ok: false, error: e }; });

  await new Promise(function tick(r) { setTimeout(r, 250); });
  gate.release();

  const results = await Promise.all([removalA, removalB]);
  await gate.release();

  assert.equal(results.filter(function isOk(r) { return r.ok; }).length, 1, 'exactly one removal commits');
  const blocked = results.filter(function isBlocked(r) { return !r.ok; });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].error.code, 'LAST_OWNER_REQUIRED');
  assert.equal(await activeOwners(), 1, 'with the lock, one active owner always remains');

  await handleA.close();
  await handleB.close();
});

test('owner removal is refused when it is the only owner', async function singleOwnerRemoval() {
  await resetTenant('ACTIVE');
  await seedTwoOwners();
  // Remove OWNER B first, leaving OWNER A alone.
  const first = createHandle(connectionString);
  const p1 = await first.connect();
  await access.updateMemberStatus(p1, OWNER_A_USER, ORG, OWNER_B_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-1');
  await first.close();

  const second = createHandle(connectionString);
  const p2 = await second.connect();
  await assert.rejects(
    function run() { return access.updateMemberStatus(p2, OWNER_A_USER, ORG, OWNER_A_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-2'); },
    function verify(error) {
      assert.equal(error.code, 'LAST_OWNER_REQUIRED');
      return true;
    },
  );
  assert.equal(await activeOwners(), 1);
  await second.close();
});

// ---------------------------------------------------------------------------
// 3. Lock acquisition failure prevents the write (fail-closed)
// ---------------------------------------------------------------------------

test('a client that cannot take the tenant lock performs no write', async function failClosedOnRealDb() {
  await resetTenant('ACTIVE');
  await seedTwoOwners();

  // Same real database, but the lock primitive is absent, as with a broken client.
  const handle = createHandle(connectionString, { stripLockMethod: true });
  const prisma = await handle.connect();

  await assert.rejects(
    function run() { return access.updateMemberStatus(prisma, OWNER_A_USER, ORG, OWNER_B_MEMBER, 'REMOVED', new Set(['Organisation Owner']), 'req-x'); },
    function verify(error) {
      assert.equal(error.status, 500);
      assert.equal(error.code, 'OWNERSHIP_LOCK_UNAVAILABLE');
      return true;
    },
  );

  const rows = await setup.query("SELECT status FROM organisation_members WHERE id=$1", [OWNER_B_MEMBER]);
  assert.equal(rows.rows[0].status, 'ACTIVE', 'the membership must be untouched');
  assert.equal(await activeOwners(), 2);
  await handle.close();
});

test('invitation acceptance also fails closed when the lock cannot be taken', async function acceptanceFailClosed() {
  await resetTenant('ACTIVE');
  const token = await seedInvitation();

  const handle = createHandle(connectionString, { stripLockMethod: true });
  const prisma = await handle.connect();

  await assert.rejects(
    function run() { return invitationService.acceptInvitation(prisma, config(), token, REGISTRATION); },
    function verify(error) {
      assert.equal(error.status, 500);
      assert.equal(error.code, 'TENANT_LOCK_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(await countMembers(), 0, 'no membership may be created without the lock');
  await handle.close();
});
