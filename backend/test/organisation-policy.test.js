const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionsForIndustry, permissionAppliesToIndustry } = require('../src/config/permissions');
const { organisationUpdateSchema } = require('../src/modules/organisations/organisation.schemas');

test('industry-specific permissions are only applicable to the matching industry', function industryPermissions() {
  assert.equal(permissionAppliesToIndustry('school.manage', 'SCHOOL'), true);
  assert.equal(permissionAppliesToIndustry('school.manage', 'CLINIC'), false);
  assert.deepEqual(permissionsForIndustry(['organisation.read', 'school.read', 'clinic.manage'], 'SCHOOL'), ['organisation.read', 'school.read']);
});

test('organisation settings accept only the approved common allowlist', function commonOrganisationSettings() {
  assert.equal(organisationUpdateSchema.safeParse({ settings: { timeZone: 'Africa/Nairobi', weekStartsOn: 1 } }).success, true);
  assert.equal(organisationUpdateSchema.safeParse({ settings: { timeZone: 'Not/A_TimeZone' } }).success, false);
  assert.equal(organisationUpdateSchema.safeParse({ settings: { schoolCode: 'ABC' } }).success, false);
  assert.equal(organisationUpdateSchema.safeParse({ settings: { unknown: 'value' } }).success, false);
});
