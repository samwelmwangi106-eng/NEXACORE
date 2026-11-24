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
