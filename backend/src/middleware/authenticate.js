const { verifyAccessToken } = require('../lib/security');

function createAuthenticate(options) {
  const secret = options.accessSecret;
  return async function authenticate(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } });
    }
    let claims;
    try {
      claims = verifyAccessToken(match[1], secret);
      if (claims.typ !== 'access' || !claims.sub || !claims.sid || !Number.isInteger(claims.ver)) throw new Error('Invalid access token');
    } catch (error) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Access token is invalid or expired' } });
    }
    if (options.prisma) {
      try {
        const session = await options.prisma.refreshSession.findFirst({
          where: {
            id: claims.sid,
            userId: claims.sub,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { user: { select: { status: true, tokenVersion: true } } },
        });
        if (session && session.user.status !== 'ACTIVE') {
          return res.status(401).json({ error: { code: 'ACCOUNT_INACTIVE', message: 'This account is not active' } });
        }
        if (!session || session.user.tokenVersion !== claims.ver) {
          return res.status(401).json({ error: { code: 'SESSION_REVOKED', message: 'Session is no longer valid; sign in again' } });
        }
      } catch (error) {
        return next(error);
      }
    }
    req.auth = { userId: claims.sub, sessionId: claims.sid, tokenVersion: claims.ver };
    return next();
  };
}

module.exports = { createAuthenticate };
