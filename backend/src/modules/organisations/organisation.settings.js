const { AppError } = require('../../lib/errors');

/**
 * Organisation settings are a JSONB bag owned by the tenant, but they are not
 * free-form. Only allowlisted keys may be written, each with an explicit type
 * so a malformed value cannot corrupt the row for every reader.
 *
 * Add a key here before exposing it through the API — unknown keys are rejected
 * rather than silently stored.
 */
const SETTINGS_ALLOWLIST = Object.freeze({
  locale: { type: 'string', pattern: /^[a-z]{2}(-[A-Z]{2})?$/, description: 'Preferred language tag, e.g. en or en-KE' },
  timezone: { type: 'string', pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/, description: 'IANA timezone, e.g. Africa/Nairobi' },
  currency: { type: 'string', pattern: /^[A-Z]{3}$/, description: 'ISO 4217 currency code' },
  dateFormat: { type: 'string', pattern: /^(YYYY-MM-DD|DD\/MM\/YYYY|MM\/DD\/YYYY)$/, description: 'Display date format' },
  academicYearStartMonth: { type: 'integer', min: 1, max: 12, description: 'First month of the academic year' },
  notificationsEnabled: { type: 'boolean', description: 'Whether outbound email notifications are enabled' },
  brandingAccentColour: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/, description: 'Hex accent colour for tenant branding' },
});

const ALLOWED_KEYS = Object.keys(SETTINGS_ALLOWLIST);

function validateSettingValue(key, value) {
  const rule = SETTINGS_ALLOWLIST[key];
  if (!rule) {
    throw new AppError(400, 'SETTINGS_KEY_NOT_ALLOWED', `Setting "${key}" is not an allowed organisation setting`);
  }
  if (rule.type === 'string') {
    if (typeof value !== 'string') {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" must be a string`);
    }
    if (value.length > 200) {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" is too long`);
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" has an invalid format`);
    }
    return value;
  }
  if (rule.type === 'integer') {
    if (!Number.isInteger(value)) {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" must be an integer`);
    }
    if (value < rule.min || value > rule.max) {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" must be between ${rule.min} and ${rule.max}`);
    }
    return value;
  }
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" must be a boolean`);
    }
    return value;
  }
  throw new AppError(400, 'SETTINGS_VALUE_INVALID', `Setting "${key}" has no validator`);
}

/**
 * Validate an incoming settings patch and merge it over the stored settings.
 *
 * Merge (not replace) semantics: a PATCH that omits a key must not silently wipe
 * the tenant's other settings. A key explicitly set to null is treated as a
 * request to clear it, which keeps removal intentional and auditable.
 */
function mergeSettings(current, patch) {
  if (patch === undefined) return undefined;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError(400, 'SETTINGS_INVALID', 'Settings must be an object');
  }

  const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const unknownKeys = Object.keys(patch).filter(function notAllowed(key) {
    return !Object.prototype.hasOwnProperty.call(SETTINGS_ALLOWLIST, key);
  });
  if (unknownKeys.length) {
    throw new AppError(400, 'SETTINGS_KEY_NOT_ALLOWED', `Unknown organisation setting(s): ${unknownKeys.join(', ')}`);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = validateSettingValue(key, value);
  }
  return base;
}

module.exports = { SETTINGS_ALLOWLIST, ALLOWED_KEYS, mergeSettings, validateSettingValue };
