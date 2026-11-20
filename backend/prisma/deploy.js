require('dotenv').config();
const { Pool } = require('pg');
const { loadConfig } = require('../src/config/env');
const { applyMigrations } = require('../src/lib/migrations');

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.migrationDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const migrations = await applyMigrations(client);
    for (const migration of migrations) console.info(`${migration.status}: ${migration.migrationName}`);
    const schema = await client.query("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'");
    console.info(`PostgreSQL schema verified: ${schema.rows[0].tables} application tables`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(function migrationFailed(error) {
  console.error('Database migration deployment failed:', error.message);
  process.exitCode = 1;
});
