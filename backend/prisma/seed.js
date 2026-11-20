require('dotenv').config();
const { createPrismaClient } = require('../src/lib/prisma');
const { PERMISSIONS } = require('../src/config/permissions');

async function main() {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    for (const [key, description] of PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
    }
    console.log(`Seeded ${PERMISSIONS.length} platform permission definitions`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(function seedFailure(error) {
  console.error(error);
  process.exitCode = 1;
});
