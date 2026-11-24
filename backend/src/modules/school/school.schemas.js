const { z } = require('zod');

const schoolProfileSchema = z.object({
  schoolCode: z.string().max(40).optional(),
  timeZone: z.string().max(80).optional(),
  weekStartsOn: z.number().int().min(1).max(7).optional(),
});

const academicYearCreateSchema = z.object({
  name: z.string().min(1).max(100),
  startsOn: z.date(),
  endsOn: z.date(),
  status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional().default('DRAFT'),
});

const academicYearUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  startsOn: z.date().optional(),
  endsOn: z.date().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional(),
});

const schoolTermCreateSchema = z.object({
  name: z.string().min(1).max(80),
  sequence: z.number().int().min(1),
  startsOn: z.date(),
  endsOn: z.date(),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED']).optional().default('PLANNED'),
});

const schoolTermUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  sequence: z.number().int().min(1).optional(),
  startsOn: z.date().optional(),
  endsOn: z.date().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED']).optional(),
});

const gradeLevelCreateSchema = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(20),
  sortOrder: z.number().int().min(1).optional().default(1),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
});

const gradeLevelUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  code: z.string().min(1).max(20).optional(),
  sortOrder: z.number().int().min(1).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const classSectionCreateSchema = z.object({
  name: z.string().min(1).max(80),
  gradeLevelId: z.string().uuid(),
  status: z.enum(['PLANNED', 'ACTIVE', 'CLOSED']).optional().default('PLANNED'),
});

const classSectionUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  gradeLevelId: z.string().uuid().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'CLOSED']).optional(),
});

module.exports = {
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