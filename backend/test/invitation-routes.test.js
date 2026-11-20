const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

test('invitation signup validates strong passwords before database access', async function validateInvitationSignup() {
  const app = createApp({
    prisma: {},
    config: {
      accessSecret: 'test-only-secret-that-is-at-least-32-characters',
      accessTtl: '15m',
      refreshTtlDays: 30,
      webOrigin: 'http://localhost:5173',
    },
  });
  const response = await request(app).post('/api/v1/signup').send({
    token: 'x'.repeat(43),
    email: 'invited@example.test',
    password: 'LongPasswordNoDigits',
    firstName: 'Invited',
    lastName: 'Member',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});
