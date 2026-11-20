const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

const config = {
  accessSecret: 'test-only-secret-that-is-at-least-32-characters',
  accessTtl: '15m',
  refreshTtlDays: 30,
  cookieSecure: false,
  webOrigin: 'http://localhost:5173',
};

function makeApp() {
  return createApp({ prisma: {}, config, logger: { error: function ignore() {} } });
}

test('health endpoint returns a live status and security headers', async function healthEndpoint() {
  const response = await request(makeApp()).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
  assert.ok(response.headers['x-content-type-options']);
});

test('protected platform routes reject requests without a bearer token', async function protectedRoute() {
  const response = await request(makeApp()).get('/api/v1/me');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHENTICATED');
});

test('unmatched routes return a structured not-found response', async function unmatchedRoute() {
  const response = await request(makeApp()).get('/no-such-route');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('malformed JSON is rejected as a client error', async function malformedJson() {
  const response = await request(makeApp()).post('/api/v1/auth/login')
    .set('Content-Type', 'application/json')
    .send('{bad json');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
  assert.equal(response.body.requestId, response.headers['x-request-id']);
});

test('password reset request has the same accepted response for an unknown account', async function resetRequestDoesNotEnumerateAccounts() {
  const app = createApp({
    prisma: { user: { findUnique: async function findUnique() { return null; } } },
    config,
    mailer: { send: async function send() {} },
    logger: { error: function ignore() {}, warn: function ignore() {} },
  });
  const response = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.test' });
  assert.equal(response.status, 202);
  assert.match(response.body.message, /If an active account matches/);
});

test('password reset email requests are limited per IP and normalized account', async function limitEmailRequests() {
  const app = createApp({
    prisma: { user: { findUnique: async function findUnique() { return null; } } },
    config,
    logger: { error: function ignore() {}, warn: function ignore() {} },
  });
  for (let index = 0; index < 3; index += 1) {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'LIMIT@example.test' }).expect(202);
  }
  const limited = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'limit@example.test' }).expect(429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal(limited.body.requestId, limited.headers['x-request-id']);
});

test('registration validates payloads before attempting database access', async function invalidRegistrationPayload() {
  const response = await request(makeApp()).post('/api/v1/auth/register').send({
    email: 'bad-email', password: 'short', firstName: '', lastName: '', organisationName: 'x', industry: 'OTHER',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});
