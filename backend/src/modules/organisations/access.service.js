const { normalizeEmail } = require('../../lib/security');
const { AppError } = require('../../lib/errors');
const { recordAudit } = require('../audit/audit.service');

function publicMember(member) {
  return {
    id: member.id,
    status: member.status,
    joinedAt: member.joinedAt,
    user: {
      id: member.user.id,
      email: member.user.email,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      status: member.user.status,
    },
    roles: member.assignments.map(function mapRole(item) {
      return { id: item.role.id, name: item.role.name };
    }),
  };
}

async function listMembers(prisma, organisationId) {
  const members = await prisma.organisationMember.findMany({
    where: { organisationId },
    include: { user: true, assignments: { include: { role: true } } },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
  });
  return members.map(publicMember);
}

async function addMember(prisma, actorUserId, organisationId, email, requestId) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
    throw new AppError(404, 'USER_NOT_AVAILABLE', 'No verified active account was found for that email');
  }
  return prisma.$transaction(async function addMemberTransaction(tx) {
    const membership = await tx.organisationMember.create({
      data: { organisationId, userId: user.id, status: 'ACTIVE' },
    });
    const defaultRole = await tx.role.findUnique({
      where: { organisationId_name: { organisationId, name: 'Staff Member' } },
    });
    if (!defaultRole) throw new Error('Default Staff Member role is missing from tenant');
    await tx.memberRole.create({ data: { organisationId, memberId: membership.id, roleId: defaultRole.id } });
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'membership.created',
      entityType: 'organisation_member',
      entityId: membership.id,
      requestId,
      metadata: { targetUserId: user.id },
    });
    const fullMembership = await tx.organisationMember.findUnique({
      where: { id: membership.id },
      include: { user: true, assignments: { include: { role: true } } },
    });
    return publicMember(fullMembership);
  });
}

async function getMembership(tx, organisationId, memberId) {
  const membership = await tx.organisationMember.findFirst({
    where: { id: memberId, organisationId },
    include: { assignments: { include: { role: true } } },
  });
  if (!membership) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Organisation member not found');
  return membership;
}

/**
 * Serialize ownership mutations for one organisation.
 *
 * The last-owner guard is a read-then-write ("does another owner still exist?").
 * Without serialization two concurrent suspensions can both observe the other
 * owner as present and both commit, leaving an organisation with no owner.
 *
 * A transaction-scoped advisory lock keyed on the organisation makes the guard
 * atomic and is released automatically on COMMIT/ROLLBACK. It is skipped when
 * the client cannot execute raw SQL (e.g. lightweight unit-test doubles), which
 * keeps non-transactional callers working.
 */
