/**
 * Loopback isolation guard for real-PostgreSQL tests (Stage D, D1.5).
 *
 * Any test that starts a real PostgreSQL cluster and/or applies migrations must prove
 * that it is talking to a disposable local database before it connects. This guard is
 * deliberately paranoid: it refuses anything it cannot positively classify as loopback,
 * and it refuses any target that coincides with an ambient DATABASE_URL.
 *
 * Rationale: a misconfigured harness that silently points at a shared, staging, or
 * production database would run migrations against it. The cost of a false rejection
 * here is a loud test failure; the cost of a false acceptance is data loss.
 *
 * Classification rules (all must pass):
 *   1. The URL must parse as a PostgreSQL URL.
 *   2. The hostname must be loopback: `localhost`, `127.x.x.x`, or an IPv6 loopback
 *      (`::1`, including the `[::1]` form). Both `127.0.0.1` and `::1` are accepted
 *      because embedded-postgres does not guarantee which one it binds.
 *   3. The hostname must NOT be a managed/remote database host. Cloud providers and
 *      Neon are named explicitly so a copy-pasted connection string cannot slip past
 *      the loopback check by being e.g. an IP-shaped host we forgot to special-case.
 *   4. Private RFC1918 ranges are rejected: they are reachable but are not disposable
 *      local clusters, and are exactly how a "shared dev database" would be addressed.
 *   5. The target must differ from `process.env.DATABASE_URL`, so a leaked ambient
 *      environment variable can never silently retarget the suite.
 *
 * The guard reports only the host and port it analysed. It never logs a full
 * connection string, so credentials cannot leak into test output or CI logs.
 */

const net = require('node:net');

/** Hostnames that are unambiguously this machine. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Suffixes and exact hosts that can never be a disposable local cluster.
 * Kept narrow and explicit so a rejection is always explainable.
 */
const FORBIDDEN_HOST_SUFFIXES = [
  '.neon.tech',
  '.neon.build',
  '.supabase.co',
  '.supabase.com',
  '.rds.amazonaws.com',
  '.azure.com',
  '.database.windows.net',
  '.googleusercontent.com',
  '.cloudsql.com',
  '.render.com',
  '.railway.app',
  '.internal',
  '.local', // excludes mDNS/local-network names; embedded clusters never use these
];

/**
 * Decodes an IPv4-mapped IPv6 address to dotted-quad form, or returns null.
 *
 * This is needed because the WHATWG URL parser rewrites `::ffff:127.0.0.1` into the
 * compressed hex form `::ffff:7f00:1`, so a naive string comparison against the
 * dotted form silently fails. Both spellings must be understood.
 */
function ipv4FromMappedIpv6(address) {
  if (!net.isIPv6(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = head.concat(new Array(missing).fill('0'), tail).map(function toInt(group) {
    return parseInt(group, 16);
  });
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  // Only ::ffff:a.b.c.d is a mapped IPv4 address.
  if (groups.slice(0, 5).some(function notZero(value) { return value !== 0; })) return null;
  if (groups[5] !== 0xffff) return null;
  return [
    (groups[6] >> 8) & 0xff,
    groups[6] & 0xff,
    (groups[7] >> 8) & 0xff,
    groups[7] & 0xff,
  ].join('.');
}

/**
 * Returns true when `host` is a loopback address in any of the forms Node and
 * embedded-postgres can produce. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is accepted
 * because dual-stack sockets report loopback connections that way.
 */
function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') return false;

  // Normalise the bracketed IPv6 form and strip a trailing dot from FQDNs.
  let candidate = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (candidate === 'localhost' || candidate === '::1') return true;

  // Any 127.x.x.x address is loopback, not just 127.0.0.1.
  if (net.isIPv4(candidate)) {
    return candidate.split('.')[0] === '127';
  }

  if (net.isIPv6(candidate)) {
    // ::1 already handled; accept IPv4-mapped loopback too.
    if (candidate === '::1') return true;
    // The URL parser may hand back either `::ffff:127.0.0.1` or its compressed
    // hex spelling `::ffff:7f00:1`; normalise both to dotted quad.
    const mapped = ipv4FromMappedIpv6(candidate) || candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return Boolean(mapped && mapped.startsWith('127.'));
  }

  return LOOPBACK_HOSTNAMES.has(candidate);
}

/** True for RFC1918 / link-local IPv4 and IPv6 unique-local addresses. */
function isPrivateAddress(host) {
  const candidate = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(candidate)) {
    const parts = candidate.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local / cloud metadata
    return false;
  }
  if (net.isIPv6(candidate)) {
    // fc00::/7 unique-local
    return /^f[cd][0-9a-f]{2}:/.test(candidate);
  }
  return false;
}

