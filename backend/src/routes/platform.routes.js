const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { createAuthenticate } = require('../middleware/authenticate');
const { createRequireTenant, requirePermission } = require('../middleware/tenant');
const { createOrganisation, listUserOrganisations } = require('../modules/organisations/organisation.service');
const { publicUser } = require('../modules/auth/auth.service');
const { recordAudit } = require('../modules/audit/audit.service');
const accessService = require('../modules/organisations/access.service');
const {
  memberCreateSchema, membershipStatusSchema, membershipRolesSchema,
  roleCreateSchema, roleUpdateSchema,
} = require('../modules/organisations/access.schemas');
const { AppError } = require('../lib/errors');
const { organisationUpdateSchema } = require('../modules/organisations/organisation.schemas');

const createOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(180),
  industry: z.enum(['SCHOOL', 'SACCO', 'CLINIC', 'RENTAL']),
}).strict();

function validateResourceUuid(req, res, next) {
  const id = req.params.memberId || req.params.roleId;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: { code: 'INVALID_RESOURCE_ID', message: 'Resource identifier is invalid' } });
  }
  return next();
}

function createPlatformRouter(prisma, config) {
  const router = express.Router();
  const authenticate = createAuthenticate({ ...config, prisma });
  const requireTenant = createRequireTenant(prisma);
  router.use(authenticate);

  router.get('/me', async function currentUser(req, res, next) {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
      if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Account no longer exists');
      return res.json({ user: publicUser(user), organisations: await listUserOrganisations(prisma, user.id) });
    } catch (error) { return next(error); }
  });

  router.get('/organisations', async function organisations(req, res, next) {
    try { return res.json({ organisations: await listUserOrganisations(prisma, req.auth.userId) }); }
    catch (error) { return next(error); }
  });

  router.post('/organisations', validate(createOrganisationSchema, 'body'), async function addOrganisation(req, res, next) {
    try {
      const organisation = await createOrganisation(prisma, req.auth.userId, req.body, req.requestId);
      return res.status(201).json({ organisation });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'ORGANISATION_CONFLICT', 'Could not create organisation with a unique identifier'));
      return next(error);
    }
  });

  router.get('/organisations/:organisationId', requireTenant, requirePermission('organisation.read'), function organisationDetails(req, res) {
    return res.json({ organisation: req.tenant.organisation });
  });

  router.patch('/organisations/:organisationId', requireTenant, requirePermission('organisation.update'), validate(
    organisationUpdateSchema, 'body',
  ), async function updateOrganisation(req, res, next) {
    try {
      const updated = await prisma.$transaction(async function updateOrganisationTransaction(tx) {
        const organisation = await tx.organisation.update({
          where: { id: req.tenant.id },
          data: {
            ...req.body,
            ...(req.body.settings ? { settings: { ...(req.tenant.organisation.settings || {}), ...req.body.settings } } : {}),
          },
        });
        await recordAudit(tx, {
          organisationId: req.tenant.id,
          actorUserId: req.auth.userId,
          action: 'organisation.updated',
          entityType: 'organisation',
          entityId: organisation.id,
          requestId: req.requestId,
          metadata: { changedFields: Object.keys(req.body) },
        });
        return organisation;
      });
      return res.json({ organisation: updated });
    } catch (error) { return next(error); }
  });

  router.get('/organisations/:organisationId/members', requireTenant, requirePermission('members.read'), async function getMembers(req, res, next) {
    try {
      return res.json({ members: await accessService.listMembers(prisma, req.tenant.id) });
    } catch (error) { return next(error); }
  });

  router.post('/organisations/:organisationId/members', requireTenant, requirePermission('members.manage'), validate(memberCreateSchema, 'body'), async function addMember(req, res, next) {
    try {
      const member = await accessService.addMember(prisma, req.auth.userId, req.tenant.id, req.body.email, req.requestId);
      return res.status(201).json({ member });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'MEMBERSHIP_EXISTS', 'This account is already a member of the organisation'));
      return next(error);
    }
  });

  router.patch('/organisations/:organisationId/members/:memberId/status', requireTenant, requirePermission('members.manage'), validateResourceUuid, validate(membershipStatusSchema, 'body'), async function updateMemberStatus(req, res, next) {
    try {
      const member = await accessService.updateMemberStatus(prisma, req.auth.userId, req.tenant.id, req.params.memberId, req.body.status, req.tenant.roles, req.requestId);
      return res.json({ member });
    } catch (error) { return next(error); }
  });

  router.patch('/organisations/:organisationId/members/:memberId/roles', requireTenant, requirePermission('roles.manage'), validateResourceUuid, validate(membershipRolesSchema, 'body'), async function setMemberRoles(req, res, next) {
    try {
      const member = await accessService.setMemberRoles(
        prisma, req.auth.userId, req.tenant.id, req.params.memberId, req.body.roles,
        req.tenant.permissions, req.tenant.roles, req.requestId,
      );
      return res.json({ member });
    } catch (error) { return next(error); }
  });

  router.get('/organisations/:organisationId/roles', requireTenant, requirePermission('roles.read'), async function getRoles(req, res, next) {
    try { return res.json({ roles: await accessService.listRoles(prisma, req.tenant.id) }); }
    catch (error) { return next(error); }
  });

  router.post('/organisations/:organisationId/roles', requireTenant, requirePermission('roles.manage'), validate(roleCreateSchema, 'body'), async function addRole(req, res, next) {
    try {
      const role = await accessService.createRole(prisma, req.auth.userId, req.tenant.id, req.body, req.tenant.permissions, req.requestId);
      return res.status(201).json({ role });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'ROLE_EXISTS', 'A role with this name already exists'));
      return next(error);
    }
  });

  router.patch('/organisations/:organisationId/roles/:roleId', requireTenant, requirePermission('roles.manage'), validateResourceUuid, validate(roleUpdateSchema, 'body'), async function updateRole(req, res, next) {
    try {
      const role = await accessService.updateRole(prisma, req.auth.userId, req.tenant.id, req.params.roleId, req.body, req.tenant.permissions, req.requestId);
      return res.json({ role });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'ROLE_EXISTS', 'A role with this name already exists'));
      return next(error);
    }
  });

  router.delete('/organisations/:organisationId/roles/:roleId', requireTenant, requirePermission('roles.manage'), validateResourceUuid, async function removeRole(req, res, next) {
    try {
      await accessService.deleteRole(prisma, req.auth.userId, req.tenant.id, req.params.roleId, req.requestId);
      return res.status(204).end();
    } catch (error) { return next(error); }
  });

  router.get('/organisations/:organisationId/audit-logs', requireTenant, requirePermission('audit.read'), async function auditLogs(req, res, next) {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
      const cursor = req.query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor))) {
        throw new AppError(400, 'INVALID_CURSOR', 'Audit cursor is invalid');
      }
      const entries = await prisma.auditLog.findMany({
        where: { organisationId: req.tenant.id },
        take: limit + 1,
        ...(typeof cursor === 'string' ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const hasMore = entries.length > limit;
      const page = hasMore ? entries.slice(0, limit) : entries;
      return res.json({ entries: page, nextCursor: hasMore ? page[page.length - 1].id : null });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = { createPlatformRouter };
