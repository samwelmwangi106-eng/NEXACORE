const PERMISSIONS = [
  ['organisation.update', 'Update organisation profile and settings'],
  ['members.read', 'View organisation members'],
  ['members.manage', 'Invite and manage organisation members'],
  ['roles.read', 'View organisation roles and permissions'],
  ['roles.manage', 'Create roles and assign permissions'],
  ['audit.read', 'Read organisation audit records'],
  ['billing.read', 'View subscription and billing information'],
  ['billing.manage', 'Manage subscription and billing'],
  ['school.read', 'View school settings and academic structure'],
  ['school.manage', 'Manage school settings and academic structure'],
  ['sacco.manage', 'Manage SACCO records'],
  ['clinic.manage', 'Manage clinic records'],
  ['rentals.manage', 'Manage rental records'],
];

const ROLE_PERMISSIONS = {
  'Organisation Owner': PERMISSIONS.filter(function adminPermission(item) {
    return item[0] !== 'billing.manage';
  }).map(function permissionKey(item) { return item[0]; }),
  'Organisation Administrator': PERMISSIONS.filter(function adminPermission(item) {
    return item[0] !== 'billing.manage';
  }).map(function permissionKey(item) { return item[0]; }),
  Manager: ['organisation.read', 'members.read', 'roles.read', 'school.read', 'school.manage', 'sacco.manage', 'clinic.manage', 'rentals.manage'],
  Accountant: ['organisation.read', 'billing.read'],
  'Staff Member': ['organisation.read'],
  Auditor: ['organisation.read', 'members.read', 'roles.read', 'audit.read', 'billing.read'],
  'Customer or Client': ['organisation.read'],
};

const INDUSTRY_PERMISSION_PREFIX = {
  SCHOOL: 'school.',
  SACCO: 'sacco.',
  CLINIC: 'clinic.',
  RENTAL: 'rentals.',
};

function permissionAppliesToIndustry(key, industry) {
  const prefix = Object.values(INDUSTRY_PERMISSION_PREFIX).find(function findPrefix(value) { return key.startsWith(value); });
  return !prefix || key.startsWith(INDUSTRY_PERMISSION_PREFIX[industry] || '\u0000');
}

function permissionsForIndustry(keys, industry) {
  return keys.filter(function applicable(key) { return permissionAppliesToIndustry(key, industry); });
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, permissionAppliesToIndustry, permissionsForIndustry };