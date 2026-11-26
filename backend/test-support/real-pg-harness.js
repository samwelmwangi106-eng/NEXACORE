/**
 * Shared harness for real-PostgreSQL concurrency tests.
 *
 * It drives the REAL application service functions — `invitation.service.acceptInvitation`,
 * `platform-admin.service.changeOrganisationStatus`, and `access.service.updateMemberStatus` —
 * against a real PostgreSQL 17 cluster, unmodified.
 *
 * Why a shim instead of Prisma Client: `prisma generate` is blocked in this environment
 * (no network access to binaries.prisma.sh), so the generated client does not exist.
 * The shim implements only the Prisma Client methods those services call, and delegates
 * every query to the real `@prisma/adapter-pg` driver adapter. `$transaction` opens a
 * real database transaction, so the service's transaction boundaries are genuine.
 *
 * The shim is therefore NOT a mock of the service logic. It is a mock of the ORM
 * surface only. Every guarantee asserted by these tests is decided by PostgreSQL.
 *
 * `onAfterLock` lets a test pause a transaction immediately after it acquires the
 * per-organisation advisory lock, which makes interleavings deterministic instead of
 * relying on sleeps.
 */
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { PrismaPg } = require('@prisma/adapter-pg');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
const { applyMigrations } = require('../src/lib/migrations');
const { assertLoopbackTarget } = require('./assert-loopback-target');

const STRING = { scalarType: 'string', arity: 'scalar' };
const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');
const LOCK_MARKER = 'pg_advisory_xact_lock';

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', function () {
      const port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
    srv.on('error', reject);
  });
}

/** A one-shot latch. `arrive()` resolves `arrived`; `release()` unblocks `wait()`. */
function createGate() {
  let pushArrived;
  let pushRelease;
  const arrived = new Promise(function (r) { pushArrived = r; });
  const released = new Promise(function (r) { pushRelease = r; });
  return {
    arrived,
    // Bounded: a control experiment without the lock never calls onAfterLock,
    // so an unbounded wait here would hang instead of reporting a verdict.
    arrivedWithin(timeoutMs) {
      const limit = timeoutMs || 5000;
      return Promise.race([
        arrived,
        new Promise(function tooSlow(_, reject) {
          setTimeout(function fire() {
            reject(new Error('gate: onAfterLock was never reached within ' + limit + 'ms'));
          }, limit);
        }),
      ]);
    },
    arrive() { pushArrived(); },
    release() { pushRelease(); },
    // Bounded so a control experiment without the lock fails loudly instead of hanging.
    wait(timeoutMs) {
      const limit = timeoutMs || 5000;
      return Promise.race([
        released,
        new Promise(function tooSlow(_, reject) {
          setTimeout(function fire() {
            reject(new Error('gate: onAfterLock was never reached within ' + limit + 'ms'));
          }, limit);
        }),
      ]);
    },
  };
}

