const express = require('express');
const { z } = require('zod');
const { createAuthenticate } = require('../middleware/authenticate');
const { createRequireTenant, requirePermission } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { AppError } = require('../lib/errors');
const schoolService = require('../modules/school/school.service');
const {
  schoolProfileSchema,
  academicYearCreateSchema,
  academicYearUpdateSchema,
  schoolTermCreateSchema,
  schoolTermUpdateSchema,
  gradeLevelCreateSchema,
  gradeLevelUpdateSchema,
  classSectionCreateSchema,
  classSectionUpdateSchema,
} = require('../modules/school/school.schemas');

function validateSchoolResourceIds(req, res, next) {
  const ids = ['academicYearId', 'termId', 'gradeLevelId', 'sectionId'];
  for (const name of ids) {
    if (req.params[name] && !z.string().uuid().safeParse(req.params[name]).success) {
      return res.status(400).json({ error: { code: 'INVALID_RESOURCE_ID', message: `${name} must be a UUID` } });
    }
  }
  return next();
}

function requireSchoolModule(req, res, next) {
  if (!req.tenant || req.tenant.organisation.industry !== 'SCHOOL') {
    return res.status(404).json({ error: { code: 'SCHOOL_MODULE_NOT_ENABLED', message: 'The school module is not enabled for this organisation' } });
  }
  return next();
}

function schoolHandler(handler) {
  return async function handleSchoolRequest(req, res, next) {
    try { return await handler(req, res); }
    catch (error) {
      if (error.code === 'P2002') return next(new AppError(409, 'SCHOOL_RESOURCE_CONFLICT', 'A school resource with those details already exists'));
      if (error.code === 'P2034') return next(new AppError(409, 'SCHOOL_UPDATE_CONFLICT', 'The school schedule changed concurrently; reload and retry'));
      return next(error);
    }
  };
}

function createSchoolRouter(prisma, config) {
  const router = express.Router();
  const authenticate = createAuthenticate({ ...config, prisma });
  const requireTenant = createRequireTenant(prisma);
  const schoolRead = requirePermission('school.read');
  const schoolManage = requirePermission('school.manage');

  router.get('/organisations/:organisationId/school/profile', authenticate, requireTenant, requireSchoolModule, schoolRead, schoolHandler(async function getProfile(req, res) {
    return res.json({ profile: await schoolService.getProfile(prisma, req.tenant.id) });
  }));
  router.put('/organisations/:organisationId/school/profile', authenticate, requireTenant, requireSchoolModule, schoolManage, validate(schoolProfileSchema, 'body'), schoolHandler(async function updateProfile(req, res) {
    const profile = await schoolService.updateProfile(prisma, req.tenant.id, req.auth.userId, req.body, req.requestId);
    return res.json({ profile });
  }));

  router.get('/organisations/:organisationId/school/academic-years', authenticate, requireTenant, requireSchoolModule, schoolRead, schoolHandler(async function listAcademicYears(req, res) {
    return res.json({ academicYears: await schoolService.listAcademicYears(prisma, req.tenant.id) });
  }));
  router.post('/organisations/:organisationId/school/academic-years', authenticate, requireTenant, requireSchoolModule, schoolManage, validate(academicYearCreateSchema, 'body'), schoolHandler(async function createAcademicYear(req, res) {
    const academicYear = await schoolService.createAcademicYear(prisma, req.tenant.id, req.auth.userId, req.body, req.requestId);
    return res.status(201).json({ academicYear });
  }));
  router.patch('/organisations/:organisationId/school/academic-years/:academicYearId', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(academicYearUpdateSchema, 'body'), schoolHandler(async function updateAcademicYear(req, res) {
    const academicYear = await schoolService.updateAcademicYear(prisma, req.tenant.id, req.auth.userId, req.params.academicYearId, req.body, req.requestId);
    return res.json({ academicYear });
  }));

  router.get('/organisations/:organisationId/school/academic-years/:academicYearId/terms', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolRead, schoolHandler(async function listTerms(req, res) {
    return res.json({ terms: await schoolService.listTerms(prisma, req.tenant.id, req.params.academicYearId) });
  }));
  router.post('/organisations/:organisationId/school/academic-years/:academicYearId/terms', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(schoolTermCreateSchema, 'body'), schoolHandler(async function createTerm(req, res) {
    const term = await schoolService.createTerm(prisma, req.tenant.id, req.auth.userId, req.params.academicYearId, req.body, req.requestId);
    return res.status(201).json({ term });
  }));
  router.patch('/organisations/:organisationId/school/academic-years/:academicYearId/terms/:termId', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(schoolTermUpdateSchema, 'body'), schoolHandler(async function updateTerm(req, res) {
    const term = await schoolService.updateTerm(prisma, req.tenant.id, req.auth.userId, req.params.academicYearId, req.params.termId, req.body, req.requestId);
    return res.json({ term });
  }));

  router.get('/organisations/:organisationId/school/grade-levels', authenticate, requireTenant, requireSchoolModule, schoolRead, schoolHandler(async function listGradeLevels(req, res) {
    return res.json({ gradeLevels: await schoolService.listGradeLevels(prisma, req.tenant.id) });
  }));
  router.post('/organisations/:organisationId/school/grade-levels', authenticate, requireTenant, requireSchoolModule, schoolManage, validate(gradeLevelCreateSchema, 'body'), schoolHandler(async function createGradeLevel(req, res) {
    const gradeLevel = await schoolService.createGradeLevel(prisma, req.tenant.id, req.auth.userId, req.body, req.requestId);
    return res.status(201).json({ gradeLevel });
  }));
  router.patch('/organisations/:organisationId/school/grade-levels/:gradeLevelId', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(gradeLevelUpdateSchema, 'body'), schoolHandler(async function updateGradeLevel(req, res) {
    const gradeLevel = await schoolService.updateGradeLevel(prisma, req.tenant.id, req.auth.userId, req.params.gradeLevelId, req.body, req.requestId);
    return res.json({ gradeLevel });
  }));

  router.get('/organisations/:organisationId/school/academic-years/:academicYearId/sections', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolRead, schoolHandler(async function listSections(req, res) {
    return res.json({ sections: await schoolService.listSections(prisma, req.tenant.id, req.params.academicYearId) });
  }));
  router.post('/organisations/:organisationId/school/academic-years/:academicYearId/sections', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(classSectionCreateSchema, 'body'), schoolHandler(async function createSection(req, res) {
    const section = await schoolService.createSection(prisma, req.tenant.id, req.auth.userId, req.params.academicYearId, req.body, req.requestId);
    return res.status(201).json({ section });
  }));
  router.patch('/organisations/:organisationId/school/academic-years/:academicYearId/sections/:sectionId', authenticate, validateSchoolResourceIds, requireTenant, requireSchoolModule, schoolManage, validate(classSectionUpdateSchema, 'body'), schoolHandler(async function updateSection(req, res) {
    const section = await schoolService.updateSection(prisma, req.tenant.id, req.auth.userId, req.params.academicYearId, req.params.sectionId, req.body, req.requestId);
    return res.json({ section });
  }));

  return router;
}

module.exports = { createSchoolRouter };