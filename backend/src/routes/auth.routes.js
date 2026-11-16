const express = require('express');
const { validate } = require('../middleware/validate');
const {
  registerSchema, loginSchema, emailSchema, tokenSchema, resetPasswordSchema,
} = require('../modules/auth/auth.schemas');
const authService = require('../modules/auth/auth.service');
const { AppError } = require('../lib/errors');

function cookieOptions(config, expiresAt) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  };
}

function createAuthRouter(prisma, config) {
  const router = express.Router();

  router.post('/register', validate(registerSchema, 'body'), async function register(req, res, next) {
    try {
      const result = await authService.register(prisma, req.body, config, { requestId: req.requestId });
      return res.status(202).json({
        message: 'Registration received. Check your email for a verification link before signing in.',
        user: result.user,
        organisation: {
          id: result.organisation.id,
          name: result.organisation.name,
          industry: result.organisation.industry,
        },
      });
    } catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email or organisation identifier already exists'));
      return next(error);
    }
  });

  router.post('/verify-email', validate(tokenSchema, 'body'), async function verifyEmail(req, res, next) {
    try {
      const result = await authService.verifyEmail(prisma, req.body.token, config);
      res.cookie('nexacore_refresh', result.refreshToken, cookieOptions(config, result.refreshExpiresAt));
      return res.json({ user: result.user, accessToken: result.accessToken });
    } catch (error) { return next(error); }
  });

  router.post('/resend-verification', validate(emailSchema, 'body'), async function resendVerification(req, res, next) {
    try {
      await authService.resendVerification(prisma, req.body.email, config, { requestId: req.requestId });
      return res.status(202).json({ message: 'If the account needs verification, a new link will be sent shortly.' });
    } catch (error) { return next(error); }
  });

  router.post('/login', validate(loginSchema, 'body'), async function login(req, res, next) {
    try {
      const result = await authService.login(prisma, req.body, config);
      res.cookie('nexacore_refresh', result.refreshToken, cookieOptions(config, result.refreshExpiresAt));
      return res.json({ user: result.user, accessToken: result.accessToken });
    } catch (error) { return next(error); }
  });

  router.post('/forgot-password', validate(emailSchema, 'body'), async function forgotPassword(req, res, next) {
    try {
      await authService.requestPasswordReset(prisma, req.body.email, config, { requestId: req.requestId });
      return res.status(202).json({ message: 'If an active account matches that email, password reset instructions will be sent.' });
    } catch (error) { return next(error); }
  });

  router.post('/reset-password', validate(resetPasswordSchema, 'body'), async function resetPassword(req, res, next) {
    try {
      await authService.resetPassword(prisma, req.body.token, req.body.password, { requestId: req.requestId });
      res.clearCookie('nexacore_refresh', cookieOptions(config, new Date(0)));
      return res.status(204).end();
    } catch (error) { return next(error); }
  });

  router.post('/refresh', async function refresh(req, res, next) {
    try {
      const rawToken = req.cookies && req.cookies.nexacore_refresh;
      const result = await authService.rotateSession(prisma, rawToken, config);
      res.cookie('nexacore_refresh', result.refreshToken, cookieOptions(config, result.refreshExpiresAt));
      return res.json({ user: result.user, accessToken: result.accessToken });
    } catch (error) { return next(error); }
  });

  router.post('/logout', async function logout(req, res, next) {
    try {
      await authService.revokeSession(prisma, req.cookies && req.cookies.nexacore_refresh);
      res.clearCookie('nexacore_refresh', cookieOptions(config, new Date(0)));
      return res.status(204).end();
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = { createAuthRouter };
