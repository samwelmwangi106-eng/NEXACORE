const { z } = require('zod');

function validDateOnly(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const dateOnlySchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use an ISO calendar date, for example 2027-01-18')
  .refine(validDateOnly, 'Date must be a real calendar date');

const timeZoneSchema = z.string().trim().min(1).max(80).refine(function supportedTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (error) { return false; }
}, 'Time zone must be a valid IANA time zone');

function nonEmptyPatch(schema) {
  return schema.refine(function hasChanges(value) { return Object.keys(value).length > 0; }, 'Provide at least one field to update');
}

const schoolProfileSchema = nonEmptyPatch(z.object({
  schoolCode: z.union([
    z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).transform(function normalizeCode(value) { return value.toUpperCase(); }),
    z.null(),
  ]).optional(),
  timeZone: timeZoneSchema.optional(),
  weekStartsOn: z.number().int().min(1).max(7).optional(),
}).strict());

const academicYearCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  status: z.enum(['DRAFT', 'ACTIVE']).optional(),
}).strict();

const academicYearUpdateSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(100).optional(),
  startsOn: dateOnlySchema.optional(),
  endsOn: dateOnlySchema.optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional(),
}).strict());

const schoolTermCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sequence: z.number().int().min(1).max(20),
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
}).strict();

const schoolTermUpdateSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sequence: z.number().int().min(1).max(20).optional(),
  startsOn: dateOnlySchema.optional(),
  endsOn: dateOnlySchema.optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED']).optional(),
}).strict());

const gradeLevelCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/).transform(function normalizeCode(value) { return value.toUpperCase(); }),
  sortOrder: z.number().int().min(1).max(1000).optional(),
}).strict();

const gradeLevelUpdateSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(80).optional(),
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/).transform(function normalizeCode(value) { return value.toUpperCase(); }).optional(),
  sortOrder: z.number().int().min(1).max(1000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
}).strict());

const classSectionCreateSchema = z.object({
  gradeLevelId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
}).strict();

const classSectionUpdateSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'CLOSED']).optional(),
}).strict());

module.exports = {
  dateOnlySchema,
  schoolProfileSchema,
  academicYearCreateSchema,
  academicYearUpdateSchema,
  schoolTermCreateSchema,
  schoolTermUpdateSchema,
  gradeLevelCreateSchema,
  gradeLevelUpdateSchema,
  classSectionCreateSchema,
  classSectionUpdateSchema,
};
