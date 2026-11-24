const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../src/modules/organisations/access.service');

const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const memberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function ownerMembership() {
  return { id: memberId, status: 'ACTIVE', assignments: [{ role: { name: 'Organisation Owner' } }] };
}

test('an organisation cannot remove or suspend its last active owner', async function preserveLastOwner() {
  let statusUpdateCalled = false;
  const tx = {
    organisationMember: {
      findFirst: async function findFirst() { return ownerMembership(); },
      update: async function update() { statusUpdateCalled = true; },
    },
    memberRole: { count: async function count() { return 0; } },
  };
  const prisma = { $transaction: async function transaction(callback) { return callback(tx); } };
  await assert.rejects(
    access.updateMemberStatus(prisma, 'actor', organisationId, memberId, 'SUSPENDED', new Set(['Organisation Owner']), 'request'),
    function lastOwner(error) { return error.code === 'LAST_OWNER_REQUIRED'; },
  );
  assert.equal(statusUpdateCalled, false);
});

test('an administrator cannot suspend an owner even when another owner exists', async function onlyOwnerCanManageOwners() {
  let statusUpdateCalled = false;
  const tx = {
    organisationMember: {
      findFirst: async function findFirst() { return ownerMembership(); },
      update: async function update() { statusUpdateCalled = true; },
    },
    memberRole: { count: async function count() { return 2; } },
  };
  const prisma = { $transaction: async function transaction(callback) { return callback(tx); } };
  await assert.rejects(
    access.updateMemberStatus(prisma, 'admin', organisationId, memberId, 'SUSPENDED', new Set(['Organisation Administrator']), 'request'),
    function ownerOnly(error) { return error.code === 'OWNER_MANAGEMENT_FORBIDDEN'; },
  );
  assert.equal(statusUpdateCalled, false);
});

test('an administrator cannot assign a role that grants permissions they lack', async function preventRoleEscalation() {
  let assignmentsDeleted = false;
  const tx = {
    organisationMember: { findFirst: async function findFirst() {
      return { id: memberId, status: 'ACTIVE', assignments: [{ role: { name: 'Staff Member' } }] };
    } },
    role: { findMany: async function findMany() {
      return [{ id: roleId, name: 'Billing Superuser', permissions: [{ permission: { key: 'billing.manage' } }] }];
    } },
    memberRole: { deleteMany: async function deleteMany() { assignmentsDeleted = true; } },
  };
  const prisma = { $transaction: async function transaction(callback) { return callback(tx); } };
  await assert.rejects(
    access.setMemberRoles(prisma, 'actor', organisationId, memberId, [roleId], new Set(['roles.manage']), new Set(['Organisation Administrator']), 'request'),
    function escalation(error) { return error.code === 'ROLE_ASSIGNMENT_FORBIDDEN'; },
  );
  assert.equal(assignmentsDeleted, false);
});

test('custom roles cannot grant a permission the actor does not possess', async function preventPermissionEscalation() {
  const prisma = {
    permission: { findMany: async function findMany() { return [{ key: 'billing.manage' }]; } },
  };
  await assert.rejects(
    access.createRole(prisma, 'actor', organisationId, { name: 'Billing Admin', permissions: ['billing.manage'] }, new Set(['roles.manage']), 'request'),
    function escalation(error) { return error.code === 'PERMISSION_ESCALATION'; },
  );
});

test('system roles cannot be changed or deleted', async function immutableSystemRoles() {
  const prisma = {
    $transaction: async function transaction(callback) {
      return callback({ role: { findFirst: async function findFirst() { return { id: roleId, isSystemRole: true }; } } });
    },
  };
  await assert.rejects(access.updateRole(prisma, 'actor', organisationId, roleId, { name: 'Renamed' }, new Set(), 'request'),
    function immutable(error) { return error.code === 'SYSTEM_ROLE_IMMUTABLE'; });
  await assert.rejects(access.deleteRole(prisma, 'actor', organisationId, roleId, 'request'),
    function immutable(error) { return error.code === 'SYSTEM_ROLE_IMMUTABLE'; });
});

test('ownership mutations serialize on a per-organisation advisory lock', async function serializeOwnership() {
  // Regression: the last-owner guard is a read-then-write. Without
  // serialization, two concurrent suspensions both see the other owner and
  // both commit, stranding the organisation with no owner.
  const lockCalls = [];
  const executeRaw = async function executeRaw(strings) {
    lockCalls.push(strings.join(''));
    return 0;
  };
  const prisma = {
    $transaction: async function transaction(callback) {
      return callback({
        $executeRaw: executeRaw,
        organisationMember: {
          findFirst: async function findFirst() { return ownerMembership(); },
          update: async function update() { return {}; },
          findUnique: async function findUnique() { return { ...ownerMembership(), user: {}, assignments: [] }; },
        },
        memberRole: {
          count: async function count() { return 1; },
          deleteMany: async function deleteMany() { return { count: 1 }; },
          createMany: async function createMany() { return { count: 1 }; },
        },
        role: { findMany: async function findMany() { return [{ id: roleId, name: 'Staff Member', permissions: [] }]; } },
        auditLog: { create: async function create() { return {}; } },
      });
    },
  };

  await access.updateMemberStatus(prisma, 'actor', organisationId, memberId, 'SUSPENDED', new Set(['Organisation Owner']), 'request');
  assert.equal(lockCalls.length, 1, 'status update must take the ownership lock');
  assert.match(lockCalls[0], /pg_advisory_xact_lock/, 'must use a transaction-scoped advisory lock');

  lockCalls.length = 0;
  await access.setMemberRoles(prisma, 'actor', organisationId, memberId, [roleId], new Set(['roles.manage']), new Set(['Organisation Owner']), 'request');
  assert.equal(lockCalls.length, 1, 'role assignment must take the ownership lock');
});

test('ownership guard still works for clients without raw SQL support', async function lockOptional() {
  const tx = {
    organisationMember: {
      findFirst: async function findFirst() { return ownerMembership(); },
      update: async function update() { throw new Error('must not update'); },
    },
    memberRole: { count: async function count() { return 0; } },
  };
  const prisma = { $transaction: async function transaction(callback) { return callback(tx); } };
  await assert.rejects(
    access.updateMemberStatus(prisma, 'actor', organisationId, memberId, 'SUSPENDED', new Set(['Organisation Owner']), 'request'),
    function lastOwner(error) { return error.code === 'LAST_OWNER_REQUIRED'; },
  );
});
