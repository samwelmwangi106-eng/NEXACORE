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
const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function schoolApp(industry) {
  const membership = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    organisationId,
    organisation: { id: organisationId, name: 'Tenant', status: 'ACTIVE', industry },
    assignments: [{
      role: {
        name: 'Organisation Owner',
        permissions: [
          { permission: { key: 'school.read' } },
          { permission: { key: 'school.manage' } },
        ],
      },
    }],
  };
  const prisma = {
    refreshSession: { findFirst: async function findFirst() { return { user: { status: 'ACTIVE', tokenVersion: 0 } }; } },
    organisationMember: { findFirst: async function findFirst() { return membership; } },
  };
  return createApp({ prisma, config, logger: { error: function ignore() {} } });
}

function token() {
  return createAccessToken({ id: userId, tokenVersion: 0 }, secret, '1m', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
}

test('the school module is inert for organisations outside the SCHOOL industry', async function inertForOtherIndustries() {
  for (const industry of ['SACCO', 'CLINIC', 'RENTAL']) {
    const app = schoolApp(industry);
    const response = await request(app)
      .get(`/api/v1/organisations/${organisationId}/school/profile`)
      .set('Authorization', `Bearer ${token()}`);
    assert.equal(response.status, 404, `${industry} must not expose the school module`);
    assert.equal(response.body.error.code, 'SCHOOL_MODULE_NOT_ENABLED');
  }
});

test('a SCHOOL organisation reaches the module and its permission check', async function reachesModuleForSchool() {
  const app = schoolApp('SCHOOL');
  const response = await request(app)
    .get(`/api/v1/organisations/${organisationId}/school/profile`)
    .set('Authorization', `Bearer ${token()}`);
  // Past the industry gate: the request now fails on missing data rather than
  // being refused as "module not enabled".
  assert.notEqual(response.body.error && response.body.error.code, 'SCHOOL_MODULE_NOT_ENABLED');
});

test('school routes reject malformed resource identifiers before doing work', async function validateIds() {
  const app = schoolApp('SCHOOL');
  const response = await request(app)
    .get(`/api/v1/organisations/${organisationId}/school/academic-years/not-a-uuid/terms`)
    .set('Authorization', `Bearer ${token()}`);
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_RESOURCE_ID');
});