/** Extracts a comparable `host:port` identity without ever exposing credentials. */
function targetIdentity(url, defaultPort) {
  return String(url.hostname).toLowerCase().replace(/^\[|\]$/g, '') + ':' + (url.port || defaultPort || '5432');
}

/**
 * Asserts that `connectionString` targets a disposable loopback PostgreSQL instance.
 *
 * @param {string} connectionString the URL about to be used
 * @param {string} [label] human-readable caller name, used in failure messages
 * @throws {Error} when the target is not provably loopback or matches ambient DATABASE_URL
 */
function assertLoopbackTarget(connectionString, label) {
  const where = label ? ' [' + label + ']' : '';

  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('Isolation guard' + where + ': no connection string was supplied.');
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch (error) {
    // Never echo the raw string: it may carry credentials.
    throw new Error('Isolation guard' + where + ': connection string is not a parseable URL.');
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('Isolation guard' + where + ': expected a postgresql:// URL, received protocol "' + url.protocol + '".');
  }

  const host = url.hostname;
  if (!host) {
    throw new Error('Isolation guard' + where + ': connection string has no host component.');
  }

  const normalised = host.toLowerCase().replace(/^\[|\]$/g, '');

  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (normalised.endsWith(suffix)) {
      throw new Error(
        'Isolation guard' + where + ': refused host "' + host + '" (' + suffix + '). ' +
        'Real-PostgreSQL tests may only target a disposable local cluster.',
      );
    }
  }

  if (!isLoopbackHost(normalised)) {
    const kind = isPrivateAddress(normalised) ? 'a private network address' : 'a non-loopback host';
    throw new Error(
      'Isolation guard' + where + ': refused host "' + host + '" because it is ' + kind + '. ' +
      'Only loopback targets (localhost, 127.x.x.x, ::1) are permitted. ' +
      'Refusing to run migrations against a host that is not provably disposable.',
    );
  }

  // Refuse to duplicate the ambient target. If DATABASE_URL points at loopback this
  // still matters: it may be a developer's long-lived local database, not a throwaway one.
  const ambient = process.env.DATABASE_URL;
  if (ambient) {
    try {
      const ambientUrl = new URL(ambient);
      if (targetIdentity(ambientUrl) === targetIdentity(url)) {
        throw new Error(
          'Isolation guard' + where + ': target ' + targetIdentity(url) + ' is the same ' +
          'database as the ambient DATABASE_URL. Refusing to run migrations against it; ' +
          'use a freshly created ephemeral cluster instead.',
        );
      }
    } catch (error) {
      // A parse failure on the ambient value is not this guard's business, but an
      // identity collision thrown above must propagate.
      if (/Isolation guard/.test(error.message)) throw error;
    }
  }

  return true;
}

/**
 * Convenience wrapper: asserts the target and returns the connection string unchanged,
 * so callers can inline it without restructuring their setup code.
 */
function requireLoopbackTarget(connectionString, label) {
  assertLoopbackTarget(connectionString, label);
  return connectionString;
}

module.exports = { assertLoopbackTarget, requireLoopbackTarget, isLoopbackHost, isPrivateAddress };
