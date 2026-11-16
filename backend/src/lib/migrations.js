const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATION_LOCK_ID = '785320260316';

async function applyMigrations(client, migrationsDirectory) {
  const directory = migrationsDirectory || path.join(process.cwd(), 'prisma', 'migrations');
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" VARCHAR(36) NOT NULL PRIMARY KEY,
        "checksum" VARCHAR(64) NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" VARCHAR(255) NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )
    `);
    const directories = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(function directoryEntry(entry) { return entry.isDirectory(); })
      .map(function migrationName(entry) { return entry.name; })
      .sort();
    const applied = await client.query('SELECT "migration_name", "checksum", "finished_at", "rolled_back_at" FROM "_prisma_migrations"');
    const appliedByName = new Map(applied.rows.map(function migrationRow(row) { return [row.migration_name, row]; }));
    const results = [];

    for (const migrationName of directories) {
      const migrationFile = path.join(directory, migrationName, 'migration.sql');
      let sql;
      try { sql = await fs.readFile(migrationFile, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = appliedByName.get(migrationName);
      if (existing && existing.finished_at && !existing.rolled_back_at) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${migrationName} has changed; restore its original SQL or create a new migration`);
        results.push({ migrationName, status: 'already-applied' });
        continue;
      }
      if (existing && !existing.rolled_back_at) {
        throw new Error(`Migration ${migrationName} has an unfinished database record; inspect and resolve it before retrying`);
      }

      const migrationId = crypto.randomUUID();
      await client.query('BEGIN');
      try {
        await client.query(
          'INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at") VALUES ($1, $2, $3, now())',
          [migrationId, checksum, migrationName],
        );
        await client.query(sql);
        await client.query(
          'UPDATE "_prisma_migrations" SET "finished_at" = now(), "applied_steps_count" = 1 WHERE "id" = $1',
          [migrationId],
        );
        await client.query('COMMIT');
        results.push({ migrationName, status: 'applied' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migrationName} failed: ${error.message}`, { cause: error });
      }
    }
    return results;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
  }
}

module.exports = { applyMigrations };
