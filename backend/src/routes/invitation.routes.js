const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { createAuthenticate } = require('../middleware/authenticate');
const { createRequireTenant, requirePermission } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { AppError } = require('../lib/errors');
const { hashPassword, hashRefreshSecret, passwordSchema } = require('../lib/security');
const invitationService = require('../modules/organisations/invitation.service');
const { createInvitationSchema, acceptInvitationSchema } = require('../modules/organisations/invitation.schemas');

const signupSchema = z.object({
  token: z.string().min(40).max(128),
  email: z.string().email().max(320),
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
}).strict();

function createInvitationRouter(prisma, config) {
  const router = express.Router();
  const invitationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }, requestId: req.requestId });
    },
  });
  const authenticate = createAuthenticate({ ...config, prisma });
  const requireTenant = createRequireTenant(prisma);
  router.post('/accept', invitationLimiter, validate(acceptInvitationSchema, 'body'), function invitationAcceptPayload(req, res, next) {
    req.invitationToken = req.body.token;
    return next();
  }, async function validateInvitation(req, res, next) {
    try {
      const raw = req.invitationToken;
      // No organisation identifier is accepted from the browser; the token resolves its own tenant.
      const result = await prisma.organisationInvitation.findUnique({
        where: { tokenHash: hashRefreshSecret(raw) },
        include: { organisation: { select: { status: true } } },
      });
      if (!result || result.acceptedAt || result.revokedAt || result.expiresAt <= new Date()
          || result.organisation.status !== 'ACTIVE') {
        return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'Invitation is invalid, expired, or already used' } });
      }
      return res.json({ email: result.email, expiresAt: result.expiresAt });
    } catch (error) { return next(error); }
  });
  router.post('/signup', invitationLimiter, validate(signupSchema, 'body'), async function acceptInvitation(req, res, next) {
    try {
      const passwordHash = await hashPassword(req.body.password);
      const result = await invitationService.acceptInvitation(prisma, config, req.body.token, {
        email: req.body.email,
        passwordHash,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
      }, { requestId: req.requestId });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.post('/organisations/:organisationId/invitations', invitationLimiter, authenticate, requireTenant, requirePermission('members.manage'), validate(createInvitationSchema, 'body'), async function createInvitation(req, res, next) {
    try {
      const invitation = await invitationService.createInvitation(prisma, config, {
        organisationId: req.tenant.id,
        organisationName: req.tenant.organisation.name,
        memberId: req.tenant.membershipId,
        userId: req.auth.userId,
        requestId: req.requestId,
      }, req.body.email, req.body.roleId);
      return res.status(201).json({ invitation });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'INVITATION_ALREADY_PENDING', 'A live invitation already exists for this email'));
      return next(error);
    }
  });
  router.delete('/organisations/:organisationId/invitations/:invitationId', invitationLimiter, authenticate, requireTenant, requirePermission('members.manage'), function validateInvitationId(req, res, next) {
    if (!z.string().uuid().safeParse(req.params.invitationId).success) {
      return res.status(400).json({ error: { code: 'INVALID_INVITATION_ID', message: 'Invitation identifier is invalid' } });
    }
    return next();
  }, async function revokeInvitation(req, res, next) {
    try {
      await invitationService.revokeInvitation(prisma, req.params.invitationId, {
        organisationId: req.tenant.organisationId,
        userId: req.auth.userId,
        requestId: req.requestId,
      });
      return res.status(204).end();
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { createInvitationRouter };
