const crypto = require('node:crypto');
const { ROLE_PERMISSIONS, PERMISSIONS } = require('../../config/permissions');
const {
  normalizeEmail, hashPassword, verifyPassword, createRefreshSecret,
  hashRefreshSecret, refreshSecretMatches, createRefreshToken, parseRefreshToken, createAccessToken,
} = require('../../lib/security');
const { AppError } = require('../../lib/errors');
const { recordAudit } = require('../audit/audit.service');
const { enqueueEmail } = require('../notifications/outbox.service');

const TOKEN_LIFETIMES = { EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, PASSWORD_RESET: 60 * 60 * 1000 };

function slugify(name) {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'workspace';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

async function ensurePermissionCatalog(tx) {
  for (const [key, description] of PERMISSIONS) {
    await tx.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }
}

async function createOrganisationRoles(tx, organisationId, membershipId) {
  for (const [name, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await tx.role.create({
      data: {
        organisationId,
        name,
        isSystemRole: true,
        permissions: {
          create: permissionKeys.map(function mapPermission(key) {
            return { permission: { connect: { key } } };
          }),
        },
      },
    });
    if (name === 'Organisation Owner') {
      await tx.memberRole.create({ data: { organisationId, memberId: membershipId, roleId: role.id } });
    }
  }
}

async function createOneTimeToken(tx, userId, type) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await tx.authToken.updateMany({
    where: { userId, type, consumedAt: null },
    data: { consumedAt: now },
  });
  await tx.authToken.create({
    data: {
      userId,
      type,
      tokenHash: hashRefreshSecret(rawToken),
      expiresAt: new Date(now.getTime() + TOKEN_LIFETIMES[type]),
    },
  });
  return rawToken;
}

function authLink(config, path, token) {
  const link = new URL(path, config.webOrigin);
  link.searchParams.set('token', token);
  return link.toString();
}

async function enqueueAuthLink(tx, config, user, type, token) {
  const emailVerification = type === 'EMAIL_VERIFICATION';
  const purpose = emailVerification ? 'verify your NexaCore email address' : 'reset your NexaCore password';
  const endpoint = emailVerification ? '/verify-email' : '/reset-password';
  const link = authLink(config, endpoint, token);
  return enqueueEmail(tx, config, {
    to: user.email,
    subject: emailVerification ? 'Verify your NexaCore email' : 'Reset your NexaCore password',
    text: `Use this link to ${purpose}: ${link}\n\nIf you did not request this, you can ignore this email.`,
  });
}

async function issueSession(prisma, user, config, familyId) {
  const secret = createRefreshSecret();
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
  const session = await prisma.refreshSession.create({
    data: {
      userId: user.id,
      familyId: familyId || crypto.randomUUID(),
      tokenHash: hashRefreshSecret(secret),
      expiresAt,
    },
  });
  return {
    accessToken: createAccessToken(user, config.accessSecret, config.accessTtl, session.id),
    refreshToken: createRefreshToken(session.id, secret),
    refreshExpiresAt: expiresAt,
  };
}

async function register(prisma, data, config, context) {
  const passwordHash = await hashPassword(data.password);
  const userId = crypto.randomUUID();
  const result = await prisma.$transaction(async function registrationTransaction(tx) {
    const user = await tx.user.create({
      data: {
        id: userId,
        email: normalizeEmail(data.email),
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        status: 'PENDING_VERIFICATION',
      },
    });
    const organisation = await tx.organisation.create({
      data: { name: data.organisationName, slug: slugify(data.organisationName), industry: data.industry },
    });
    const member = await tx.organisationMember.create({
      data: { organisationId: organisation.id, userId: user.id, status: 'ACTIVE' },
    });
    await ensurePermissionCatalog(tx);
    await createOrganisationRoles(tx, organisation.id, member.id);
    const verificationToken = await createOneTimeToken(tx, user.id, 'EMAIL_VERIFICATION');
    await enqueueAuthLink(tx, config, user, 'EMAIL_VERIFICATION', verificationToken);
    await recordAudit(tx, {
      organisationId: organisation.id,
      actorUserId: user.id,
      action: 'organisation.created',
      entityType: 'organisation',
      entityId: organisation.id,
      requestId: context.requestId,
      metadata: { industry: data.industry },
    });
    return { user, organisation, verificationToken };
  });
  return { user: publicUser(result.user), organisation: result.organisation };
}

function publicUser(user) {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status };
}

