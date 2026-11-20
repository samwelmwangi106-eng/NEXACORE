const { AppError } = require('../../lib/errors');
const { recordAudit } = require('../audit/audit.service');

function toDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function assertValidRange(startsOn, endsOn, label) {
  if (startsOn.getTime() >= endsOn.getTime()) {
    throw new AppError(400, 'INVALID_DATE_RANGE', `${label} end date must be after its start date`);
  }
}

function assertAllowedTransition(current, requested, transitions, label) {
  if (requested === undefined || requested === current) return;
  if (!transitions[current] || !transitions[current].includes(requested)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `${label} cannot transition from ${current} to ${requested}`);
  }
}

async function getProfile(prisma, organisationId) {
  const profile = await prisma.schoolProfile.findUnique({ where: { organisationId } });
  return profile || { organisationId, schoolCode: null, timeZone: 'Africa/Nairobi', weekStartsOn: 1 };
}

async function updateProfile(prisma, organisationId, actorUserId, data, requestId) {
  return prisma.$transaction(async function updateSchoolProfileTransaction(tx) {
    const profile = await tx.schoolProfile.upsert({
      where: { organisationId },
      create: { organisationId, ...data },
      update: data,
    });
    await recordAudit(tx, {
      organisationId,
      actorUserId,
      action: 'school.profile_updated',
      entityType: 'school_profile',
      entityId: profile.id,
      requestId,
      metadata: { changedFields: Object.keys(data) },
    });
    return profile;
  }, { isolationLevel: 'Serializable' });
}

async function listAcademicYears(prisma, organisationId) {
  return prisma.schoolAcademicYear.findMany({
    where: { organisationId },
    orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
    include: { _count: { select: { terms: true, sections: true } } },
  });
}

async function ensureNoAcademicYearOverlap(tx, organisationId, startsOn, endsOn, excludedId) {
  const overlap = await tx.schoolAcademicYear.findFirst({
    where: {
      organisationId,
      ...(excludedId ? { id: { not: excludedId } } : {}),
      startsOn: { lt: endsOn },
      endsOn: { gt: startsOn },
    },
    select: { id: true, name: true },
  });
  if (overlap) throw new AppError(409, 'ACADEMIC_YEAR_OVERLAP', `Dates overlap academic year ${overlap.name}`);
}

async function createAcademicYear(prisma, organisationId, actorUserId, data, requestId) {
  const startsOn = toDate(data.startsOn);
  const endsOn = toDate(data.endsOn);
  assertValidRange(startsOn, endsOn, 'Academic year');
  return prisma.$transaction(async function createAcademicYearTransaction(tx) {
    await ensureNoAcademicYearOverlap(tx, organisationId, startsOn, endsOn);
    if (data.status === 'ACTIVE') {
      const active = await tx.schoolAcademicYear.findFirst({ where: { organisationId, status: 'ACTIVE' }, select: { id: true } });
      if (active) throw new AppError(409, 'ACTIVE_ACADEMIC_YEAR_EXISTS', 'Only one academic year can be active at a time');
    }
    const year = await tx.schoolAcademicYear.create({
      data: { organisationId, name: data.name, startsOn, endsOn, ...(data.status ? { status: data.status } : {}) },
    });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.academic_year_created',
      entityType: 'school_academic_year', entityId: year.id, requestId,
      metadata: { name: year.name, startsOn: data.startsOn, endsOn: data.endsOn, status: year.status },
    });
    return year;
  }, { isolationLevel: 'Serializable' });
}

