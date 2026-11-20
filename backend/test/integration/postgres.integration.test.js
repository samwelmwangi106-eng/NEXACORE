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
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  try {
    const migrationDirectory = path.join(__dirname, '../../prisma/migrations');
    const migrationResults = await applyMigrations(migrationClient, migrationDirectory);
    assert.deepEqual(migrationResults.map(function status(item) { return item.status; }), ['applied', 'applied', 'applied', 'applied']);
    const repeatedDeployment = await applyMigrations(migrationClient, migrationDirectory);
    assert.deepEqual(repeatedDeployment.map(function status(item) { return item.status; }), ['already-applied', 'already-applied', 'already-applied', 'already-applied']);
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
  await assert.rejects(
    invitationService.createInvitation(prisma, testConfig, {
      organisationId: firstOrganisation.id, organisationName: firstOrganisation.name, memberId: membership.id,
      userId: firstUser.id, requestId: 'integration-duplicate-invitation',
    }, 'invitee@integration.test'),
    function duplicateInvitation(error) { return error.code === 'INVITATION_ALREADY_PENDING'; },
  );
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
  assert.equal(membershipCreated.status, 'INVITED');
  const verificationOutbox = await prisma.emailOutbox.findFirst({ where: { recipient: 'invitee@integration.test' }, orderBy: { createdAt: 'desc' } });
  const verificationMessage = decryptPayload(verificationOutbox.encryptedPayload, testConfig.outboxEncryptionKey);
  const verificationToken = new URL(verificationMessage.text.trim().split(/\s+/).pop()).searchParams.get('token');
  await authService.verifyEmail(prisma, verificationToken, testConfig);
  const activatedMembership = await prisma.organisationMember.findUnique({ where: { id: membershipCreated.id } });
  assert.equal(activatedMembership.status, 'ACTIVE');
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

test('School foundation persists tenant-scoped profiles, calendars, grade levels, and sections', async function schoolFoundation() {
  const owner = await authService.login(prisma, { email: firstUser.email, password: testPassword }, testConfig);
  const authorization = `Bearer ${owner.accessToken}`;
  const rolesResponse = await request(app)
    .get(`/api/v1/organisations/${firstOrganisation.id}/roles`)
    .set('Authorization', authorization)
    .expect(200);
  assert.ok(rolesResponse.body.roles.find(function manager(role) { return role.name === 'Manager'; }).permissions.includes('roles.read'));
  assert.ok(rolesResponse.body.roles.find(function manager(role) { return role.name === 'Manager'; }).permissions.includes('school.manage'));
  assert.equal(rolesResponse.body.roles.find(function manager(role) { return role.name === 'Manager'; }).permissions.includes('clinic.manage'), false);
  const profileResponse = await request(app)
    .put(`/api/v1/organisations/${firstOrganisation.id}/school/profile`)
    .set('Authorization', authorization)
    .send({ schoolCode: 'nexa-001', timeZone: 'Africa/Nairobi', weekStartsOn: 1 })
    .expect(200);
  assert.equal(profileResponse.body.profile.schoolCode, 'NEXA-001');
  assert.equal(profileResponse.body.profile.timeZone, 'Africa/Nairobi');

  const yearResponse = await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years`)
    .set('Authorization', authorization)
    .send({ name: 'Academic Year 2027', startsOn: '2027-01-01', endsOn: '2028-01-01' })
    .expect(201);
  const academicYearId = yearResponse.body.academicYear.id;
  await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years`)
    .set('Authorization', authorization)
    .send({ name: 'Overlapping Year', startsOn: '2027-12-01', endsOn: '2028-12-01' })
    .expect(409)
    .expect(function overlapError(response) { assert.equal(response.body.error.code, 'ACADEMIC_YEAR_OVERLAP'); });

  const firstTerm = await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/terms`)
    .set('Authorization', authorization)
    .send({ name: 'Term 1', sequence: 1, startsOn: '2027-01-01', endsOn: '2027-05-01' })
    .expect(201);
  const firstTermId = firstTerm.body.term.id;
  await request(app)
    .patch(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/terms/${firstTermId}`)
    .set('Authorization', authorization)
    .send({ status: 'ACTIVE' })
    .expect(409)
    .expect(function inactiveYearError(response) { assert.equal(response.body.error.code, 'ACADEMIC_YEAR_NOT_ACTIVE'); });
  await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/terms`)
    .set('Authorization', authorization)
    .send({ name: 'Overlapping Term', sequence: 2, startsOn: '2027-04-15', endsOn: '2027-06-01' })
    .expect(409)
    .expect(function termOverlapError(response) { assert.equal(response.body.error.code, 'SCHOOL_TERM_OVERLAP'); });

  await request(app)
    .patch(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}`)
    .set('Authorization', authorization)
    .send({ status: 'ACTIVE' })
    .expect(200);
  await request(app)
    .patch(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/terms/${firstTermId}`)
    .set('Authorization', authorization)
    .send({ status: 'ACTIVE' })
    .expect(200);
  const termTwo = await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/terms`)
    .set('Authorization', authorization)
    .send({ name: 'Term 2', sequence: 2, startsOn: '2027-05-01', endsOn: '2027-09-01' })
    .expect(201);
  assert.equal(termTwo.body.term.status, 'PLANNED');

  const grade = await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/grade-levels`)
    .set('Authorization', authorization)
    .send({ name: 'Grade One', code: 'g1', sortOrder: 1 })
    .expect(201);
  assert.equal(grade.body.gradeLevel.code, 'G1');
  const section = await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/sections`)
    .set('Authorization', authorization)
    .send({ gradeLevelId: grade.body.gradeLevel.id, name: 'Blue' })
    .expect(201);
  assert.equal(section.body.section.status, 'PLANNED');
  await request(app)
    .patch(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}/sections/${section.body.section.id}`)
    .set('Authorization', authorization)
    .send({ status: 'ACTIVE' })
    .expect(200);
  await request(app)
    .patch(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years/${academicYearId}`)
    .set('Authorization', authorization)
    .send({ status: 'CLOSED' })
    .expect(409);

  await request(app)
    .get(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .expect(404);
  await request(app)
    .get(`/api/v1/organisations/${secondOrganisation.id}/school/profile`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .expect(404)
    .expect(function schoolModuleDisabled(response) { assert.equal(response.body.error.code, 'SCHOOL_MODULE_NOT_ENABLED'); });

  const foreignGrade = await prisma.schoolGradeLevel.create({
    data: { organisationId: secondOrganisation.id, name: 'Clinic Grade', code: 'CG1' },
  });
  await assert.rejects(
    prisma.schoolClassSection.create({
      data: { organisationId: firstOrganisation.id, academicYearId, gradeLevelId: foreignGrade.id, name: 'Cross-tenant' },
    }),
    function schoolCompositeForeignKey(error) { return error.code === 'P2003'; },
  );

  const schoolPermission = await prisma.permission.findUnique({ where: { key: 'school.read' } });
  const readerMembership = await prisma.organisationMember.create({
    data: { organisationId: firstOrganisation.id, userId: secondUser.id, status: 'ACTIVE' },
  });
  const readerRole = await prisma.role.create({
    data: { organisationId: firstOrganisation.id, name: 'School Reader' },
  });
  await prisma.rolePermission.create({ data: { roleId: readerRole.id, permissionId: schoolPermission.id } });
  await prisma.memberRole.create({
    data: { organisationId: firstOrganisation.id, memberId: readerMembership.id, roleId: readerRole.id },
  });
  await request(app)
    .get(`/api/v1/organisations/${firstOrganisation.id}/school/academic-years`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .expect(200);
  await request(app)
    .post(`/api/v1/organisations/${firstOrganisation.id}/school/grade-levels`)
    .set('Authorization', `Bearer ${secondLogin.accessToken}`)
    .send({ name: 'Unauthorized Grade', code: 'UG1' })
    .expect(403);

  const schoolAuditCount = await prisma.auditLog.count({ where: { organisationId: firstOrganisation.id, action: { startsWith: 'school.' } } });
  assert.ok(schoolAuditCount >= 7);
});

test('a platform suspension cannot remove an organisation’s final usable owner', async function preserveUsableOwner() {
  await assert.rejects(
    platformAdminService.changeUserStatus(prisma, firstUser.id, firstUser.id, 'SUSPENDED', 'integration-last-owner'),
    function lastOwner(error) { return error.code === 'LAST_OWNER_REQUIRED'; },
  );
  const stillActive = await prisma.user.findUnique({ where: { id: firstUser.id } });
  assert.equal(stillActive.status, 'ACTIVE');
});

test('concurrent platform suspensions preserve at least one usable organisation owner', async function concurrentOwnerSuspensions() {
  const ownerA = await createActiveUser(`owner-a-${Date.now()}@integration.test`, 'Owner A');
  const ownerB = await createActiveUser(`owner-b-${Date.now()}@integration.test`, 'Owner B');
  const organisation = await createOrganisation(prisma, ownerA.id, { name: `Concurrent Owner Tenant ${Date.now()}`, industry: 'RENTAL' }, 'concurrent-owner-tenant');
  const membershipB = await prisma.organisationMember.create({ data: { organisationId: organisation.id, userId: ownerB.id, status: 'ACTIVE' } });
  const ownerRole = await prisma.role.findUnique({ where: { organisationId_name: { organisationId: organisation.id, name: 'Organisation Owner' } } });
  await prisma.memberRole.create({ data: { organisationId: organisation.id, memberId: membershipB.id, roleId: ownerRole.id } });

  await Promise.allSettled([
    platformAdminService.changeUserStatus(prisma, ownerA.id, ownerA.id, 'SUSPENDED', 'concurrent-owner-a'),
    platformAdminService.changeUserStatus(prisma, ownerB.id, ownerB.id, 'SUSPENDED', 'concurrent-owner-b'),
  ]);
  const remainingUsableOwners = await prisma.user.count({
    where: { id: { in: [ownerA.id, ownerB.id] }, status: 'ACTIVE', emailVerifiedAt: { not: null } },
  });
  assert.ok(remainingUsableOwners >= 1);
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
  const unverifiedTarget = await prisma.user.create({
    data: {
      email: `unverified-${Date.now()}@integration.test`,
      passwordHash: await hashPassword(testPassword),
      firstName: 'Unverified',
      lastName: 'Target',
      status: 'PENDING_VERIFICATION',
    },
  });
  await assert.rejects(
    platformAdminService.setPlatformPermissions(prisma, firstUser.id, unverifiedTarget.id, ['platform.users.read'], 'integration-ineligible-target'),
    function rejectIneligibleTarget(error) { return error.code === 'PLATFORM_TARGET_INELIGIBLE'; },
  );
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
