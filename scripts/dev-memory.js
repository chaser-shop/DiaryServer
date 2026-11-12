'use strict';
/*
 * Local development without an external MongoDB: starts an in-memory replica set (with transactions)
 * and the server. Data is lost on exit. Usage: npm run dev:memory  (first run downloads mongod ≈ 80 MB).
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');

(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = rs.getUri('navs');
  const app = require('../server.js');
  await app.start();
  const shutdown = async () => {
    await app.stop().catch(() => {});
    await rs.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
