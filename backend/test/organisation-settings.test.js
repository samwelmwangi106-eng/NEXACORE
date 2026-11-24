const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSettings, ALLOWED_KEYS } = require('../src/modules/organisations/organisation.settings');

test('settings merge preserves keys the patch does not mention', function mergePreserves() {
  const current = { locale: 'en-KE', timezone: 'Africa/Nairobi', notificationsEnabled: true };
  const merged = mergeSettings(current, { locale: 'sw-KE' });

  assert.equal(merged.locale, 'sw-KE');
  assert.equal(merged.timezone, 'Africa/Nairobi', 'untouched keys must survive a partial patch');
  assert.equal(merged.notificationsEnabled, true);
  assert.equal(current.locale, 'en-KE', 'the stored object must not be mutated in place');
});

test('settings merge treats null as an explicit clear', function mergeClears() {
  const merged = mergeSettings({ locale: 'en', timezone: 'Africa/Nairobi' }, { timezone: null });
  assert.equal(merged.timezone, undefined);
  assert.equal(merged.locale, 'en');
});

test('unknown settings keys are rejected instead of silently stored', function rejectsUnknown() {
  assert.throws(
    function rejectUnknownKey() { mergeSettings({}, { superuserOverride: true }); },
    function isSettingsError(error) {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'SETTINGS_KEY_NOT_ALLOWED');
      return true;
    },
  );
});

test('settings reject values of the wrong type or shape', function rejectsInvalidTypes() {
  const cases = [
    [{ notificationsEnabled: 'yes' }, 'boolean must not accept a string'],
    [{ academicYearStartMonth: 'January' }, 'integer must not accept a word'],
    [{ academicYearStartMonth: 13 }, 'integer must respect its range'],
    [{ locale: 'not a locale!' }, 'pattern must be enforced'],
    [{ brandingAccentColour: 'red' }, 'colour must be a hex value'],
  ];
  for (const [patch, reason] of cases) {
    assert.throws(
      function invalidValue() { mergeSettings({}, patch); },
      function isSettingsValueError(error) {
        assert.equal(error.code, 'SETTINGS_VALUE_INVALID');
        return true;
      },
      reason,
    );
  }
});

test('settings reject a non-object payload', function rejectsNonObject() {
  for (const bad of [[], 'string', 42, true]) {
    assert.throws(function invalidShape() { mergeSettings({}, bad); }, /Settings must be an object/);
  }
});

test('accepts every documented allowlisted key', function acceptsAllowlist() {
  const patch = {
    locale: 'en-KE',
    timezone: 'Africa/Nairobi',
    currency: 'KES',
    dateFormat: 'DD/MM/YYYY',
    academicYearStartMonth: 1,
    notificationsEnabled: false,
    brandingAccentColour: '#1a2b3c',
  };
  const merged = mergeSettings({}, patch);
  assert.deepEqual(merged, patch);
  assert.deepEqual(Object.keys(patch).sort(), ALLOWED_KEYS.slice().sort());
});

test('a partial patch cannot be used to smuggle an unlisted key alongside a valid one', function noSmuggling() {
  assert.throws(
    function smuggle() { mergeSettings({ locale: 'en' }, { locale: 'fr', isPlatformAdmin: true }); },
    /Unknown organisation setting/,
  );
});

test('prototype-polluting keys are rejected and cannot reach Object.prototype', function rejectsPrototypePollution() {
  const before = Object.prototype.polluted;
  const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}, "locale": "en"}');
  assert.throws(
    function run() { mergeSettings({}, malicious); },
    function verify(error) {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'SETTINGS_KEY_NOT_ALLOWED');
      return true;
    },
  );
  assert.equal(Object.prototype.polluted, before);
  assert.equal({}.polluted, undefined);
});

