require('dotenv').config();
const { PrismaPg } = require('@prisma/adapter-pg');
const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  experimental: { adapter: true },
  engine: 'js',
  adapter: async function createSchemaEngineAdapter() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for Prisma schema-engine operations');
    }
    return new PrismaPg({ connectionString: process.env.DATABASE_URL });
  },
});
