class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

function notFound(message) {
  return new AppError(404, 'NOT_FOUND', message || 'Resource not found');
}

module.exports = { AppError, notFound };
