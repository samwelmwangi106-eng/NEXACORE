const PERMISSIONS = [
  ['organisation.read', 'View organisation profile and membership'],
  ['organisation.update', 'Update organisation profile and settings'],
  ['members.read', 'View organisation members'],
  ['members.manage', 'Invite and manage organisation members'],
  ['roles.manage', 'Create roles and assign permissions'],
  ['audit.read', 'Read organisation audit records'],
  ['billing.read', 'View subscription and billing information'],
  ['billing.manage', 'Manage subscription and billing'],
  ['school.manage', 'Manage school records'],
  ['sacco.manage', 'Manage SACCO records'],
  ['clinic.manage', 'Manage clinic records'],
  ['rentals.manage', 'Manage rental records'],
];

const ROLE_PERMISSIONS = {
  'Organisation Owner': PERMISSIONS.map(function mapPermission(item) { return item[0]; }),
  'Organisation Administrator': PERMISSIONS.filter(function adminPermission(item) {
    return item[0] !== 'billing.manage';
  }).map(function permissionKey(item) { return item[0]; }),
  Manager: ['organisation.read', 'members.read', 'school.manage', 'sacco.manage', 'clinic.manage', 'rentals.manage'],
  Accountant: ['organisation.read', 'billing.read'],
  'Staff Member': ['organisation.read'],
  Auditor: ['organisation.read', 'members.read', 'audit.read', 'billing.read'],
  'Customer or Client': ['organisation.read'],
};

module.exports = { PERMISSIONS, ROLE_PERMISSIONS };
