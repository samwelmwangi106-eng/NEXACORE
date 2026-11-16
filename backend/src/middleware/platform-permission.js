function requirePlatformPermission(prisma, permissionKey) {
  return async function platformPermissionGuard(req, res, next) {
    try {
      const grant = await prisma.platformAdminGrant.findFirst({
        where: { userId: req.auth.userId, permission: { key: permissionKey }, user: { status: 'ACTIVE' } },
        select: { userId: true },
      });
      if (!grant) {
        return res.status(403).json({ error: { code: 'PLATFORM_FORBIDDEN', message: 'Platform administration permission is required' } });
      }
      return next();
    } catch (error) { return next(error); }
  };
}

module.exports = { requirePlatformPermission };
