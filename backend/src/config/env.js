const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  MAIL_MODE: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().email().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_OUTBOX_ENCRYPTION_KEY: z.string().min(1),
});

function loadConfig(environment) {
  const values = envSchema.parse(environment || process.env);
  if (values.NODE_ENV === 'production' && values.COOKIE_SECURE !== 'true') {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  if (values.NODE_ENV === 'production' && values.MAIL_MODE !== 'smtp') {
    throw new Error('MAIL_MODE must be smtp in production');
  }
  if (values.MAIL_MODE === 'smtp' && (!values.SMTP_HOST || !values.MAIL_FROM)) {
    throw new Error('SMTP_HOST and MAIL_FROM are required when MAIL_MODE=smtp');
  }
  if (Boolean(values.SMTP_USER) !== Boolean(values.SMTP_PASSWORD)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be supplied together');
  }
  const outboxEncryptionKey = Buffer.from(values.EMAIL_OUTBOX_ENCRYPTION_KEY, 'base64');
  if (outboxEncryptionKey.length !== 32 || outboxEncryptionKey.toString('base64') !== values.EMAIL_OUTBOX_ENCRYPTION_KEY) {
    throw new Error('EMAIL_OUTBOX_ENCRYPTION_KEY must be valid base64 for exactly 32 random bytes');
  }
  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    migrationDatabaseUrl: values.MIGRATION_DATABASE_URL || values.DATABASE_URL,
    accessSecret: values.JWT_ACCESS_SECRET,
    accessTtl: values.ACCESS_TOKEN_TTL,
    refreshTtlDays: values.REFRESH_TOKEN_TTL_DAYS,
    webOrigin: values.WEB_ORIGIN,
    cookieSecure: values.COOKIE_SECURE === 'true',
    mailMode: values.MAIL_MODE,
    mailFrom: values.MAIL_FROM,
    smtpHost: values.SMTP_HOST,
    smtpPort: values.SMTP_PORT,
    smtpSecure: values.SMTP_SECURE === 'true',
    smtpUser: values.SMTP_USER,
    smtpPassword: values.SMTP_PASSWORD,
    outboxEncryptionKey: values.EMAIL_OUTBOX_ENCRYPTION_KEY,
  };
}

module.exports = { loadConfig };
