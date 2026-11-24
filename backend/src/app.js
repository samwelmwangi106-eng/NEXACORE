const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createAuthRouter } = require('./routes/auth.routes');
const { createPlatformRouter } = require('./routes/platform.routes');
const { createPlatformAdminRouter } = require('./routes/platform-admin.routes');
const { createInvitationRouter } = require('./routes/invitation.routes');
const { createSchoolRouter } = require('./routes/school.routes');
const { AppError } = require('./lib/errors');

function createApiLimiter(windowMs, limit, keyGenerator) {
  return rateLimit({
    windowMs,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
        requestId: req.requestId,
      });
    },
  });
}

function emailRateLimitKey(req) {
  return typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'missing-email';
}

function createApp(options) {
  const app = express();
  const prisma = options.prisma;
  const config = options.config;

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.webOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.use(cookieParser());
  app.use(function assignRequestId(req, res, next) {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    return next();
  });
  
  app.get('/health', function health(req, res) { return res.json({ status: 'ok' }); });

  const authLimiter = createApiLimiter(15 * 60 * 1000, 20);
  const verificationEmailLimiter = createApiLimiter(60 * 60 * 1000, 3, emailRateLimitKey);
  const passwordResetEmailLimiter = createApiLimiter(60 * 60 * 1000, 3, emailRateLimitKey);
  const tokenCheckLimiter = createApiLimiter(15 * 60 * 1000, 10);
  
  app.use('/api/v1/auth/resend-verification', verificationEmailLimiter);
  app.use('/api/v1/auth/forgot-password', passwordResetEmailLimiter);
  app.use('/api/v1/auth/verify-email', tokenCheckLimiter);
  app.use('/api/v1/auth/reset-password', tokenCheckLimiter);
  app.use('/api/v1/auth', authLimiter, createAuthRouter(prisma, config));
  
  app.use('/api/v1/platform', createPlatformAdminRouter(prisma, config));
  app.use('/api/v1', createInvitationRouter(prisma, config));
  app.use('/api/v1', createSchoolRouter(prisma, config));
  app.use('/api/v1', createPlatformRouter(prisma, config));

  app.use(function notFoundHandler(req, res) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId: req.requestId });
  });

  app.use(function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' }, requestId: req.requestId });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the allowed size' }, requestId: req.requestId });
    }
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (status >= 500 && options.logger) options.logger.error({ requestId: req.requestId, error });
    return res.status(status).json({
      error: { code, message: status === 500 ? 'An unexpected error occurred' : error.message },
      requestId: req.requestId,
    });
  });

  return app;
}

module.exports = { createApp };