test('settings keys are matched exactly and by own-property only', function exactOwnPropertyKeys() {
  // A patch key such as "constructor" or "toString" is inherited from Object.prototype
  // but must still be treated as unknown.
  assert.throws(
    function run() { mergeSettings({}, JSON.parse('{"constructor": "x"}')); },
    function verify(error) {
      assert.equal(error.code, 'SETTINGS_KEY_NOT_ALLOWED');
      return true;
    },
  );
  assert.throws(
    function run() { mergeSettings({}, JSON.parse('{"toString": "x"}')); },
    function verify(error) {
      assert.equal(error.code, 'SETTINGS_KEY_NOT_ALLOWED');
      return true;
    },
  );
});

test('stored settings that are not an object are discarded rather than spread', function nonObjectStoredValue() {
  for (const stored of [null, undefined, 'a string', 42, ['an', 'array']]) {
    const result = mergeSettings(stored, { locale: 'en' });
    assert.deepEqual(result, { locale: 'en' });
  }
});

test('an empty patch leaves stored settings untouched', function emptyPatchIsNoop() {
  const stored = { locale: 'en-KE', timezone: 'Africa/Nairobi' };
  assert.deepEqual(mergeSettings(stored, {}), stored);
});

test('mergeSettings does not mutate the caller-supplied current object', function noMutation() {
  const stored = { locale: 'en-KE', timezone: 'Africa/Nairobi' };
  const snapshot = JSON.stringify(stored);
  const merged = mergeSettings(stored, { locale: 'fr', currency: 'KES' });
  assert.equal(JSON.stringify(stored), snapshot);
  assert.equal(merged.locale, 'fr');
  assert.equal(merged.currency, 'KES');
  assert.equal(merged.timezone, 'Africa/Nairobi');
  assert.notEqual(merged, stored);
});

test('values near the validation boundary behave as documented', function boundaryValues() {
  // Integer range endpoints are inclusive.
  assert.equal(mergeSettings({}, { academicYearStartMonth: 1 }).academicYearStartMonth, 1);
  assert.equal(mergeSettings({}, { academicYearStartMonth: 12 }).academicYearStartMonth, 12);
  for (const bad of [0, 13, 1.5, '3', null]) {
    if (bad === null) {
      // null is a documented clear, not an error.
      assert.deepEqual(mergeSettings({}, { academicYearStartMonth: null }), {});
      continue;
    }
    assert.throws(function run() { mergeSettings({}, { academicYearStartMonth: bad }); },
      function verify(error) { return error.code === 'SETTINGS_VALUE_INVALID'; });
  }
  // A 200-character string is allowed; 201 is not.
  assert.equal(mergeSettings({}, { timezone: 'A'.repeat(200) }).timezone.length, 200);
  assert.throws(function run() { mergeSettings({}, { timezone: 'A'.repeat(201) }); },
    function verify(error) { return error.code === 'SETTINGS_VALUE_INVALID'; });
});

test('security-sensitive organisation fields are not reachable as settings', function sensitiveFieldsRejected() {
  for (const key of ['status', 'industry', 'slug', 'id', 'createdAt', 'plan', 'isPlatformAdmin']) {
    assert.throws(function run() { mergeSettings({}, { [key]: 'ACTIVE' }); },
      function verify(error) { return error.code === 'SETTINGS_KEY_NOT_ALLOWED'; },
      `expected ${key} to be rejected`);
  }
});

// --- API layer: organisation isolation and authorisation --------------------

const request = require('supertest');
const { createApp } = require('../src/app');
const { createAccessToken } = require('../src/lib/security');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

const CONFIG = {
  accessSecret: 'test-only-secret-that-is-at-least-32-characters',
  accessTtl: '15m',
  refreshTtlDays: 30,
  webOrigin: 'http://localhost:5173',
};

