const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

function createPrismaClient(connectionString) {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

module.exports = { createPrismaClient };
