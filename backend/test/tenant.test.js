const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createAccessToken } = require('../src/lib/security');

const secret = 'test-only-secret-that-is-at-least-32-characters';
const config = {
  accessSecret: secret,
  accessTtl: '15m',
  refreshTtlDays: 30,
  cookieSecure: false,
  webOrigin: 'http://localhost:5173',
};
const userId = '11111111-1111-4111-8111-111111111111';
const organisationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organisationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeMembership(organisationId) {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    organisationId,
    organisation: { id: organisationId, name: 'Tenant workspace', status: 'ACTIVE', industry: 'SCHOOL' },
    assignments: [{ role: { permissions: [{ permission: { key: 'organisation.read' } }] } }],
  };
}

function authorizedRequest(app, organisationId) {
  const token = createAccessToken({ id: userId, tokenVersion: 0 }, secret, '1m', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  return request(app).get(`/api/v1/organisations/${organisationId}`)
    .set('Authorization', `Bearer ${token}`);
}

test('tenant middleware scopes membership lookup to both user and requested organisation', async function tenantScope() {
  const lookups = [];
  const prisma = {
    refreshSession: { findFirst: async function findFirst() { return { user: { status: 'ACTIVE', tokenVersion: 0 } }; } },
    organisationMember: {
      findFirst: async function findFirst(args) {
        lookups.push(args.where);
        return args.where.organisationId === organisationA ? fakeMembership(organisationA) : null;
      },
    },
  };
  const app = createApp({ prisma, config, logger: { error: function ignore() {} } });
  const ownTenant = await authorizedRequest(app, organisationA);
  const otherTenant = await authorizedRequest(app, organisationB);

  assert.equal(ownTenant.status, 200);
  assert.equal(ownTenant.body.organisation.id, organisationA);
  assert.equal(otherTenant.status, 404);
  assert.equal(otherTenant.body.error.code, 'ORGANISATION_NOT_FOUND');
  assert.equal(lookups.length, 2);
  assert.deepEqual(lookups.map(function scopedWhere(where) {
    return { userId: where.userId, organisationId: where.organisationId, status: where.status };
  }), [
    { userId, organisationId: organisationA, status: 'ACTIVE' },
    { userId, organisationId: organisationB, status: 'ACTIVE' },
  ]);
});

test('tenant routes enforce permission checks on the backend', async function backendPermissionCheck() {
  let memberListQueried = false;
  const prisma = {
    refreshSession: { findFirst: async function findFirst() { return { user: { status: 'ACTIVE', tokenVersion: 0 } }; } },
    organisationMember: {
      findFirst: async function findFirst() { return fakeMembership(organisationA); },
      findMany: async function findMany() { memberListQueried = true; return []; },
    },
  };
  const app = createApp({ prisma, config, logger: { error: function ignore() {} } });
  const token = createAccessToken({ id: userId, tokenVersion: 0 }, secret, '1m', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const response = await request(app).get(`/api/v1/organisations/${organisationA}/members`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.equal(memberListQueried, false);
});

test('invalid organisation identifiers are rejected before querying tenant data', async function invalidOrganisationId() {
  let membershipQueried = false;
  const prisma = {
    refreshSession: { findFirst: async function findFirst() { return { user: { status: 'ACTIVE', tokenVersion: 0 } }; } },
    organisationMember: { findFirst: async function findFirst() { membershipQueried = true; return null; } },
  };
  const app = createApp({ prisma, config, logger: { error: function ignore() {} } });
  const response = await authorizedRequest(app, 'not-a-uuid');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_ORGANISATION_ID');
  assert.equal(membershipQueried, false);
});

test('inactive users are rejected even if their access token has not expired', async function inactiveAccount() {
  const prisma = {
    refreshSession: { findFirst: async function findFirst() { return { user: { status: 'SUSPENDED', tokenVersion: 0 } }; } },
  };
  const app = createApp({ prisma, config, logger: { error: function ignore() {} } });
  const token = createAccessToken({ id: userId, tokenVersion: 0 }, secret, '1m', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const response = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'ACCOUNT_INACTIVE');
});
