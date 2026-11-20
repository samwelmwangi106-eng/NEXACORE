const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATION_LOCK_ID = '785320260316';

async function applyMigrations(client, migrationsDirectory) {
  const directory = migrationsDirectory || path.join(process.cwd(), 'prisma', 'migrations');
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
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
    const applied = await client.query('SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "started_at" FROM "_prisma_migrations" ORDER BY "started_at" ASC');
    const directoryNames = new Set(directories);
    const appliedByName = new Map();
    for (const row of applied.rows) {
      if (row.rolled_back_at) continue;
      if (!directoryNames.has(row.migration_name)) {
        throw new Error(`Applied migration ${row.migration_name} is missing from ${directory}; restore the migration file before deploying`);
      }
      if (appliedByName.has(row.migration_name)) {
        throw new Error(`Migration ${row.migration_name} has multiple non-rolled-back history records; inspect database history before deploying`);
      }
      appliedByName.set(row.migration_name, row);
    }
    const results = [];

    for (const migrationName of directories) {
      const migrationFile = path.join(directory, migrationName, 'migration.sql');
      let sql;
      try { sql = await fs.readFile(migrationFile, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Migration directory ${migrationName} is missing migration.sql`, { cause: error });
        throw error;
      }
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = appliedByName.get(migrationName);
      if (existing && existing.finished_at) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${migrationName} has changed; restore its original SQL or create a new migration`);
        results.push({ migrationName, status: 'already-applied' });
        continue;
      }
      if (existing) {
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
        let rollbackFailure = '';
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { rollbackFailure = `; rollback also failed: ${rollbackError.message}`; }
        throw new Error(`Migration ${migrationName} failed: ${error.message}${rollbackFailure}`, { cause: error });
      }
    }
    return results;
  } finally {
    if (lockAcquired) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
  }
}

module.exports = { applyMigrations, MIGRATION_LOCK_ID };
