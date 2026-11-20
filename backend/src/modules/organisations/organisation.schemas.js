const { z } = require('zod');

function isIanaTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const commonSettingsSchema = z.object({
  timeZone: z.string().trim().min(1).max(80).refine(isIanaTimeZone, 'Must be a valid IANA time zone').optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
}).strict();

const organisationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(180).optional(),
  settings: commonSettingsSchema.optional(),
}).strict().refine(function hasChanges(value) { return Object.keys(value).length > 0; }, 'At least one field must be supplied');

module.exports = { commonSettingsSchema, organisationUpdateSchema, isIanaTimeZone };
