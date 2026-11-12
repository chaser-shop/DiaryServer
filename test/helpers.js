'use strict';
/* Test harness: real mongod (in-memory), a local HTTP server standing in for the Google Sheet, and the app. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server-core');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet.csv'), 'utf8');
const ADMIN = 'Адміністраторенко Адмін Адмінович';

async function setup({ replSet = true } = {}) {
  const mongo = replSet
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : await MongoMemoryServer.create();
  const sheet = { body: FIXTURE, status: 200, type: 'text/csv; charset=utf-8', hits: 0, delay: 0 };
  const fixture = http.createServer((req, res) => {
    sheet.hits++;
    const send = () => { res.writeHead(sheet.status, { 'Content-Type': sheet.type }); res.end(sheet.body); };
    if (sheet.delay) setTimeout(send, sheet.delay);
    else send();
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    MONGODB_URI: mongo.getUri('navs'),
    ADMIN_NAMES: ADMIN,
    GOOGLE_SHEET_CSV_URL: `http://127.0.0.1:${fixture.address().port}/sheet.csv`,
    GOOGLE_SHEET_GROUP: 'ТЕСТ-1',
    VAPID_SUBJECT: 'mailto:test@diary.test',
  });
  const app = require('../server.js');
  const { port, ctx } = await app.start({ port: 0, schedulers: false });
  const base = `http://127.0.0.1:${port}`;

  async function call(session, method, p, body) {
    const headers = { Accept: 'application/json' };
    if (session) { headers.Authorization = 'Bearer ' + session.token; headers['X-Device-Id'] = session.deviceId; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  async function login(fullName, deviceId = crypto.randomUUID()) {
    const r = await call(null, 'POST', '/api/auth/login', { fullName, deviceId });
    if (r.status !== 200) throw new Error(`login ${fullName}: ${r.status} ${JSON.stringify(r.data)}`);
    return { token: r.data.token, deviceId, user: r.data.user };
  }
  async function teardown() {
    await app.stop();
    fixture.close();
    await mongo.stop();
  }
  return { app, ctx, call, login, sheet, base, teardown, FIXTURE, ADMIN };
}

module.exports = { setup, FIXTURE, ADMIN };
