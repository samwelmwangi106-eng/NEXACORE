const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Client } = require('pg');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
const request = require('supertest');
const { createPrismaClient } = require('../../src/lib/prisma');
const { applyMigrations } = require('../../src/lib/migrations');
const { assertLoopbackTarget } = require('../../test-support/assert-loopback-target');
const { createApp } = require('../../src/app');
const { createOrganisation } = require('../../src/modules/organisations/organisation.service');
const { hashPassword } = require('../../src/lib/security');
const authService = require('../../src/modules/auth/auth.service');
const invitationService = require('../../src/modules/organisations/invitation.service');
const { decryptPayload } = require('../../src/modules/notifications/outbox.crypto');
const platformAdminService = require('../../src/modules/platform/platform-admin.service');

const testPassword = 'Postgres-Integration-Strong-42';
const testConfig = {
  accessSecret: 'integration-secret-value-not-for-production-123456789',
  accessTtl: '10m',
  refreshTtlDays: 14,
  webOrigin: 'http://localhost:5173',
  outboxEncryptionKey: Buffer.alloc(32, 23).toString('base64'),
};

let postgres;
let prisma;
let app;
let connectionString;
let firstUser;
let firstOrganisation;
let secondUser;
let secondOrganisation;
let firstLogin;
let secondLogin;

