require('dotenv').config();
const { createPrismaClient } = require('./lib/prisma');
const { loadConfig } = require('./config/env');
const { createApp } = require('./app');

async function start() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  await prisma.$connect();
  const app = createApp({ prisma, config, logger: console });
  const server = app.listen(config.port, '0.0.0.0', function listening() {
    console.log(`NexaCore API listening on 0.0.0.0:${config.port}`);
  });
  async function shutdown(signal) {
    console.log(`Received ${signal}; shutting down`);
    server.close(async function closeServer() {
      await prisma.$disconnect();
      process.exit(0);
    });
  }
  process.on('SIGINT', function onInterrupt() { shutdown('SIGINT'); });
  process.on('SIGTERM', function onTerminate() { shutdown('SIGTERM'); });
}

start().catch(function startupError(error) {
  console.error('API startup failed:', error.message);
  process.exit(1);
});
