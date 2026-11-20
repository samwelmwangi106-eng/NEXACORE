const crypto = require('node:crypto');
const { AppError } = require('../../lib/errors');
const { hashRefreshSecret, normalizeEmail } = require('../../lib/security');
const { enqueueEmail } = require('../notifications/outbox.service');
const { recordAudit } = require('../audit/audit.service');

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

function invitationLink(config, token) {
  const url = new URL('/accept-invitation', config.webOrigin);
  url.searchParams.set('token', token);
  return url.toString();
}

async function createInvitation(prisma, config, context, email, requestedRoleId) {
  const normalizedEmail = normalizeEmail(email);
  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existingUser) throw new AppError(409, 'INVITATION_REQUIRES_UNREGISTERED_EMAIL', 'Invitations are only for users who do not already have an account');
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshSecret(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  return prisma.$transaction(async function createInvitationTransaction(tx) {
    const now = new Date();
    await tx.organisationInvitation.updateMany({
      where: { organisationId: context.organisationId, email: normalizedEmail, acceptedAt: null, revokedAt: null, expiresAt: { lte: now } },
      data: { revokedAt: now },
    });
    const pending = await tx.organisationInvitation.findFirst({
      where: { organisationId: context.organisationId, email: normalizedEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (pending) throw new AppError(409, 'INVITATION_ALREADY_PENDING', 'A live invitation already exists for this email');
    const role = await tx.role.findFirst({
      where: { organisationId: context.organisationId, ...(requestedRoleId ? { id: requestedRoleId } : { name: 'Staff Member' }) },
      include: { permissions: { select: { permissionId: true } } },
    });
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found in this organisation');
    if (role.name === 'Organisation Owner') throw new AppError(400, 'OWNER_INVITATION_FORBIDDEN', 'Organisation Owner access must be assigned directly by an owner');
    const actorPermissions = await tx.memberRole.findMany({
      where: { memberId: context.memberId },
      include: { role: { include: { permissions: { select: { permissionId: true } } } } },
    });
    const held = new Set(actorPermissions.flatMap(function permissionIds(assignment) {
      return assignment.role.permissions.map(function permissionId(entry) { return entry.permissionId; });
    }));
    if (!role.permissions.every(function actorHasPermission(permission) { return held.has(permission.permissionId); })) {
      throw new AppError(403, 'ROLE_PERMISSION_ESCALATION', 'You cannot assign a role with permissions you do not hold');
    }
    const invitation = await tx.organisationInvitation.create({
      data: {
        organisationId: context.organisationId,
        roleId: role.id,
        invitedById: context.userId,
        email: normalizedEmail,
        tokenHash,
        expiresAt,
      },
    });
    const link = invitationLink(config, rawToken);
    await enqueueEmail(tx, config, {
      to: normalizedEmail,
      subject: `Invitation to join ${context.organisationName}`,
      text: `You have been invited to join ${context.organisationName}. Create your NexaCore account and accept this invitation within 72 hours: ${link}`,
    });
    await recordAudit(tx, {
      organisationId: context.organisationId,
      actorUserId: context.userId,
      action: 'organisation.invitation_created',
      entityType: 'organisation_invitation',
      entityId: invitation.id,
      requestId: context.requestId,
      metadata: { email: normalizedEmail, roleId: role.id, expiresAt: expiresAt.toISOString() },
    });
    return { id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt, roleId: role.id };
  });
}

async function acceptInvitation(prisma, config, invitationToken, registration, context) {
  const tokenHash = hashRefreshSecret(invitationToken);
  const invitation = await prisma.organisationInvitation.findUnique({
    where: { tokenHash },
    include: { organisation: true },
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()
      || invitation.organisation.status !== 'ACTIVE') {
    throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid, expired, or already used');
  }
  if (normalizeEmail(registration.email) !== invitation.email) {
    throw new AppError(400, 'INVITATION_EMAIL_MISMATCH', 'The account email must match the invitation');
  }
  return prisma.$transaction(async function acceptInvitationTransaction(tx) {
    const currentInvitation = await tx.organisationInvitation.findUnique({
      where: { id: invitation.id },
      include: { organisation: true },
    });
    if (!currentInvitation || currentInvitation.organisation.status !== 'ACTIVE'
        || currentInvitation.acceptedAt || currentInvitation.revokedAt || currentInvitation.expiresAt <= new Date()) {
      throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid, expired, or already used');
    }
    const consumed = await tx.organisationInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (!consumed.count) throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid, expired, or already used');
    const user = await tx.user.create({
      data: {
        email: invitation.email,
        passwordHash: registration.passwordHash,
        firstName: registration.firstName,
        lastName: registration.lastName,
        status: 'PENDING_VERIFICATION',
      },
    });
    const member = await tx.organisationMember.create({
      data: { organisationId: invitation.organisationId, userId: user.id, status: 'INVITED' },
    });
    await tx.memberRole.create({ data: { organisationId: invitation.organisationId, memberId: member.id, roleId: invitation.roleId } });
    const verificationToken = crypto.randomBytes(32).toString('base64url');
    await tx.authToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFICATION',
        tokenHash: hashRefreshSecret(verificationToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const verificationUrl = new URL('/verify-email', config.webOrigin);
    verificationUrl.searchParams.set('token', verificationToken);
    await enqueueEmail(tx, config, {
      to: user.email,
      subject: 'Verify your NexaCore email',
      text: `Use this link to verify your NexaCore email address: ${verificationUrl.toString()}`,
    });
    await recordAudit(tx, {
      organisationId: invitation.organisationId,
      actorUserId: user.id,
      action: 'organisation.invitation_accepted',
      entityType: 'organisation_invitation',
      requestId: context && context.requestId,
      entityId: invitation.id,
      metadata: { memberId: member.id, roleId: invitation.roleId },
    });
    return { user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status }, organisation: { id: invitation.organisation.id, name: invitation.organisation.name } };
  });
}

async function revokeInvitation(prisma, invitationId, context) {
  return prisma.$transaction(async function revokeInvitationTransaction(tx) {
    const result = await tx.organisationInvitation.updateMany({
      where: { id: invitationId, organisationId: context.organisationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation was not found or is no longer active');
    await recordAudit(tx, {
      organisationId: context.organisationId,
      actorUserId: context.userId,
      action: 'organisation.invitation_revoked',
      entityType: 'organisation_invitation',
      entityId: invitationId,
      requestId: context.requestId,
      metadata: {},
    });
  });
}

module.exports = { createInvitation, acceptInvitation, revokeInvitation, INVITATION_TTL_MS };
