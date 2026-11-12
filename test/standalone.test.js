'use strict';
/* Same guarantees without multi-document transactions (standalone mongod): compare-and-swap only. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

let h; let admin; let A;

before(async () => { h = await setup({ replSet: false }); });
after(async () => { if (h) await h.teardown(); });

test('standalone deployment: sync, link, increase and concurrency', async () => {
  assert.equal(h.ctx.txn, false);
  admin = await h.login(h.ADMIN);
  A = await h.login('Гончаренко Галина Григорівна');
  const run = (await h.call(admin, 'POST', '/api/admin/sync/run', {})).data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.stats.newStudents, 8);
  await h.call(admin, 'POST', '/api/admin/link-suggestions/apply', { userIds: [A.user.id] });
  const id = (await h.ctx.col.users.findOne({ _id: A.user.id })).studentId;
  const values = [41, 42, 43, 44, 45, 46, 47, 48];
  const res = await Promise.all(values.map((v) => h.call(A, 'POST', '/api/me/scores/increase', { subject: 'СФП', value: v })));
  const ok = res.filter((r) => r.status === 200).length;
  const d = await h.ctx.col.ratings.findOne({ _id: id });
  assert.equal(d.subjects['СФП'], 48);
  const entries = await h.ctx.col.history.find({ studentId: id, subject: 'СФП', source: 'student' }).toArray();
  assert.equal(entries.length, ok);
  const next = new Map(entries.map((e) => [e.oldValue, e.newValue]));
  let v = 40;
  while (next.has(v)) v = next.get(v);
  assert.equal(v, 48, 'unbroken chain of changes from 40 to 48');
  assert.equal(d.points, Object.values(d.subjects).reduce((a, b) => a + b, 0));
  assert.equal((await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'СФП', value: 47 })).status, 400);
});
