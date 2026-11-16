const { MembershipStatus } = require('@prisma/client');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../../config/permissions');
const { recordAudit } = require('../audit/audit.service');
const { slugify } = require('../auth/auth.service');

async function createOrganisation(prisma, userId, data, requestId) {
  return prisma.$transaction(async function createOrganisationTransaction(tx) {
    const organisation = await tx.organisation.create({
      data: { name: data.name, slug: slugify(data.name), industry: data.industry },
    });
    const membership = await tx.organisationMember.create({
      data: { organisationId: organisation.id, userId, status: MembershipStatus.ACTIVE },
    });
    for (const [key, description] of PERMISSIONS) {
      await tx.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
    }
    for (const [name, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
      const role = await tx.role.create({
        data: {
          organisationId: organisation.id,
          name,
          isSystemRole: true,
          permissions: { create: permissionKeys.map(function permission(key) { return { permission: { connect: { key } } }; }) },
        },
      });
      if (name === 'Organisation Owner') {
        await tx.memberRole.create({ data: { organisationId: organisation.id, memberId: membership.id, roleId: role.id } });
      }
    }
    await recordAudit(tx, {
      organisationId: organisation.id,
      actorUserId: userId,
      action: 'organisation.created',
      entityType: 'organisation',
      entityId: organisation.id,
      requestId,
      metadata: { industry: data.industry },
    });
    return organisation;
  });
}

async function listUserOrganisations(prisma, userId) {
  const memberships = await prisma.organisationMember.findMany({
    where: { userId, status: MembershipStatus.ACTIVE, organisation: { status: 'ACTIVE' } },
    include: { organisation: true, assignments: { include: { role: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  return memberships.map(function mapMembership(membership) {
    return {
      id: membership.organisation.id,
      name: membership.organisation.name,
      slug: membership.organisation.slug,
      industry: membership.organisation.industry,
      roles: membership.assignments.map(function roleName(assignment) { return assignment.role.name; }),
    };
  });
}

module.exports = { createOrganisation, listUserOrganisations };
