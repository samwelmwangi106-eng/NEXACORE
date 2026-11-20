const { z } = require('zod');

const memberCreateSchema = z.object({ email: z.string().email().max(320) }).strict();
const membershipStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']) }).strict();
const membershipRolesSchema = z.object({ roles: z.array(z.string().uuid()).max(30) }).strict();
const roleCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  permissions: z.array(z.string().min(3).max(120)).max(100),
}).strict();
const roleUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  permissions: z.array(z.string().min(3).max(120)).max(100).optional(),
}).strict().refine(function hasChanges(value) { return Object.keys(value).length > 0; }, 'At least one field must be supplied');

module.exports = { memberCreateSchema, membershipStatusSchema, membershipRolesSchema, roleCreateSchema, roleUpdateSchema };