async function updateAcademicYear(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
  return prisma.$transaction(async function updateAcademicYearTransaction(tx) {
    const current = await tx.schoolAcademicYear.findFirst({ where: { id: academicYearId, organisationId } });
    if (!current) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
    if (current.status === 'CLOSED') throw new AppError(409, 'ACADEMIC_YEAR_CLOSED', 'A closed academic year cannot be changed');
    if (current.status === 'ACTIVE' && (data.startsOn || data.endsOn)) {
      throw new AppError(409, 'ACADEMIC_YEAR_ACTIVE', 'Academic year dates cannot change after activation');
    }
    const startsOn = data.startsOn ? toDate(data.startsOn) : current.startsOn;
    const endsOn = data.endsOn ? toDate(data.endsOn) : current.endsOn;
    assertValidRange(startsOn, endsOn, 'Academic year');
    await ensureNoAcademicYearOverlap(tx, organisationId, startsOn, endsOn, current.id);
    if (data.startsOn || data.endsOn) {
      const outOfRangeTerms = await tx.schoolTerm.count({
        where: {
          organisationId,
          academicYearId: current.id,
          OR: [{ startsOn: { lt: startsOn } }, { endsOn: { gt: endsOn } }],
        },
      });
      if (outOfRangeTerms) throw new AppError(409, 'ACADEMIC_YEAR_CONTAINS_TERMS', 'Academic year dates cannot exclude an existing term');
    }
    if (data.status === 'ACTIVE') {
      assertAllowedTransition(current.status, data.status, { DRAFT: ['ACTIVE'] }, 'Academic year');
      const active = await tx.schoolAcademicYear.findFirst({
        where: { organisationId, status: 'ACTIVE', id: { not: current.id } },
        select: { id: true },
      });
      if (active) throw new AppError(409, 'ACTIVE_ACADEMIC_YEAR_EXISTS', 'Only one academic year can be active at a time');
    }
    if (data.status === 'CLOSED') {
      assertAllowedTransition(current.status, data.status, { DRAFT: ['CLOSED'], ACTIVE: ['CLOSED'] }, 'Academic year');
      const [openTerms, openSections] = await Promise.all([
        tx.schoolTerm.count({ where: { organisationId, academicYearId, status: { in: ['PLANNED', 'ACTIVE'] } } }),
        tx.schoolClassSection.count({ where: { organisationId, academicYearId, status: { in: ['PLANNED', 'ACTIVE'] } } }),
      ]);
      if (openTerms || openSections) {
        throw new AppError(409, 'OPEN_SCHOOL_ITEMS_REMAIN', 'Complete all planned or active terms and close all planned or active class sections before closing the academic year');
      }
    }
    if (data.status === 'DRAFT' && current.status !== 'DRAFT') {
      assertAllowedTransition(current.status, data.status, {}, 'Academic year');
    }
    const updated = await tx.schoolAcademicYear.update({
      where: { id: current.id },
      data: { ...data, startsOn, endsOn },
    });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.academic_year_updated',
      entityType: 'school_academic_year', entityId: updated.id, requestId,
      metadata: { changedFields: Object.keys(data) },
    });
    return updated;
  }, { isolationLevel: 'Serializable' });
}

async function findAcademicYear(tx, organisationId, academicYearId) {
  const year = await tx.schoolAcademicYear.findFirst({ where: { id: academicYearId, organisationId } });
  if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
  return year;
}

async function listTerms(prisma, organisationId, academicYearId) {
  const year = await prisma.schoolAcademicYear.findFirst({ where: { id: academicYearId, organisationId }, select: { id: true } });
  if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
  return prisma.schoolTerm.findMany({
    where: { organisationId, academicYearId },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
}

async function ensureTermDoesNotOverlap(tx, organisationId, academicYearId, startsOn, endsOn, excludedId) {
  const overlap = await tx.schoolTerm.findFirst({
    where: {
      organisationId,
      academicYearId,
      ...(excludedId ? { id: { not: excludedId } } : {}),
      startsOn: { lt: endsOn },
      endsOn: { gt: startsOn },
    },
    select: { id: true, name: true },
  });
  if (overlap) throw new AppError(409, 'SCHOOL_TERM_OVERLAP', `Dates overlap term ${overlap.name}`);
}

function assertTermWithinYear(year, startsOn, endsOn) {
  if (startsOn < year.startsOn || endsOn > year.endsOn) {
    throw new AppError(400, 'TERM_OUTSIDE_ACADEMIC_YEAR', 'Term dates must fit within the academic year');
  }
}

async function createTerm(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
  const startsOn = toDate(data.startsOn);
  const endsOn = toDate(data.endsOn);
  assertValidRange(startsOn, endsOn, 'Term');
  return prisma.$transaction(async function createTermTransaction(tx) {
    const year = await findAcademicYear(tx, organisationId, academicYearId);
    if (year.status === 'CLOSED') throw new AppError(409, 'ACADEMIC_YEAR_CLOSED', 'Terms cannot be added to a closed academic year');
    assertTermWithinYear(year, startsOn, endsOn);
    await ensureTermDoesNotOverlap(tx, organisationId, academicYearId, startsOn, endsOn);
    const term = await tx.schoolTerm.create({
      data: { organisationId, academicYearId, name: data.name, sequence: data.sequence, startsOn, endsOn },
    });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.term_created',
      entityType: 'school_term', entityId: term.id, requestId,
      metadata: { academicYearId, name: term.name, sequence: term.sequence, startsOn: data.startsOn, endsOn: data.endsOn },
    });
    return term;
  }, { isolationLevel: 'Serializable' });
}

