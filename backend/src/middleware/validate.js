function validate(schema, source) {
  return function validateRequest(req, res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues.map(function issueDetails(issue) {
            return { path: issue.path.join('.'), message: issue.message };
          }),
        },
      });
    }
    req[source] = result.data;
    return next();
  };
}

module.exports = { validate };