// Minimal tenant double: membership resolves only for ORG_A, and gives the
// actor exactly the permissions passed in.
function tenantPrisma(options) {
  const opts = options || {};
  const writes = [];
  return {
    writes,
    refreshSession: {
      findFirst: async function findFirst() {
        return { id: '99999999-9999-4999-8999-999999999999', user: { status: 'ACTIVE', tokenVersion: 0 } };
      },
    },
    organisationMember: {
      findFirst: async function findFirst(args) {
        if (args.where.organisationId !== ORG_A) return null;
        return {
          id: '44444444-4444-4444-8444-444444444444',
          organisationId: ORG_A,
          organisation: { id: ORG_A, name: 'Org A', slug: 'org-a', industry: 'SCHOOL', status: 'ACTIVE', settings: {} },
          assignments: [
            {
              role: {
                name: 'Owner',
                permissions: (opts.permissions || ['organisation.read', 'organisation.update']).map(function toPermission(key) {
                  return { permission: { key } };
                }),
              },
            },
          ],
        };
      },
    },
    $transaction: async function transaction(fn) {
      const tx = {
        organisation: {
          findUnique: async function findUnique() {
            return { settings: { locale: 'en-KE', timezone: 'Africa/Nairobi' } };
          },
          update: async function update(args) {
            writes.push(args);
            return { id: args.where.id, ...args.data };
          },
        },
        auditLog: { create: async function create(args) { writes.push({ audit: args }); return {}; } },
      };
      return fn(tx);
    },
  };
}

function appWith(prisma) {
  return createApp({ prisma, config: CONFIG });
}

function bearer() {
  return `Bearer ${createAccessToken({ id: ACTOR, tokenVersion: 0 }, CONFIG.accessSecret, '1m', '88888888-8888-4888-8888-888888888888')}`;
}

test('settings PATCH writes only allowlisted columns for its own organisation', async function writesOnlyPermittedColumns() {
  const prisma = tenantPrisma();
  const response = await request(appWith(prisma))
    .patch(`/api/v1/organisations/${ORG_A}`)
    .set('Authorization', bearer())
    .send({ settings: { locale: 'fr' } });

  assert.equal(response.status, 200);
  const update = prisma.writes.find(function isUpdate(w) { return w && w.where; });
  assert.ok(update, 'expected an organisation.update call');
  assert.equal(update.where.id, ORG_A);
  // Only `settings` may be written when only settings were sent.
  assert.deepEqual(Object.keys(update.data), ['settings']);
  // Merge semantics preserved the untouched key.
  assert.equal(update.data.settings.locale, 'fr');
  assert.equal(update.data.settings.timezone, 'Africa/Nairobi');
});

test('a PATCH cannot reach another organisation', async function cannotCrossTenant() {
  const prisma = tenantPrisma();
  const response = await request(appWith(prisma))
    .patch(`/api/v1/organisations/${ORG_B}`)
    .set('Authorization', bearer())
    .send({ settings: { locale: 'fr' } });

  // The tenant guard resolves membership against the URL organisation only.
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'ORGANISATION_NOT_FOUND');
  assert.equal(prisma.writes.length, 0);
});

test('security-sensitive columns are rejected at the schema boundary', async function sensitiveColumnsRejected() {
  for (const payload of [
    { status: 'SUSPENDED' },
    { industry: 'SACCO' },
    { slug: 'taken-slug' },
    { settings: { locale: 'en' }, status: 'SUSPENDED' },
  ]) {
    const prisma = tenantPrisma();
    const response = await request(appWith(prisma))
      .patch(`/api/v1/organisations/${ORG_A}`)
      .set('Authorization', bearer())
      .send(payload);
    assert.equal(response.status, 400, `payload ${JSON.stringify(payload)} must be rejected`);
    assert.equal(prisma.writes.length, 0);
  }
});

test('an actor without organisation.update is forbidden from writing settings', async function authorisationEnforced() {
  const prisma = tenantPrisma({ permissions: ['organisation.read'] });
  const response = await request(appWith(prisma))
    .patch(`/api/v1/organisations/${ORG_A}`)
    .set('Authorization', bearer())
    .send({ settings: { locale: 'fr' } });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.equal(prisma.writes.length, 0);
});

test('unknown settings keys are rejected before any write occurs', async function unknownKeyNoWrite() {
  const prisma = tenantPrisma();
  const response = await request(appWith(prisma))
    .patch(`/api/v1/organisations/${ORG_A}`)
    .set('Authorization', bearer())
    .send({ settings: { isPlatformAdmin: true } });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'SETTINGS_KEY_NOT_ALLOWED');
  assert.equal(prisma.writes.length, 0);
});