async function verifyEmail(prisma, rawToken, config) {
  const tokenHash = hashRefreshSecret(rawToken);
  const token = await prisma.authToken.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!token || token.type !== 'EMAIL_VERIFICATION' || token.consumedAt || token.expiresAt <= new Date()
      || token.user.status !== 'PENDING_VERIFICATION') {
    throw new AppError(400, 'INVALID_VERIFICATION_TOKEN', 'Verification link is invalid or expired');
  }
  const user = await prisma.$transaction(async function verifyEmailTransaction(tx) {
    const consumed = await tx.authToken.updateMany({
      where: { id: token.id, type: 'EMAIL_VERIFICATION', consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!consumed.count) throw new AppError(400, 'INVALID_VERIFICATION_TOKEN', 'Verification link is invalid or expired');
    const activation = await tx.user.updateMany({
      where: { id: token.userId, status: 'PENDING_VERIFICATION', emailVerifiedAt: null },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    if (!activation.count) throw new AppError(400, 'INVALID_VERIFICATION_TOKEN', 'Verification link is invalid or expired');
    const updatedUser = await tx.user.findUnique({ where: { id: token.userId } });
    await recordAudit(tx, {
      actorUserId: updatedUser.id,
      action: 'account.email_verified',
      entityType: 'user',
      entityId: updatedUser.id,
      metadata: {},
    });
    return updatedUser;
  });
  const session = await issueSession(prisma, user, config);
  return { user: publicUser(user), ...session };
}

async function resendVerification(prisma, email, config, context) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user || user.status !== 'PENDING_VERIFICATION') return;
  await prisma.$transaction(async function resendVerificationTransaction(tx) {
    const rawToken = await createOneTimeToken(tx, user.id, 'EMAIL_VERIFICATION');
    await enqueueAuthLink(tx, config, user, 'EMAIL_VERIFICATION', rawToken);
  });
}

async function requestPasswordReset(prisma, email, config, context) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user || user.status !== 'ACTIVE') return;
  await prisma.$transaction(async function passwordResetTransaction(tx) {
    const token = await createOneTimeToken(tx, user.id, 'PASSWORD_RESET');
    await enqueueAuthLink(tx, config, user, 'PASSWORD_RESET', token);
    await recordAudit(tx, {
      actorUserId: user.id,
      action: 'account.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
      requestId: context.requestId,
      metadata: {},
    });
  });
}

async function resetPassword(prisma, rawToken, password, context) {
  const passwordHash = await hashPassword(password);
  const token = await prisma.authToken.findUnique({
    where: { tokenHash: hashRefreshSecret(rawToken) },
    include: { user: true },
  });
  if (!token || token.type !== 'PASSWORD_RESET' || token.consumedAt || token.expiresAt <= new Date()
      || token.user.status !== 'ACTIVE') {
    throw new AppError(400, 'INVALID_RESET_TOKEN', 'Password reset link is invalid or expired');
  }
  await prisma.$transaction(async function resetPasswordTransaction(tx) {
    const consumed = await tx.authToken.updateMany({
      where: { id: token.id, type: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!consumed.count) throw new AppError(400, 'INVALID_RESET_TOKEN', 'Password reset link is invalid or expired');
    await tx.user.update({ where: { id: token.userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    await tx.refreshSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordAudit(tx, {
      actorUserId: token.userId,
      action: 'account.password_reset',
      entityType: 'user',
      entityId: token.userId,
      requestId: context.requestId,
      metadata: {},
    });
  });
}

async function login(prisma, data, config) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(data.email) } });
  if (!user || !(await verifyPassword(data.password, user.passwordHash))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (user.status === 'PENDING_VERIFICATION') {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before signing in');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
  }
  const tokens = await issueSession(prisma, user, config);
  return { user: publicUser(user), ...tokens };
}

async function revokeRefreshFamily(prisma, session) {
  await prisma.$transaction(async function revokeFamilyTransaction(tx) {
    await tx.refreshSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAudit(tx, {
      actorUserId: session.userId,
      action: 'auth.refresh_reuse_detected',
      entityType: 'refresh_session_family',
      entityId: session.familyId,
      metadata: {},
    });
  });
}

async function rotateSession(prisma, rawToken, config) {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  const session = await prisma.refreshSession.findUnique({ where: { id: parsed.sessionId }, include: { user: true } });
  if (!session || !refreshSecretMatches(session.tokenHash, parsed.secret)) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
  if (session.revokedAt) {
    await revokeRefreshFamily(prisma, session);
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token reuse was detected; sign in again');
  }
  if (session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }
  const nextSecret = createRefreshSecret();
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
  let rotated;
  try {
    rotated = await prisma.$transaction(async function rotateTransaction(tx) {
      const update = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null, tokenHash: session.tokenHash, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (!update.count) throw new AppError(409, 'REFRESH_ROTATION_RACE', 'Refresh token was already used');
      return tx.refreshSession.create({
        data: { userId: session.userId, familyId: session.familyId, tokenHash: hashRefreshSecret(nextSecret), expiresAt },
      });
    });
  } catch (error) {
    if (error.code === 'REFRESH_ROTATION_RACE') {
      const latestSession = await prisma.refreshSession.findUnique({ where: { id: session.id }, include: { user: true } });
      if (latestSession && latestSession.revokedAt && refreshSecretMatches(latestSession.tokenHash, parsed.secret)) {
        await revokeRefreshFamily(prisma, latestSession);
        throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token reuse was detected; sign in again');
      }
    }
    throw error;
  }
  return {
    user: publicUser(session.user),
    accessToken: createAccessToken(session.user, config.accessSecret, config.accessTtl, rotated.id),
    refreshToken: createRefreshToken(rotated.id, nextSecret),
    refreshExpiresAt: expiresAt,
  };
}

async function revokeSession(prisma, rawToken) {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) return;
  await prisma.refreshSession.updateMany({
    where: { id: parsed.sessionId, tokenHash: hashRefreshSecret(parsed.secret), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

module.exports = {
  register, verifyEmail, resendVerification, requestPasswordReset, resetPassword,
  login, rotateSession, revokeSession, publicUser, slugify,
};