async function updateTerm(prisma, organisationId, actorUserId, academicYearId, termId, data, requestId) {
  return prisma.$transaction(async function updateTermTransaction(tx) {
    const [year, current] = await Promise.all([
      findAcademicYear(tx, organisationId, academicYearId),
      tx.schoolTerm.findFirst({ where: { id: termId, organisationId, academicYearId } }),
    ]);
    if (!current) throw new AppError(404, 'SCHOOL_TERM_NOT_FOUND', 'Term not found');
    if (year.status === 'CLOSED') throw new AppError(409, 'ACADEMIC_YEAR_CLOSED', 'Terms in a closed academic year cannot be changed');
    const dataFields = Object.keys(data).filter(function isNotStatus(key) { return key !== 'status'; });
    if (current.status !== 'PLANNED' && dataFields.length) {
      throw new AppError(409, 'SCHOOL_TERM_STARTED', 'Term details cannot change after the term is active or completed');
    }
    if (data.status) {
      const allowed = { PLANNED: ['ACTIVE', 'COMPLETED'], ACTIVE: ['COMPLETED'] };
      assertAllowedTransition(current.status, data.status, allowed, 'School term');
      if (data.status === 'ACTIVE') {
        if (year.status !== 'ACTIVE') throw new AppError(409, 'ACADEMIC_YEAR_NOT_ACTIVE', 'Activate the academic year before activating a term');
        const otherActiveTerm = await tx.schoolTerm.findFirst({
          where: { organisationId, academicYearId, status: 'ACTIVE', id: { not: current.id } },
          select: { id: true },
        });
        if (otherActiveTerm) throw new AppError(409, 'ACTIVE_SCHOOL_TERM_EXISTS', 'Only one term can be active in an academic year');
      }
    }
    const startsOn = data.startsOn ? toDate(data.startsOn) : current.startsOn;
    const endsOn = data.endsOn ? toDate(data.endsOn) : current.endsOn;
    assertValidRange(startsOn, endsOn, 'Term');
    assertTermWithinYear(year, startsOn, endsOn);
    if (dataFields.length) await ensureTermDoesNotOverlap(tx, organisationId, academicYearId, startsOn, endsOn, current.id);
    const updated = await tx.schoolTerm.update({ where: { id: current.id }, data: { ...data, startsOn, endsOn } });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.term_updated',
      entityType: 'school_term', entityId: updated.id, requestId,
      metadata: { changedFields: Object.keys(data), academicYearId },
    });
    return updated;
  }, { isolationLevel: 'Serializable' });
}

async function listGradeLevels(prisma, organisationId) {
  return prisma.schoolGradeLevel.findMany({
    where: { organisationId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { sections: true } } },
  });
}

async function createGradeLevel(prisma, organisationId, actorUserId, data, requestId) {
  return prisma.$transaction(async function createGradeLevelTransaction(tx) {
    const level = await tx.schoolGradeLevel.create({ data: { organisationId, ...data } });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.grade_level_created',
      entityType: 'school_grade_level', entityId: level.id, requestId,
      metadata: { name: level.name, code: level.code, sortOrder: level.sortOrder },
    });
    return level;
  }, { isolationLevel: 'Serializable' });
}

async function updateGradeLevel(prisma, organisationId, actorUserId, gradeLevelId, data, requestId) {
  return prisma.$transaction(async function updateGradeLevelTransaction(tx) {
    const current = await tx.schoolGradeLevel.findFirst({ where: { id: gradeLevelId, organisationId } });
    if (!current) throw new AppError(404, 'SCHOOL_GRADE_LEVEL_NOT_FOUND', 'Grade level not found');
    if (data.status === 'INACTIVE' && current.status === 'ACTIVE') {
      const openSections = await tx.schoolClassSection.count({
        where: { organisationId, gradeLevelId: current.id, status: { in: ['PLANNED', 'ACTIVE'] } },
      });
      if (openSections) throw new AppError(409, 'GRADE_LEVEL_HAS_OPEN_SECTIONS', 'Close all planned or active class sections before deactivating this grade level');
    }
    const updated = await tx.schoolGradeLevel.update({ where: { id: current.id }, data });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.grade_level_updated',
      entityType: 'school_grade_level', entityId: updated.id, requestId,
      metadata: { changedFields: Object.keys(data) },
    });
    return updated;
  }, { isolationLevel: 'Serializable' });
}

