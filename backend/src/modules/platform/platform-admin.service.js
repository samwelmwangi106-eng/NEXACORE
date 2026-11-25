const { AppError } = require('../../lib/errors');
const { recordAudit } = require('../audit/audit.service');
const { lockOrganisation } = require('../../lib/tenant-lock');

async function listOrganisations(prisma, limit) {
  return prisma.organisation.findMany({
    select: { id: true, name: true, slug: true, industry: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

async function changeOrganisationStatus(prisma, actorUserId, organisationId, status, requestId) {
  return prisma.$transaction(async function updateOrganisationStatusTransaction(tx) {
    // Take the same per-organisation advisory lock that invitation acceptance
    // takes, so a status change cannot interleave with a membership-creating
    // transaction. Without this, acceptance can read ACTIVE, a suspension can
    // commit, and acceptance can still create the membership.
    await lockOrganisation(tx, organisationId);
    const organisation = await tx.organisation.findUnique({ where: { id: organisationId } });
    if (!organisation) throw new AppError(404, 'ORGANISATION_NOT_FOUND', 'Organisation not found');
    const updated = await tx.organisation.update({ where: { id: organisationId }, data: { status } });
    await recordAudit(tx, {
      actorUserId,
      action: 'platform.organisation_status_changed',
      entityType: 'organisation',
      entityId: organisationId,
      requestId,
      metadata: { from: organisation.status, to: status },
    });
    return updated;
  });
}

async function listUsers(prisma, limit) {
  return prisma.user.findMany({
    select: { id: true, email: true, firstName: true, lastName: true, status: true, emailVerifiedAt: true, tokenVersion: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

async function changeUserStatus(prisma, actorUserId, userId, status, requestId) {
  return prisma.$transaction(async function updateUserStatusTransaction(tx) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (status === 'ACTIVE' && !user.emailVerifiedAt) {
      throw new AppError(409, 'EMAIL_NOT_VERIFIED', 'An unverified account cannot be activated');
    }
    if (status === 'SUSPENDED' && user.status !== 'SUSPENDED') {
      const adminPermission = await tx.platformPermission.findUnique({ where: { key: 'platform.admins.manage' } });
      if (adminPermission) {
        const activeAdministrators = await tx.platformAdminGrant.count({
          where: { permissionId: adminPermission.id, user: { status: 'ACTIVE', id: { not: userId } } },
        });
        const userIsPlatformAdmin = await tx.platformAdminGrant.count({ where: { userId, permissionId: adminPermission.id } });
        if (userIsPlatformAdmin && activeAdministrators === 0) {
          throw new AppError(409, 'LAST_PLATFORM_ADMIN_REQUIRED', 'The final active platform administrator cannot be suspended');
        }
      }
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: { status, tokenVersion: { increment: 1 } },
    });
    await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordAudit(tx, {
      actorUserId,
      action: 'platform.user_status_changed',
      entityType: 'user',
      entityId: userId,
      requestId,
      metadata: { from: user.status, to: status },
    });
    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      status: updated.status,
      emailVerifiedAt: updated.emailVerifiedAt,
    };
  }, { isolationLevel: 'Serializable' });
}

async function getPlatformPermissions(prisma, userId) {
  const grants = await prisma.platformAdminGrant.findMany({
    where: { userId },
    include: { permission: true },
    orderBy: { permission: { key: 'asc' } },
  });
  return grants.map(function permissionKey(grant) { return grant.permission.key; });
}

async function setPlatformPermissions(prisma, actorUserId, targetUserId, keys, requestId) {
  const requested = Array.from(new Set(keys));
  return prisma.$transaction(async function setPlatformPermissionsTransaction(tx) {
    const target = await tx.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const [actorGrants, permissions] = await Promise.all([
      tx.platformAdminGrant.findMany({ where: { userId: actorUserId }, include: { permission: true } }),
      tx.platformPermission.findMany({ where: { key: { in: requested } } }),
    ]);
    const actorKeys = new Set(actorGrants.map(function key(grant) { return grant.permission.key; }));
    if (permissions.length !== requested.length) throw new AppError(400, 'INVALID_PLATFORM_PERMISSION', 'One or more platform permissions are unknown');
    if (!requested.every(function permitted(key) { return actorKeys.has(key); })) {
      throw new AppError(403, 'PLATFORM_PERMISSION_ESCALATION', 'You cannot grant platform permissions you do not hold');
    }

    const administratorPermission = await tx.platformPermission.findUnique({ where: { key: 'platform.admins.manage' } });
    const targetHasAdminManagement = administratorPermission && await tx.platformAdminGrant.count({
      where: { userId: targetUserId, permissionId: administratorPermission.id },
    });
    const willHaveAdminManagement = requested.includes('platform.admins.manage');
    if (target.status === 'ACTIVE' && targetHasAdminManagement && !willHaveAdminManagement) {
      const otherActiveAdministrators = await tx.platformAdminGrant.count({
        where: { userId: { not: targetUserId }, permissionId: administratorPermission.id, user: { status: 'ACTIVE' } },
      });
      if (!otherActiveAdministrators) {
        throw new AppError(409, 'LAST_PLATFORM_ADMIN_REQUIRED', 'The final active platform administrator cannot lose administrator management access');
      }
    }

    await tx.platformAdminGrant.deleteMany({ where: { userId: targetUserId } });
    if (permissions.length) {
      await tx.platformAdminGrant.createMany({
        data: permissions.map(function grant(permission) {
          return { userId: targetUserId, permissionId: permission.id, grantedById: actorUserId };
        }),
      });
    }
    await recordAudit(tx, {
      actorUserId,
      action: 'platform.admin_permissions_changed',
      entityType: 'user',
      entityId: targetUserId,
      requestId,
      metadata: { permissionKeys: requested },
    });
    return { userId: targetUserId, permissions: requested };
  }, { isolationLevel: 'Serializable' });
}

async function listPlatformAudit(prisma, limit) {
  return prisma.auditLog.findMany({
    where: { organisationId: null },
    take: limit,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

module.exports = {
  listOrganisations, changeOrganisationStatus, listUsers, changeUserStatus,
  getPlatformPermissions, setPlatformPermissions, listPlatformAudit,
};