async function freeTcpPort() {
  const server = net.createServer();
  await new Promise(function listen(resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(function close(resolve, reject) { server.close(function closed(error) { if (error) reject(error); else resolve(); }); });
  return port;
}

async function createActiveUser(email, firstName) {
  const passwordHash = await hashPassword(testPassword);
  return prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName,
      lastName: 'Integration',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
}

test.before(async function startPostgresIntegrationDatabase() {
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexacore-pg-integration-'));
  const port = await freeTcpPort();
  postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'nexacore_test',
    password: 'local-test-only',
    port,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: function ignorePostgresLog() {},
    onError: function reportPostgresError(error) { console.error(error); },
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('nexacore_test');
  connectionString = `postgresql://nexacore_test:local-test-only@127.0.0.1:${port}/nexacore_test`;
  // Refuse to apply migrations unless the spawned cluster is provably loopback and
  // distinct from any ambient DATABASE_URL. Runs before the first connection.
  assertLoopbackTarget(connectionString, 'postgres.integration');
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  try {
    const migrationDirectory = path.join(__dirname, '../../prisma/migrations');
    const expectedMigrations = (await fs.readdir(migrationDirectory, { withFileTypes: true }))
      .filter(function isMigrationDir(entry) { return entry.isDirectory(); })
      .map(function directoryName(entry) { return entry.name; })
      .sort();
    const migrationResults = await applyMigrations(migrationClient, migrationDirectory);
    assert.equal(migrationResults.length, expectedMigrations.length);
    assert.deepEqual(migrationResults.map(function status(item) { return item.status; }), expectedMigrations.map(function applied() { return 'applied'; }));
    assert.deepEqual(migrationResults.map(function identifier(item) { return item.migrationName; }), expectedMigrations);
    const repeatedDeployment = await applyMigrations(migrationClient, migrationDirectory);
    assert.equal(repeatedDeployment.length, expectedMigrations.length);
    assert.deepEqual(repeatedDeployment.map(function status(item) { return item.status; }), expectedMigrations.map(function skipped() { return 'already-applied'; }));
  } finally {
    await migrationClient.end();
  }
  prisma = createPrismaClient(connectionString);
  await prisma.$connect();
  app = createApp({ prisma, config: testConfig });

  firstUser = await createActiveUser(`owner-${Date.now()}@integration.test`, 'Tenant');
  firstOrganisation = await createOrganisation(prisma, firstUser.id, { name: 'Integration Tenant A', industry: 'SCHOOL' }, 'integration-a');
  secondUser = await createActiveUser(`member-${Date.now()}@integration.test`, 'Other');
  secondOrganisation = await createOrganisation(prisma, secondUser.id, { name: 'Integration Tenant B', industry: 'CLINIC' }, 'integration-b');
  firstLogin = await authService.login(prisma, { email: firstUser.email, password: testPassword }, testConfig);
  secondLogin = await authService.login(prisma, { email: secondUser.email, password: testPassword }, testConfig);
});

test.after(async function stopPostgresIntegrationDatabase() {
  if (prisma) await prisma.$disconnect();
  if (postgres) {
    const databaseDir = postgres.databaseDir;
    await postgres.stop();
    if (databaseDir) await fs.rm(databaseDir, { recursive: true, force: true });
  }
});

test('real PostgreSQL supports authentication and immediate token-version revocation', async function authenticationAndRevocation() {
  const accepted = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${firstLogin.accessToken}`).expect(200);
  assert.equal(accepted.body.user.id, firstUser.id);
  assert.equal(accepted.body.user.email, firstUser.email);
  assert.equal(await prisma.refreshSession.count({ where: { userId: firstUser.id, revokedAt: null } }), 1);

  await prisma.user.update({ where: { id: firstUser.id }, data: { tokenVersion: { increment: 1 } } });
  const rejected = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${firstLogin.accessToken}`).expect(401);
  assert.equal(rejected.body.error.code, 'SESSION_REVOKED');
});

test('real PostgreSQL enforces tenant membership and organisation-role permission checks', async function tenantIsolationAndPermissions() {
  await request(app)
    .get(`/api/v1/organisations/${firstOrganisation.id}`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .expect(404);

  const accountant = await prisma.role.findUnique({ where: { organisationId_name: { organisationId: secondOrganisation.id, name: 'Accountant' } } });
  const secondMembership = await prisma.organisationMember.findUnique({ where: { organisationId_userId: { organisationId: secondOrganisation.id, userId: secondUser.id } } });
  await prisma.memberRole.deleteMany({ where: { memberId: secondMembership.id } });
  await prisma.memberRole.create({ data: { organisationId: secondOrganisation.id, memberId: secondMembership.id, roleId: accountant.id } });
  await request(app)
    .get(`/api/v1/organisations/${secondOrganisation.id}/members`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .expect(403);

  const ownerAccess = await authService.login(prisma, { email: firstUser.email, password: testPassword }, testConfig);
  await request(app)
    .get(`/api/v1/organisations/${firstOrganisation.id}`)
    .set('Authorization', `Bearer ${ownerAccess.accessToken}`)
    .expect(200);
});

test('real PostgreSQL composite constraints prevent cross-tenant role assignment and duplicate identity', async function databaseConstraints() {
  await assert.rejects(
    prisma.user.create({ data: { email: firstUser.email, passwordHash: 'not-a-real-login-hash', firstName: 'Duplicate', lastName: 'Email' } }),
    function uniqueConstraint(error) { return error.code === 'P2002'; },
  );
  const firstMembership = await prisma.organisationMember.findUnique({ where: { organisationId_userId: { organisationId: firstOrganisation.id, userId: firstUser.id } } });
  const foreignRole = await prisma.role.findFirst({ where: { organisationId: secondOrganisation.id } });
  await assert.rejects(
    prisma.memberRole.create({ data: { organisationId: firstOrganisation.id, memberId: firstMembership.id, roleId: foreignRole.id } }),
    function foreignKeyConstraint(error) { return error.code === 'P2003'; },
  );
  const schema = await prisma.$queryRawUnsafe("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
  assert.ok(schema[0].tables >= 14);
});

test('real PostgreSQL invitations are encrypted, tenant-bound, expiring, and single-use', async function invitationLifecycle() {
  const membership = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId: firstOrganisation.id, userId: firstUser.id } },
  });
  const created = await invitationService.createInvitation(prisma, testConfig, {
    organisationId: firstOrganisation.id,
    organisationName: firstOrganisation.name,
    memberId: membership.id,
    userId: firstUser.id,
    requestId: 'integration-invitation',
  }, 'invitee@integration.test');
  assert.ok(created.expiresAt.getTime() > Date.now());
  const queued = await prisma.emailOutbox.findFirst({ where: { recipient: 'invitee@integration.test' }, orderBy: { createdAt: 'desc' } });
  const message = decryptPayload(queued.encryptedPayload, testConfig.outboxEncryptionKey);
  const link = new URL(message.text.match(/https?:\/\/[^\s]+/)[0]);
  const invitationToken = link.searchParams.get('token');
  const invitation = await prisma.organisationInvitation.findUnique({ where: { id: created.id } });
  assert.equal(invitation.tokenHash.length, 64);
  assert.notEqual(invitation.tokenHash, invitationToken);

  await assert.rejects(
    invitationService.acceptInvitation(prisma, testConfig, invitationToken, {
      email: 'different@integration.test', passwordHash: await hashPassword(testPassword), firstName: 'Wrong', lastName: 'Email',
    }),
    function rejectEmailMismatch(error) { return error.code === 'INVITATION_EMAIL_MISMATCH'; },
  );
  const accepted = await invitationService.acceptInvitation(prisma, testConfig, invitationToken, {
    email: 'invitee@integration.test', passwordHash: await hashPassword(testPassword), firstName: 'Invited', lastName: 'Member',
  });
  assert.equal(accepted.user.status, 'PENDING_VERIFICATION');
  const membershipCreated = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId: firstOrganisation.id, userId: accepted.user.id } },
    include: { assignments: { include: { role: true } } },
  });
  assert.equal(membershipCreated.assignments[0].role.name, 'Staff Member');
  await assert.rejects(
    invitationService.acceptInvitation(prisma, testConfig, invitationToken, {
      email: 'invitee@integration.test', passwordHash: await hashPassword(testPassword), firstName: 'Again', lastName: 'Attempt',
    }),
    function rejectInvitationReuse(error) { return error.code === 'INVALID_INVITATION'; },
  );

  const expiring = await invitationService.createInvitation(prisma, testConfig, {
    organisationId: firstOrganisation.id,
    organisationName: firstOrganisation.name,
    memberId: membership.id,
    userId: firstUser.id,
    requestId: 'integration-expiry',
  }, 'expired@integration.test');
  const expiringMessage = decryptPayload(
    (await prisma.emailOutbox.findFirst({ where: { recipient: 'expired@integration.test' }, orderBy: { createdAt: 'desc' } })).encryptedPayload,
    testConfig.outboxEncryptionKey,
  );
  const expiringToken = new URL(expiringMessage.text.match(/https?:\/\/[^\s]+/)[0]).searchParams.get('token');
  await prisma.organisationInvitation.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    invitationService.acceptInvitation(prisma, testConfig, expiringToken, {
      email: 'expired@integration.test', passwordHash: await hashPassword(testPassword), firstName: 'Expired', lastName: 'Member',
    }),
    function rejectExpiredInvitation(error) { return error.code === 'INVALID_INVITATION'; },
  );
});