async function listSections(prisma, organisationId, academicYearId) {
  const year = await prisma.schoolAcademicYear.findFirst({ where: { id: academicYearId, organisationId }, select: { id: true } });
  if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
  return prisma.schoolClassSection.findMany({
    where: { organisationId, academicYearId },
    orderBy: [{ gradeLevel: { sortOrder: 'asc' } }, { gradeLevel: { name: 'asc' } }, { name: 'asc' }],
    include: { gradeLevel: true },
  });
}

async function createSection(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
  return prisma.$transaction(async function createSectionTransaction(tx) {
    const [year, gradeLevel] = await Promise.all([
      findAcademicYear(tx, organisationId, academicYearId),
      tx.schoolGradeLevel.findFirst({ where: { id: data.gradeLevelId, organisationId } }),
    ]);
    if (year.status === 'CLOSED') throw new AppError(409, 'ACADEMIC_YEAR_CLOSED', 'Class sections cannot be added to a closed academic year');
    if (!gradeLevel || gradeLevel.status !== 'ACTIVE') {
      throw new AppError(404, 'ACTIVE_GRADE_LEVEL_NOT_FOUND', 'Active grade level not found in this organisation');
    }
    const section = await tx.schoolClassSection.create({
      data: { organisationId, academicYearId, gradeLevelId: gradeLevel.id, name: data.name },
      include: { gradeLevel: true },
    });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.class_section_created',
      entityType: 'school_class_section', entityId: section.id, requestId,
      metadata: { academicYearId, gradeLevelId: gradeLevel.id, name: section.name },
    });
    return section;
  }, { isolationLevel: 'Serializable' });
}

async function updateSection(prisma, organisationId, actorUserId, academicYearId, sectionId, data, requestId) {
  return prisma.$transaction(async function updateSectionTransaction(tx) {
    const [year, current] = await Promise.all([
      findAcademicYear(tx, organisationId, academicYearId),
      tx.schoolClassSection.findFirst({ where: { id: sectionId, organisationId, academicYearId } }),
    ]);
    if (!current) throw new AppError(404, 'SCHOOL_SECTION_NOT_FOUND', 'Class section not found');
    if (year.status === 'CLOSED') throw new AppError(409, 'ACADEMIC_YEAR_CLOSED', 'Class sections in a closed academic year cannot be changed');
    if (current.status === 'CLOSED' && Object.keys(data).some(function hasNonClosedUpdate(key) { return key !== 'status'; })) {
      throw new AppError(409, 'SCHOOL_SECTION_CLOSED', 'A closed class section cannot be changed');
    }
    if (data.status) {
      const allowed = { PLANNED: ['ACTIVE', 'CLOSED'], ACTIVE: ['CLOSED'] };
      assertAllowedTransition(current.status, data.status, allowed, 'Class section');
      if (data.status === 'ACTIVE' && year.status !== 'ACTIVE') {
        throw new AppError(409, 'ACADEMIC_YEAR_NOT_ACTIVE', 'Activate the academic year before activating a class section');
      }
    }
    const updated = await tx.schoolClassSection.update({
      where: { id: current.id },
      data,
      include: { gradeLevel: true },
    });
    await recordAudit(tx, {
      organisationId, actorUserId, action: 'school.class_section_updated',
      entityType: 'school_class_section', entityId: updated.id, requestId,
      metadata: { changedFields: Object.keys(data), academicYearId },
    });
    return updated;
  }, { isolationLevel: 'Serializable' });
}

module.exports = {
  getProfile,
  updateProfile,
  listAcademicYears,
  createAcademicYear,
  updateAcademicYear,
  listTerms,
  createTerm,
  updateTerm,
  listGradeLevels,
  createGradeLevel,
  updateGradeLevel,
  listSections,
  createSection,
  updateSection,
};
