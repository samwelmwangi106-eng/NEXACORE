const nodemailer = require('nodemailer');

function createMailer(config, logger) {
  if (config.mailMode === 'smtp') {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      requireTLS: !config.smtpSecure,
      tls: { minVersion: 'TLSv1.2' },
      ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPassword } } : {}),
    });
    return {
      async send(message) {
        await transport.sendMail({
          from: config.mailFrom,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
      },
    };
  }

  if (config.nodeEnv === 'production') {
    throw new Error('Console email transport is disabled in production');
  }
  return {
    async send(message) {
      const log = logger && logger.info ? logger.info.bind(logger) : console.info;
      log(`[DEV EMAIL] to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}

module.exports = { createMailer };
