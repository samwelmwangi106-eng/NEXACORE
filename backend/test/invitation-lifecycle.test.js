const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const request = require('supertest');
const service = require('../src/modules/organisations/invitation.service');

const BASE_CONFIG = {
  accessSecret: 'test-only-secret-that-is-at-least-32-characters',
  accessTtl: '15m',
  refreshTtlDays: 30,
  webOrigin: 'http://localhost:5173',
};

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';

function context() {
  return {
    organisationId: ORG_ID,
    organisationName: 'Test School',
    memberId: MEMBER_ID,
    userId: USER_ID,
    requestId: 'req-test-1',
  };
}

// Builds a transaction double whose organisationInvitation.create throws `error`.
function createInvitationPrisma(error) {
  const enqueued = [];
  const tx = {
    role: {
      findFirst: async function findFirst() {
        return { id: ROLE_ID, permissions: [] };
      },
    },
    memberRole: {
      findMany: async function findMany() {
        return [];
      },
    },
    organisationInvitation: {
      create: async function create() {
        throw error;
      },
    },
    emailOutbox: {
      create: async function create(args) {
        enqueued.push(args);
        return { id: 'outbox-1' };
      },
    },
    auditLog: {
      create: async function create() {
        return { id: 'audit-1' };
      },
    },
  };
  return {
    enqueued,
    user: { findUnique: async function findUnique() { return null; } },
    $transaction: async function transaction(fn) { return fn(tx); },
  };
}

test('duplicate live invitation (Prisma P2002) becomes HTTP 409', async function duplicateInvitationIs409() {
  const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const prisma = createInvitationPrisma(p2002);

  await assert.rejects(
    function run() {
      return service.createInvitation(prisma, BASE_CONFIG, context(), 'Duplicate@Example.Test', ROLE_ID);
    },
    function verify(error) {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'INVITATION_ALREADY_EXISTS');
      return true;
    },
  );
});

test('non-P2002 errors from invitation creation are not masked', async function otherErrorsPropagate() {
  const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const prisma = createInvitationPrisma(boom);

  await assert.rejects(
    function run() {
      return service.createInvitation(prisma, BASE_CONFIG, context(), 'other@example.test', ROLE_ID);
    },
    function verify(error) {
      assert.equal(error.code, 'ECONNRESET');
      assert.notEqual(error.status, 409);
      return true;
    },
  );
});

test('invitation email is normalised before persistence', async function emailIsNormalised() {
  const seen = [];
  const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const prisma = createInvitationPrisma(p2002);
  const original = prisma.$transaction;
  prisma.$transaction = async function transaction(fn) {
    return fn({
      role: { findFirst: async function findFirst() { return { id: ROLE_ID, permissions: [] }; } },
      memberRole: { findMany: async function findMany() { return []; } },
      organisationInvitation: {
        create: async function create(args) {
          seen.push(args.data.email);
          throw p2002;
        },
      },
    });
  };
  assert.ok(original);

  await assert.rejects(function run() {
    return service.createInvitation(prisma, BASE_CONFIG, context(), '  MiXeD@Example.TEST ', ROLE_ID);
  });
  assert.deepEqual(seen, ['mixed@example.test']);
});

// --- Acceptance must be refused when the organisation is not eligible -------

function acceptedLookupPrisma(organisationStatus) {
  const writes = [];
  const invitation = {
    id: '55555555-5555-4555-8555-555555555555',
    organisationId: ORG_ID,
    roleId: ROLE_ID,
    email: 'invitee@example.test',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organisation: organisationStatus === null ? null : { id: ORG_ID, name: 'Test School', status: organisationStatus },
  };
  return {
    writes,
    organisationInvitation: {
      findUnique: async function findUnique() { return invitation; },
      updateMany: async function updateMany() { writes.push('updateMany'); return { count: 1 }; },
    },
    user: { create: async function create() { writes.push('user.create'); return { id: USER_ID, email: invitation.email, firstName: 'I', lastName: 'M', status: 'PENDING_VERIFICATION' }; } },
    organisationMember: { create: async function create() { writes.push('organisationMember.create'); return { id: MEMBER_ID }; } },
    memberRole: { create: async function create() { writes.push('memberRole.create'); return {}; } },
    authToken: { create: async function create() { writes.push('authToken.create'); return {}; } },
    emailOutbox: { create: async function create() { writes.push('emailOutbox.create'); return {}; } },
    auditLog: { create: async function create() { writes.push('auditLog.create'); return {}; } },
    $transaction: async function transaction(fn) { writes.push('$transaction'); return fn(this); },
  };
}

const REGISTRATION = {
  email: 'invitee@example.test',
  passwordHash: 'hashed-password-value',
  firstName: 'Invitee',
  lastName: 'Person',
};

test('acceptance is refused for a SUSPENDED organisation and writes nothing', async function suspendedOrganisationRejected() {
  const prisma = acceptedLookupPrisma('SUSPENDED');

  await assert.rejects(
    function run() { return service.acceptInvitation(prisma, BASE_CONFIG, 'x'.repeat(43), REGISTRATION); },
    function verify(error) {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'ORGANISATION_NOT_ELIGIBLE');
      return true;
    },
  );
  assert.deepEqual(prisma.writes, []);
});

test('acceptance is refused when the organisation relation is missing', async function missingOrganisationRejected() {
  const prisma = acceptedLookupPrisma(null);

  await assert.rejects(
    function run() { return service.acceptInvitation(prisma, BASE_CONFIG, 'x'.repeat(43), REGISTRATION); },
    function verify(error) {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'ORGANISATION_NOT_ELIGIBLE');
      return true;
    },
  );
  assert.deepEqual(prisma.writes, []);
});

// --- Structural / route-level guarantees ------------------------------------

test('suspended organisation acceptance surfaces 403 through the HTTP layer', async function suspendedThroughHttp() {
  const invitation = {
    id: '55555555-5555-4555-8555-555555555555',
    organisationId: ORG_ID,
    roleId: ROLE_ID,
    email: 'invitee@example.test',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organisation: { id: ORG_ID, name: 'Test School', status: 'SUSPENDED' },
  };
  const prisma = acceptedLookupPrisma('SUSPENDED');
  prisma.organisationInvitation.findUnique = async function findUnique() { return invitation; };

  const app = createApp({ prisma, config: BASE_CONFIG });
  const response = await request(app).post('/api/v1/signup').send({
    token: 'x'.repeat(43),
    email: 'invitee@example.test',
    password: 'LongPasswordNoDigits1',
    firstName: 'Invitee',
    lastName: 'Person',
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'ORGANISATION_NOT_ELIGIBLE');
});

test('hostile Accept header cannot force a privileged representation', async function acceptHeaderCannotForceJsonp() {
  const app = createApp({ prisma: {}, config: BASE_CONFIG });
  const response = await request(app)
    .post('/api/v1/signup')
    .set('Accept', 'application/json;q=0.1,text/html;q=0.9')
    .send({ token: 'short', email: 'not-an-email', password: 'weak', firstName: '', lastName: '' });

  assert.equal(response.status, 400);
  assert.match(response.headers['content-type'], /application\/json/);
});
