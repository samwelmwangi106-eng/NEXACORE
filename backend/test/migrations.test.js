const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { applyMigrations } = require('../src/lib/migrations');

async function temporaryMigrationDirectory(t, sql) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexacore-migrations-'));
  t.after(async function cleanup() { await fs.rm(directory, { recursive: true, force: true }); });
  await fs.mkdir(path.join(directory, '202601010000_first'));
  if (sql !== null) await fs.writeFile(path.join(directory, '202601010000_first', 'migration.sql'), sql);
  return directory;
}

function fakeClient(rows) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM "_prisma_migrations"')) return { rows };
      return { rows: [] };
    },
  };
}

test('migration runner refuses applied migrations missing from the checkout', async function detectMissingHistory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexacore-migrations-empty-'));
  const client = fakeClient([{ migration_name: '202501010000_missing', checksum: 'x', finished_at: new Date(), rolled_back_at: null }]);
  try {
    await assert.rejects(applyMigrations(client, directory), /is missing from/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('migration runner blocks checksum changes to applied SQL', async function detectChecksumDrift(t) {
  const directory = await temporaryMigrationDirectory(t, 'SELECT 1;');
  const client = fakeClient([{ migration_name: '202601010000_first', checksum: 'wrong-checksum', finished_at: new Date(), rolled_back_at: null }]);
  await assert.rejects(applyMigrations(client, directory), /has changed/);
});

test('migration runner fails clearly for a directory without migration SQL', async function detectMissingSql(t) {
  const directory = await temporaryMigrationDirectory(t, null);
  const client = fakeClient([]);
  await assert.rejects(applyMigrations(client, directory), /missing migration.sql/);
});
