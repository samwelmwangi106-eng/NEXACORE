const { AppError } = require('../../lib/errors');

function assertAllowedTransition(currentStatus, newStatus, allowedTransitions, resourceName) {
  const allowed = allowedTransitions[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `${resourceName} status cannot change from ${currentStatus} to ${newStatus}`);
  }
}

module.exports = {
  getProfile: async function(prisma, organisationId) {
    const profile = await prisma.schoolProfile.findUnique({
      where: { organisationId },
      include: { organisation: true }
    });
    if (!profile) throw new AppError(404, 'SCHOOL_PROFILE_NOT_FOUND', 'School profile not found');
    return profile;
  },

  updateProfile: async function(prisma, organisationId, actorUserId, data, requestId) {
    const profile = await prisma.$transaction(async (tx) => {
      const current = await tx.schoolProfile.findUnique({ where: { organisationId } });
      if (!current) throw new AppError(404, 'SCHOOL_PROFILE_NOT_FOUND', 'School profile not found');
      
      const updated = await tx.schoolProfile.update({
        where: { organisationId },
        data,
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.profile_updated',
          entityType: 'school_profile',
          entityId: updated.id,
          requestId,
          metadata: { changedFields: Object.keys(data) }
        }
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return profile;
  },

  listAcademicYears: async function(prisma, organisationId) {
    return await prisma.schoolAcademicYear.findMany({
      where: { organisationId },
      orderBy: { startsOn: 'desc' }
    });
  },

  createAcademicYear: async function(prisma, organisationId, actorUserId, data, requestId) {
    const year = await prisma.$transaction(async (tx) => {
      const created = await tx.schoolAcademicYear.create({
        data: { organisationId, ...data }
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.academic_year_created',
          entityType: 'school_academic_year',
          entityId: created.id,
          requestId,
          metadata: { data }
        }
      });
      return created;
    }, { isolationLevel: 'Serializable' });
    return year;
  },

  updateAcademicYear: async function(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
    const year = await prisma.$transaction(async (tx) => {
      const current = await tx.schoolAcademicYear.findUnique({
        where: { id: academicYearId, organisationId }
      });
      if (!current) throw new AppError(404, 'SCHOOL_ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
      
      if (data.status) {
        const allowed = { DRAFT: ['ACTIVE', 'CLOSED'], ACTIVE: ['CLOSED'] };
        assertAllowedTransition(current.status, data.status, allowed, 'Academic year');
      }

      const updated = await tx.schoolAcademicYear.update({
        where: { id: academicYearId },
        data,
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.academic_year_updated',
          entityType: 'school_academic_year',
          entityId: updated.id,
          requestId,
          metadata: { changedFields: Object.keys(data) }
        }
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return year;
  },

  listTerms: async function(prisma, organisationId, academicYearId) {
    return await prisma.schoolTerm.findMany({
      where: { organisationId, academicYearId },
      orderBy: { sequence: 'asc' }
    });
  },

  createTerm: async function(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
    const term = await prisma.$transaction(async (tx) => {
      const year = await tx.schoolAcademicYear.findUnique({ where: { id: academicYearId, organisationId } });
      if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
      
      const created = await tx.schoolTerm.create({
        data: { organisationId, academicYearId, ...data }
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.term_created',
          entityType: 'school_term',
          entityId: created.id,
          requestId,
          metadata: { data }
        }
      });
      return created;
    }, { isolationLevel: 'Serializable' });
    return term;
  },

  updateTerm: async function(prisma, organisationId, actorUserId, academicYearId, termId, data, requestId) {
    const term = await prisma.$transaction(async (tx) => {
      const current = await tx.schoolTerm.findUnique({
        where: { id: termId, organisationId, academicYearId }
      });
      if (!current) throw new AppError(404, 'SCHOOL_TERM_NOT_FOUND', 'School term not found');
      
      if (data.status) {
        const allowed = { PLANNED: ['ACTIVE', 'CLOSED'], ACTIVE: ['CLOSED'] };
        assertAllowedTransition(current.status, data.status, allowed, 'School term');
        if (data.status === 'ACTIVE' && current.academicYear.status !== 'ACTIVE') {
          throw new AppError(409, 'ACADEMIC_YEAR_NOT_ACTIVE', 'Activate the academic year before activating a school term');
        }
      }

      const updated = await tx.schoolTerm.update({
        where: { id: termId },
        data,
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.term_updated',
          entityType: 'school_term',
          entityId: updated.id,
          requestId,
          metadata: { changedFields: Object.keys(data) }
        }
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return term;
  },

  listGradeLevels: async function(prisma, organisationId) {
    return await prisma.schoolGradeLevel.findMany({
      where: { organisationId },
      orderBy: { sortOrder: 'asc' }
    });
  },

  createGradeLevel: async function(prisma, organisationId, actorUserId, data, requestId) {
    const level = await prisma.$transaction(async (tx) => {
      const created = await tx.schoolGradeLevel.create({
        data: { organisationId, ...data }
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.grade_level_created',
          entityType: 'school_grade_level',
          entityId: created.id,
          requestId,
          metadata: { data }
        }
      });
      return created;
    }, { isolationLevel: 'Serializable' });
    return level;
  },

  updateGradeLevel: async function(prisma, organisationId, actorUserId, gradeLevelId, data, requestId) {
    const level = await prisma.$transaction(async (tx) => {
      const current = await tx.schoolGradeLevel.findUnique({
        where: { id: gradeLevelId, organisationId }
      });
      if (!current) throw new AppError(404, 'SCHOOL_GRADE_LEVEL_NOT_FOUND', 'Grade level not found');
      
      if (data.status) {
        const allowed = { ACTIVE: ['INACTIVE'] };
        assertAllowedTransition(current.status, data.status, allowed, 'Grade level');
      }

      const updated = await tx.schoolGradeLevel.update({
        where: { id: gradeLevelId },
        data,
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.grade_level_updated',
          entityType: 'school_grade_level',
          entityId: updated.id,
          requestId,
          metadata: { changedFields: Object.keys(data) }
        }
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return level;
  },

  listSections: async function(prisma, organisationId, academicYearId) {
    return await prisma.schoolClassSection.findMany({
      where: { organisationId, academicYearId },
      include: { gradeLevel: true },
      orderBy: { name: 'asc' }
    });
  },

  createSection: async function(prisma, organisationId, actorUserId, academicYearId, data, requestId) {
    const section = await prisma.$transaction(async (tx) => {
      const year = await tx.schoolAcademicYear.findUnique({ where: { id: academicYearId, organisationId } });
      if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
      
      const created = await tx.schoolClassSection.create({
        data: { organisationId, academicYearId, ...data }
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.class_section_created',
          entityType: 'school_class_section',
          entityId: created.id,
          requestId,
          metadata: { data }
        }
      });
      return created;
    }, { isolationLevel: 'Serializable' });
    return section;
  },

  updateSection: async function(prisma, organisationId, actorUserId, academicYearId, sectionId, data, requestId) {
    const section = await prisma.$transaction(async (tx) => {
      const current = await tx.schoolClassSection.findUnique({
        where: { id: sectionId, organisationId, academicYearId }
      });
      if (!current) throw new AppError(404, 'SCHOOL_SECTION_NOT_FOUND', 'Class section not found');
      
      const year = await tx.schoolAcademicYear.findUnique({ where: { id: academicYearId, organisationId } });
      if (!year) throw new AppError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');

      if (data.status) {
        const allowed = { PLANNED: ['ACTIVE', 'CLOSED'], ACTIVE: ['CLOSED'] };
        assertAllowedTransition(current.status, data.status, allowed, 'Class section');
        if (data.status === 'ACTIVE' && year.status !== 'ACTIVE') {
          throw new AppError(409, 'ACADEMIC_YEAR_NOT_ACTIVE', 'Activate the academic year before activating a class section');
        }
      }

      const updated = await tx.schoolClassSection.update({
        where: { id: sectionId },
        data,
        include: { gradeLevel: true },
      });
      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId,
          action: 'school.class_section_updated',
          entityType: 'school_class_section',
          entityId: updated.id,
          requestId,
          metadata: { changedFields: Object.keys(data), academicYearId }
        }
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return section;
  },
};

