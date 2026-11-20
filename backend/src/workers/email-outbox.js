require('dotenv').config();
const { loadConfig } = require('../config/env');
const { createPrismaClient } = require('../lib/prisma');
const { createMailer } = require('../modules/auth/mailer');
const { processNextEmail } = require('../modules/notifications/outbox.service');

async function startWorker() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  const mailer = createMailer(config, console);
  await prisma.$connect();
  let stopping = false;
  process.on('SIGINT', function stopOnInterrupt() { stopping = true; });
  process.on('SIGTERM', function stopOnTerminate() { stopping = true; });
  console.info('NexaCore email outbox worker started');
  try {
    while (!stopping) {
      const result = await processNextEmail(prisma, mailer, config, console);
      if (!result.processed) await new Promise(function wait(resolve) { setTimeout(resolve, 1000); });
    }
  } finally {
    await prisma.$disconnect();
    console.info('NexaCore email outbox worker stopped');
  }
}

startWorker().catch(function workerFailed(error) {
  console.error('Email outbox worker failed:', error.message);
  process.exitCode = 1;
});