test('organisation administrators do not receive platform-superadmin access', async function platformBoundary() {
  const access = await authService.login(prisma, { email: firstUser.email, password: testPassword }, testConfig);
  const denied = await request(app)
    .get('/api/v1/platform/users')
    .set('Authorization', `Bearer ${access.accessToken}`)
    .expect(403);
  assert.equal(denied.body.error.code, 'PLATFORM_FORBIDDEN');
});

test('platform grants are separate, scoped, and cannot be escalated', async function platformPermissionManagement() {
  const readUsers = await prisma.platformPermission.create({ data: { key: 'platform.users.read', description: 'Read platform users' } });
  const manageOrganisations = await prisma.platformPermission.create({ data: { key: 'platform.organisations.manage', description: 'Manage platform organisations' } });
  await prisma.platformAdminGrant.create({ data: { userId: firstUser.id, permissionId: readUsers.id } });
  await platformAdminService.setPlatformPermissions(prisma, firstUser.id, secondUser.id, ['platform.users.read'], 'integration-platform-grant');
  const delegated = await authService.login(prisma, { email: secondUser.email, password: testPassword }, testConfig);
  await request(app)
    .get('/api/v1/platform/users')
    .set('Authorization', `Bearer ${delegated.accessToken}`)
    .expect(200);
  await assert.rejects(
    platformAdminService.setPlatformPermissions(prisma, firstUser.id, secondUser.id, ['platform.organisations.manage'], 'integration-escalation'),
    function rejectPlatformEscalation(error) { return error.code === 'PLATFORM_PERMISSION_ESCALATION'; },
  );
  assert.equal(await prisma.platformAdminGrant.count({ where: { userId: secondUser.id, permissionId: manageOrganisations.id } }), 0);
});
