require('dotenv').config();
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/lib/prisma');
const { normalizeEmail } = require('../src/lib/security');
const { PLATFORM_PERMISSIONS } = require('../src/config/platform-permissions');
const { recordAudit } = require('../src/modules/audit/audit.service');

async function main() {
  const config = loadConfig();
  const email = process.env.PLATFORM_BOOTSTRAP_EMAIL;
  if (!email) throw new Error('Set PLATFORM_BOOTSTRAP_EMAIL to an existing verified account');
  const prisma = createPrismaClient(config.databaseUrl);
  await prisma.$connect();
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw new Error('Bootstrap account must exist, be active, and have a verified email');
    }
    await prisma.$transaction(async function bootstrapTransaction(tx) {
      for (const [key, description] of PLATFORM_PERMISSIONS) {
        const permission = await tx.platformPermission.upsert({ where: { key }, create: { key, description }, update: { description } });
        await tx.platformAdminGrant.upsert({
          where: { userId_permissionId: { userId: user.id, permissionId: permission.id } },
          create: { userId: user.id, permissionId: permission.id },
          update: {},
        });
      }
      await recordAudit(tx, {
        actorUserId: null,
        action: 'platform.bootstrap_admin_granted',
        entityType: 'user',
        entityId: user.id,
        metadata: { permissionCount: PLATFORM_PERMISSIONS.length },
      });
    });
    console.info(`Granted initial platform administrator permissions to ${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(function bootstrapFailed(error) {
  console.error('Platform administrator bootstrap failed:', error.message);
  process.exitCode = 1;
});
