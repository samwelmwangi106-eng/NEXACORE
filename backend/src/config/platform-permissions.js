const PLATFORM_PERMISSIONS = [
  ['platform.organisations.read', 'View platform organisations'],
  ['platform.organisations.manage', 'Change platform organisation status'],
  ['platform.users.read', 'View platform user accounts'],
  ['platform.users.manage', 'Change platform account status'],
  ['platform.admins.manage', 'Grant or revoke platform administration permissions'],
  ['platform.audit.read', 'Read platform-level audit records'],
];

module.exports = { PLATFORM_PERMISSIONS };
