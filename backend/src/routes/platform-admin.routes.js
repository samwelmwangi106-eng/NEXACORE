const express = require('express');
const { z } = require('zod');
const { createAuthenticate } = require('../middleware/authenticate');
const { requirePlatformPermission } = require('../middleware/platform-permission');
const { validate } = require('../middleware/validate');
const { AppError } = require('../lib/errors');
const platformAdmin = require('../modules/platform/platform-admin.service');

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).strict();
const permissionsSchema = z.object({ permissions: z.array(z.string().min(3).max(120)).max(100) }).strict();

function validateUuid(req, res, next) {
  const id = req.params.organisationId || req.params.userId;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: { code: 'INVALID_RESOURCE_ID', message: 'Resource identifier is invalid' } });
  }
  return next();
}

function boundedLimit(value) {
  return Math.min(Math.max(Number.parseInt(value, 10) || 50, 1), 100);
}

function createPlatformAdminRouter(prisma, config) {
  const router = express.Router();
  router.use(createAuthenticate({ ...config, prisma }));

  router.get('/organisations', requirePlatformPermission(prisma, 'platform.organisations.read'), async function organisations(req, res, next) {
    try { return res.json({ organisations: await platformAdmin.listOrganisations(prisma, boundedLimit(req.query.limit)) }); }
    catch (error) { return next(error); }
  });

  router.patch('/organisations/:organisationId/status', requirePlatformPermission(prisma, 'platform.organisations.manage'), validateUuid, validate(statusSchema, 'body'), async function changeOrganisationStatus(req, res, next) {
    try {
      const organisation = await platformAdmin.changeOrganisationStatus(prisma, req.auth.userId, req.params.organisationId, req.body.status, req.requestId);
      return res.json({ organisation });
    } catch (error) { return next(error); }
  });

  router.get('/users', requirePlatformPermission(prisma, 'platform.users.read'), async function users(req, res, next) {
    try { return res.json({ users: await platformAdmin.listUsers(prisma, boundedLimit(req.query.limit)) }); }
    catch (error) { return next(error); }
  });

  router.patch('/users/:userId/status', requirePlatformPermission(prisma, 'platform.users.manage'), validateUuid, validate(statusSchema, 'body'), async function changeUserStatus(req, res, next) {
    try {
      const user = await platformAdmin.changeUserStatus(prisma, req.auth.userId, req.params.userId, req.body.status, req.requestId);
      return res.json({ user });
    } catch (error) { return next(error); }
  });

  router.get('/admins/:userId/permissions', requirePlatformPermission(prisma, 'platform.admins.manage'), validateUuid, async function adminPermissions(req, res, next) {
    try {
      const permissions = await platformAdmin.getPlatformPermissions(prisma, req.params.userId);
      return res.json({ userId: req.params.userId, permissions });
    } catch (error) { return next(error); }
  });

  router.put('/admins/:userId/permissions', requirePlatformPermission(prisma, 'platform.admins.manage'), validateUuid, validate(permissionsSchema, 'body'), async function setAdminPermissions(req, res, next) {
    try {
      const result = await platformAdmin.setPlatformPermissions(prisma, req.auth.userId, req.params.userId, req.body.permissions, req.requestId);
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/audit-logs', requirePlatformPermission(prisma, 'platform.audit.read'), async function auditLogs(req, res, next) {
    try { return res.json({ entries: await platformAdmin.listPlatformAudit(prisma, boundedLimit(req.query.limit)) }); }
    catch (error) { return next(error); }
  });

  return router;
}

module.exports = { createPlatformAdminRouter };
