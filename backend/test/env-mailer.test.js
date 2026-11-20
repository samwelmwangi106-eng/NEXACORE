const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config/env');
const { createMailer } = require('../src/modules/auth/mailer');

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  JWT_ACCESS_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  WEB_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  MAIL_MODE: 'console',
  EMAIL_OUTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

test('migration connection defaults to DATABASE_URL and can be set separately', function migrationConnectionPolicy() {
  assert.equal(loadConfig(validEnvironment).migrationDatabaseUrl, validEnvironment.DATABASE_URL);
  const direct = 'postgresql://migrator:secret@direct.example.test:5432/nexa';
  assert.equal(loadConfig({ ...validEnvironment, MIGRATION_DATABASE_URL: direct }).migrationDatabaseUrl, direct);
});

test('production refuses insecure cookies and console email transport', function rejectInsecureProduction() {
  assert.throws(function insecureCookies() {
    loadConfig({ ...validEnvironment, NODE_ENV: 'production', COOKIE_SECURE: 'false', MAIL_MODE: 'smtp', SMTP_HOST: 'mail.example.test', MAIL_FROM: 'noreply@example.test' });
  }, /COOKIE_SECURE/);
  assert.throws(function consoleEmail() {
    loadConfig({ ...validEnvironment, NODE_ENV: 'production', COOKIE_SECURE: 'true', MAIL_MODE: 'console' });
  }, /MAIL_MODE/);
});

test('SMTP mode requires host and sender details', function requireSmtpSettings() {
  assert.throws(function missingSmtp() {
    loadConfig({ ...validEnvironment, MAIL_MODE: 'smtp' });
  }, /SMTP_HOST and MAIL_FROM/);
});

test('local console mailer writes only through injected development logger', async function localMailer() {
  const messages = [];
  const mailer = createMailer({ mailMode: 'console', nodeEnv: 'development' }, {
    info: function info(message) { messages.push(message); },
  });
  await mailer.send({ to: 'test@example.test', subject: 'Verify', text: 'One-time link' });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /test@example.test/);
  assert.match(messages[0], /One-time link/);
});

test('console mailer cannot be constructed in production', function noProductionConsoleMailer() {
  assert.throws(function productionConsoleMailer() {
    createMailer({ mailMode: 'console', nodeEnv: 'production' }, console);
  }, /disabled in production/);
});