async function startPostgres() {
  const port = await freePort();
  const dir = await require('node:fs/promises').mkdtemp(path.join(require('node:os').tmpdir(), 'nexa-race-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'nexacore_test',
    password: 'local-test-only',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8'],
    onLog: function () {},
    onError: function () {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nexacore_test');
  const connectionString = 'postgresql://nexacore_test:local-test-only@127.0.0.1:' + port + '/nexacore_test';
  // Refuse to proceed unless the cluster we just spawned is provably loopback and
  // distinct from any ambient DATABASE_URL. Checked before migrations are applied.
  assertLoopbackTarget(connectionString, 'concurrency-postgres harness');
  const { Client } = require('pg');
  const setup = new Client({ connectionString });
  await setup.connect();
  await applyMigrations(setup, MIGRATIONS_DIR);
  return { pg, connectionString, setup };
}

function buildModel(run, opts) {
  const options = opts || {};
  async function assignmentsFor(memberId, organisationId) {
    const rows = await run(
      'SELECT r.id, r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id AND r.organisation_id = mr.organisation_id ' +
      'WHERE mr.member_id = $1 AND mr.organisation_id = $2 ORDER BY r.name',
      [memberId, organisationId], [STRING, STRING],
    );
    return rows.map(function toRole(r) { return { id: r[0], name: r[1] }; });
  }

  async function hydrateMember(memberId, organisationId) {
    const rows = await run(
      'SELECT m.id, m.status, m.joined_at, u.id, u.email, u.first_name, u.last_name, u.status ' +
      'FROM organisation_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organisation_id = $2',
      [memberId, organisationId], [STRING, STRING],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r[0],
      status: r[1],
      joinedAt: r[2],
      user: { id: r[3], email: r[4], firstName: r[5], lastName: r[6], status: r[7] },
      assignments: (await assignmentsFor(memberId, organisationId)).map(function toAssignment(role) {
        return { role: role };
      }),
    };
  }

  return {
    organisation: {
      async findUnique(args) {
        const rows = await run(
          'SELECT id, name, status FROM organisations WHERE id = $1',
          [args.where.id], [STRING],
        );
        if (!rows.length) return null;
        return { id: rows[0][0], name: rows[0][1], status: rows[0][2] };
      },
      async update(args) {
        const rows = await run(
          'UPDATE organisations SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, name, status',
          [args.where.id, args.data.status], [STRING, STRING],
        );
        return { id: rows[0][0], name: rows[0][1], status: rows[0][2] };
      },
    },
    organisationInvitation: {
      async findUnique(args) {
        const rows = await run(
          'SELECT i.id, i.organisation_id, i.role_id, i.email, i.accepted_at, i.revoked_at, i.expires_at, ' +
          'o.id, o.name, o.status FROM organisation_invitations i ' +
          'LEFT JOIN organisations o ON o.id = i.organisation_id WHERE i.token_hash = $1',
          [args.where.tokenHash], [STRING],
        );
        if (!rows.length) return null;
        const r = rows[0];
        return {
          id: r[0], organisationId: r[1], roleId: r[2], email: r[3],
          acceptedAt: r[4], revokedAt: r[5], expiresAt: r[6],
          organisation: r[7] ? { id: r[7], name: r[8], status: r[9] } : null,
        };
      },
      async updateMany(args) {
        const rows = await run(
          'UPDATE organisation_invitations SET accepted_at = now() WHERE id = $1 ' +
          'AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id',
          [args.where.id], [STRING],
        );
        return { count: rows.length };
      },
    },
    user: {
      async create(args) {
        const d = args.data;
        const rows = await run(
          'INSERT INTO users (id, email, password_hash, first_name, last_name, status, updated_at) ' +
          'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"AccountStatus", now()) ' +
          'RETURNING id, email, first_name, last_name, status',
          [d.email, d.passwordHash, d.firstName, d.lastName, d.status], [STRING, STRING, STRING, STRING, STRING],
        );
        return { id: rows[0][0], email: rows[0][1], firstName: rows[0][2], lastName: rows[0][3], status: rows[0][4] };
      },
    },
    organisationMember: {
      async create(args) {
        const d = args.data;
        const rows = await run(
          'INSERT INTO organisation_members (id, organisation_id, user_id, status, joined_at) ' +
          'VALUES (gen_random_uuid(), $1, $2, $3::"MembershipStatus", now()) RETURNING id',
          [d.organisationId, d.userId, d.status], [STRING, STRING, STRING],
        );
        return { id: rows[0][0] };
      },
      async findFirst(args) {
        return hydrateMember(args.where.id, args.where.organisationId);
      },
      async findUnique(args) {
        const rows = await run('SELECT organisation_id FROM organisation_members WHERE id = $1', [args.where.id], [STRING]);
        if (!rows.length) return null;
        return hydrateMember(args.where.id, rows[0][0]);
      },
      async update(args) {
        await run(
          'UPDATE organisation_members SET status = $2::"MembershipStatus" WHERE id = $1',
          [args.where.id, args.data.status], [STRING, STRING],
        );
        return {};
      },
    },
    memberRole: {
      async create(args) {
        const d = args.data;
        await run(
          'INSERT INTO member_roles (organisation_id, member_id, role_id) VALUES ($1, $2, $3)',
          [d.organisationId, d.memberId, d.roleId], [STRING, STRING, STRING],
        );
        return {};
      },
      async count(args) {
        const w = args.where;
        // Hook at the exact read-then-write window of the last-owner guard.
        if (typeof options.onAfterOwnershipCount === 'function') {
          await options.onAfterOwnershipCount();
        }
        const rows = await run(
          'SELECT count(*)::int AS n FROM member_roles mr ' +
          'JOIN organisation_members m ON m.id = mr.member_id AND m.organisation_id = mr.organisation_id ' +
          'JOIN roles r ON r.id = mr.role_id AND r.organisation_id = mr.organisation_id ' +
          'WHERE mr.organisation_id = $1 AND mr.member_id <> $2 AND r.name = $3 AND m.status = $4::"MembershipStatus"',
          [w.organisationId, w.memberId.not, w.role.name, w.member.status], [STRING, STRING, STRING, STRING],
        );
        return rows[0][0];
      },
    },
    authToken: {
      async create(args) {
        const d = args.data;
        await run(
          'INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at) ' +
          'VALUES (gen_random_uuid(), $1, $2::"AuthTokenType", $3, $4)',
          [d.userId, d.type, d.tokenHash, d.expiresAt.toISOString()], [STRING, STRING, STRING, STRING],
        );
        return {};
      },
    },
    emailOutbox: {
      async create(args) {
        const d = args.data;
        await run(
          'INSERT INTO email_outbox (id, recipient, encrypted_payload) VALUES (gen_random_uuid(), $1, $2)',
          [d.recipient, d.encryptedPayload], [STRING, STRING],
        );
        return {};
      },
    },
    auditLog: {
      async create(args) {
        const d = args.data;
        await run(
          'INSERT INTO audit_logs (id, organisation_id, actor_user_id, action, entity_type, entity_id, request_id, metadata) ' +
          'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb)',
          [d.organisationId, d.actorUserId, d.action, d.entityType, d.entityId, d.requestId, JSON.stringify(d.metadata || {})],
          [STRING, STRING, STRING, STRING, STRING, STRING, STRING],
        );
        return {};
      },
    },
  };
}

/**
 * @param {string} connectionString
 * @param {object} [options]
 * @param {boolean} [options.disableTenantLock] control experiment: accept the lock
 *        statement but do not execute it, to demonstrate what the lock is preventing.
 * @param {function} [options.onAfterLock] called after the advisory lock is taken,
 *        before the rest of the transaction runs. Used to force a deterministic interleaving.
 */
function createHandle(connectionString, options) {
  const opts = options || {};
  const adapter = new PrismaPg({ connectionString });
  let rootConnection = null;

  function makeClient(connection, insideTransaction) {
    let txConnection = connection;

    async function run(sql, args, argTypes) {
      const result = await txConnection.queryRaw({ sql, args, argTypes });
      return result.rows;
    }

    async function execute(sql, args, argTypes) {
      return txConnection.executeRaw({ sql, args, argTypes });
    }

    const client = Object.assign({}, buildModel(run, opts), {
      async $executeRaw(strings) {
        const args = Array.prototype.slice.call(arguments, 1);
        const values = [];
        const types = [];
        let sql = '';
        for (let i = 0; i < strings.length; i += 1) {
          sql += strings[i];
          if (i < args.length) {
            values.push(args[i]);
            types.push(STRING);
            sql += '$' + values.length;
          }
        }
        const isTenantLock = sql.indexOf(LOCK_MARKER) !== -1;
        if (isTenantLock && opts.disableTenantLock) {
          return 1; // control experiment only
        }
        await execute(sql, values, types);
        if (isTenantLock && typeof opts.onAfterLock === 'function') {
          await opts.onAfterLock();
        }
        return 1;
      },
      async $queryRaw() {
        throw new Error('$queryRaw is not used by the services under test');
      },
    });

    if (opts.stripLockMethod) {
      // Simulates a misconfigured/stubbed client for the fail-closed tests.
      delete client.$executeRaw;
    }

    if (!insideTransaction) {
      client.$transaction = async function $transaction(fn) {
        const pooled = await adapter.connect();
        pooled.client.on('error', function () {});
        const tx = await pooled.startTransaction();
        const txClient = makeClient(tx, true);
        try {
          const result = await fn(txClient);
          await tx.executeRaw({ sql: 'COMMIT', args: [], argTypes: [] });
          await tx.commit();
          return result;
        } catch (error) {
          try { await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] }); } catch (e) {}
          try { await tx.rollback(); } catch (e) {}
          throw error;
        }
      };
    }

    return client;
  }

  return {
    async connect() {
      rootConnection = await adapter.connect();
      rootConnection.client.on('error', function () {});
      return makeClient(rootConnection, false);
    },
    async close() {
      try { if (rootConnection) await rootConnection.dispose(); } catch (e) {}
      try { if (typeof adapter.dispose === 'function') await adapter.dispose(); } catch (e) {}
    },
  };
}

function outboxEncryptionKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { startPostgres, createHandle, createGate, outboxEncryptionKey, LOCK_MARKER };
