async function recordAudit(prisma, event) {
  return prisma.auditLog.create({
    data: {
      organisationId: event.organisationId || null,
      actorUserId: event.actorUserId || null,
      action: event.action,
      entityType: event.entityType || null,
      entityId: event.entityId || null,
      requestId: event.requestId || null,
      metadata: event.metadata || {},
    },
  });
}

module.exports = { recordAudit };
