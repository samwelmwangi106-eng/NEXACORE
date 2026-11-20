const { z } = require('zod');

const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  roleId: z.string().uuid().optional(),
}).strict();
const acceptInvitationSchema = z.object({ token: z.string().min(40).max(128) }).strict();

module.exports = { createInvitationSchema, acceptInvitationSchema };