async function lockOrganisationOwnership(tx, organisationId) {
  if (typeof tx.$executeRaw !== 'function') return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organisationId}::text, 0))`;
}

async function ensureOwnerNotRemoved(tx, organisationId, membership, willRemainOwner) {
  const currentlyOwner = membership.assignments.some(function isOwner(assignment) {
    return assignment.role.name === 'Organisation Owner';
  });
  if (!currentlyOwner || willRemainOwner) return;
  const otherOwners = await tx.memberRole.count({
    where: {
      organisationId,
      memberId: { not: membership.id },
      role: { name: 'Organisation Owner' },
      member: { status: 'ACTIVE' },
    },
  });
  if (!otherOwners) {
    throw new AppError(409, 'LAST_OWNER_REQUIRED', 'An organisation must retain at least one active owner');
  }
}

async function updateMemberStatus(prisma, actorUserId, organisationId, membershipId, status, actorRoles, requestId) {
  return prisma.$transaction(async function updateMemberStatusTransaction(tx) {
    await lockOrganisationOwnership(tx, organisationId);
    const membership = await getMembership(tx, organisationId, membershipId);
    const targetIsOwner = membership.assignments.some(function isOwner(assignment) { return assignment.role.name === 'Organisation Owner'; });
    if (targetIsOwner && !actorRoles.has('Organisation Owner')) {
      throw new AppError(403, 'OWNER_MANAGEMENT_FORBIDDEN', 'Only an organisation owner can change an owner membership');
    }
    await ensureOwnerNotRemoved(tx, organisationId, membership, status === 'ACTIVE');
    await tx.organisationMember.update({ where: { id: membership.id }, data: { status } });
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'membership.status_updated',
      entityType: 'organisation_member',
      entityId: membership.id,
      requestId,
      metadata: { status },
    });
    const updated = await tx.organisationMember.findUnique({
      where: { id: membership.id },
      include: { user: true, assignments: { include: { role: true } } },
    });
    return publicMember(updated);
  });
}

function actorCanAssignRole(role, actorPermissions, actorRoles) {
  if (role.name === 'Organisation Owner' && !actorRoles.has('Organisation Owner')) return false;
  return role.permissions.every(function permissionWithinActor(permission) {
    return actorPermissions.has(permission.permission.key);
  });
}

async function setMemberRoles(prisma, actorUserId, organisationId, membershipId, roleIds, actorPermissions, actorRoles, requestId) {
  return prisma.$transaction(async function setMemberRolesTransaction(tx) {
    await lockOrganisationOwnership(tx, organisationId);
    const membership = await getMembership(tx, organisationId, membershipId);
    if (membership.status !== 'ACTIVE') throw new AppError(409, 'MEMBER_INACTIVE', 'Roles can only be changed for an active member');
    const roles = await tx.role.findMany({
      where: { organisationId, id: { in: roleIds } },
      include: { permissions: { include: { permission: true } } },
    });
    if (roles.length !== new Set(roleIds).size) throw new AppError(400, 'INVALID_ROLE', 'One or more roles are not available in this organisation');
    if (!roles.every(function permitted(role) { return actorCanAssignRole(role, actorPermissions, actorRoles); })) {
      throw new AppError(403, 'ROLE_ASSIGNMENT_FORBIDDEN', 'You cannot assign roles with permissions you do not hold');
    }
    const targetIsOwner = membership.assignments.some(function isOwner(assignment) { return assignment.role.name === 'Organisation Owner'; });
    const willRemainOwner = roles.some(function ownerRole(role) { return role.name === 'Organisation Owner'; });
    if ((targetIsOwner || willRemainOwner) && !actorRoles.has('Organisation Owner')) {
      throw new AppError(403, 'OWNER_MANAGEMENT_FORBIDDEN', 'Only an organisation owner can assign or remove the owner role');
    }
    await ensureOwnerNotRemoved(tx, organisationId, membership, willRemainOwner);
    await tx.memberRole.deleteMany({ where: { organisationId, memberId: membership.id } });
    if (roles.length) {
      await tx.memberRole.createMany({
        data: roles.map(function assignment(role) { return { organisationId, memberId: membership.id, roleId: role.id }; }),
      });
    }
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'membership.roles_updated',
      entityType: 'organisation_member',
      entityId: membership.id,
      requestId,
      metadata: { roleIds: roles.map(function roleId(role) { return role.id; }) },
    });
    const updated = await tx.organisationMember.findUnique({
      where: { id: membership.id },
      include: { user: true, assignments: { include: { role: true } } },
    });
    return publicMember(updated);
  });
}

async function listRoles(prisma, organisationId) {
  const roles = await prisma.role.findMany({
    where: { organisationId },
    include: { permissions: { include: { permission: true } } },
    orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
  });
  return roles.map(function serializeRole(role) {
    return { id: role.id, name: role.name, isSystemRole: role.isSystemRole,
      permissions: role.permissions.map(function permissionKey(item) { return item.permission.key; }) };
  });
}

async function validatePermissionKeys(prisma, organisationId, keys, actorPermissions) {
  const uniqueKeys = Array.from(new Set(keys));
  const permissions = await prisma.permission.findMany({ where: { key: { in: uniqueKeys } } });
  if (permissions.length !== uniqueKeys.length) throw new AppError(400, 'INVALID_PERMISSION', 'One or more permissions do not exist');
  if (!permissions.every(function withinActor(permission) { return actorPermissions.has(permission.key); })) {
    throw new AppError(403, 'PERMISSION_ESCALATION', 'A role cannot grant permissions you do not hold');
  }
  return uniqueKeys;
}

async function createRole(prisma, actorUserId, organisationId, data, actorPermissions, requestId) {
  const permissions = await validatePermissionKeys(prisma, organisationId, data.permissions, actorPermissions);
  return prisma.$transaction(async function createRoleTransaction(tx) {
    const role = await tx.role.create({
      data: {
        organisationId,
        name: data.name,
        isSystemRole: false,
        permissions: { create: permissions.map(function connectPermission(key) { return { permission: { connect: { key } } }; }) },
      },
      include: { permissions: { include: { permission: true } } },
    });
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'role.created',
      entityType: 'role',
      entityId: role.id,
      requestId,
      metadata: { permissionKeys: permissions },
    });
    return { id: role.id, name: role.name, isSystemRole: false, permissions };
  });
}

async function updateRole(prisma, actorUserId, organisationId, roleId, data, actorPermissions, requestId) {
  const permissions = data.permissions === undefined
    ? undefined
    : await validatePermissionKeys(prisma, organisationId, data.permissions, actorPermissions);
  return prisma.$transaction(async function updateRoleTransaction(tx) {
    const role = await tx.role.findFirst({ where: { id: roleId, organisationId } });
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');
    if (role.isSystemRole) throw new AppError(409, 'SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be modified');
    const updated = await tx.role.update({
      where: { id: role.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(permissions !== undefined ? { permissions: {
          deleteMany: {},
          create: permissions.map(function connectPermission(key) { return { permission: { connect: { key } } }; }),
        } } : {}),
      },
      include: { permissions: { include: { permission: true } } },
    });
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'role.updated',
      entityType: 'role',
      entityId: role.id,
      requestId,
      metadata: { changedFields: Object.keys(data) },
    });
    return { id: updated.id, name: updated.name, isSystemRole: updated.isSystemRole,
      permissions: updated.permissions.map(function key(item) { return item.permission.key; }) };
  });
}

async function deleteRole(prisma, actorUserId, organisationId, roleId, requestId) {
  return prisma.$transaction(async function deleteRoleTransaction(tx) {
    const role = await tx.role.findFirst({ where: { id: roleId, organisationId } });
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');
    if (role.isSystemRole) throw new AppError(409, 'SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be deleted');
    const assignmentCount = await tx.memberRole.count({ where: { organisationId, roleId } });
    if (assignmentCount) throw new AppError(409, 'ROLE_IN_USE', 'Remove this role from all members before deleting it');
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'role.deleted',
      entityType: 'role',
      entityId: role.id,
      requestId,
      metadata: { name: role.name },
    });
    await tx.role.delete({ where: { id: role.id } });
    return { id: role.id };
  });
}

module.exports = {
  listMembers, addMember, updateMemberStatus, setMemberRoles, lockOrganisationOwnership,
  listRoles, createRole, updateRole, deleteRole,
};
