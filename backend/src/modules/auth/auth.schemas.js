const { z } = require('zod');
const { passwordSchema } = require('../../lib/security');

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  organisationName: z.string().trim().min(2).max(180),
  industry: z.enum(['SCHOOL', 'SACCO', 'CLINIC', 'RENTAL']),
}).strict();

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128) }).strict();
const emailSchema = z.object({ email: z.string().email().max(320) }).strict();
const tokenSchema = z.object({ token: z.string().min(40).max(128) }).strict();
const resetPasswordSchema = tokenSchema.extend({ password: passwordSchema }).strict();

module.exports = { registerSchema, loginSchema, emailSchema, tokenSchema, resetPasswordSchema };
