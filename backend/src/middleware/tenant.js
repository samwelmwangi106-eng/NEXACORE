const { permissionAppliesToIndustry } = require('../config/permissions');

function createRequireTenant(prisma) {
  return async function requireTenant(req, res, next) {
    const organisationId = req.params.organisationId;
    if (!organisationId) {
      return res.status(400).json({ error: { code: 'ORGANISATION_REQUIRED', message: 'Organisation context is required' } });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organisationId)) {
      return res.status(400).json({ error: { code: 'INVALID_ORGANISATION_ID', message: 'Organisation identifier is invalid' } });
    }
    try {
      const membership = await prisma.organisationMember.findFirst({
        where: {
          organisationId,
          userId: req.auth.userId,
          status: 'ACTIVE',
          organisation: { status: 'ACTIVE' },
        },
        include: {
          organisation: true,
          assignments: {
            include: {
              role: { include: { permissions: { include: { permission: true } } } },
            },
          },
        },
      });
      if (!membership) {
        return res.status(404).json({ error: { code: 'ORGANISATION_NOT_FOUND', message: 'Organisation not found' } });
      }
      req.tenant = {
        id: membership.organisationId,
        organisation: membership.organisation,
        membershipId: membership.id,
        roles: new Set(membership.assignments.map(function roleName(assignment) { return assignment.role.name; })),
        permissions: new Set(membership.assignments.flatMap(function permissionKeys(assignment) {
          return assignment.role.permissions
            .map(function key(item) { return item.permission.key; })
            // Industry-scoped permissions never surface for an organisation whose
            // industry they do not apply to, even if the role grants them.
            .filter(function industryAllowed(key) {
              return permissionAppliesToIndustry(key, membership.organisation.industry);
            });
        })),
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requirePermission(permission) {
  return function permissionGuard(req, res, next) {
    if (!req.tenant || !req.tenant.permissions.has(permission)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' } });
    }
    return next();
  };
}

module.exports = { createRequireTenant, requirePermission };
