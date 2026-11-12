'use strict';
/*
 * End-to-end tests over HTTP against a MongoDB replica set (transactions on) and a local stand-in for the
 * Google Sheet. Tests run in order and share state, like a real day of work with the gradebook.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const util = require('../lib/util');
const notify = require('../lib/notify');

const A_NAME = 'Андрієнко Андрій Андрійович';
const B_NAME = 'Бойко Богдана Богданівна';
let h; let admin; let A; let B; let A2;
const ids = {};

before(async () => { h = await setup({ replSet: true }); });
after(async () => { if (h) await h.teardown(); });

const sync = (force = false) => h.call(admin, 'POST', '/api/admin/sync/run', { force });
const scoresOf = async (s) => (await h.call(s, 'GET', '/api/me/scores')).data;
const subj = (data, key) => data.subjects.find((x) => x.key === key);
const doc = (id) => h.ctx.col.ratings.findOne({ _id: id });

test('logins: administrator by ADMIN_NAMES, students by full name', async () => {
  admin = await h.login(h.ADMIN);
  assert.equal(admin.user.isAdmin, true);
  A = await h.login(A_NAME);
  B = await h.login(B_NAME);
  assert.equal(A.user.isAdmin, false);
  assert.equal(h.ctx.txn, true, 'replica set → transactions');
});

test('first synchronisation imports the sheet with full history', async () => {
  const r = await sync();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const run = r.data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.method, 'csv_url');
  assert.equal(run.stats.rows, 8);
  assert.equal(run.stats.newStudents, 8);
  assert.equal(run.stats.changedScores, 55);
  assert.equal(run.stats.invalidCells, 1);
  assert.ok(run.warnings.some((w) => w.includes('н/а')));
  assert.equal(await h.ctx.col.history.countDocuments({ group: 'ТЕСТ-1', source: 'sheet' }), 55);
  const students = await h.ctx.col.ratings.find({ group: 'ТЕСТ-1' }).toArray();
  for (const s of students) ids[s.fullName] = s._id;
  const dm = students.find((s) => s.fullName.startsWith('Дмитренко'));
  assert.equal(dm.sheetRemark, 'ПОТРЕБУЄ ОНОВЛЕННЯ');
  assert.equal(students.find((s) => s.fullName === B_NAME).note, 'староста');
});

test('unchanged sheet is not imported again; forced run creates no duplicates', async () => {
  const before = await h.ctx.col.history.countDocuments({});
  const r1 = await sync();
  assert.equal(r1.data.run.status, 'unchanged');
  const r2 = await sync(true);
  assert.equal(r2.data.run.status, 'success');
  assert.equal(r2.data.run.stats.changedScores, 0);
  assert.equal(r2.data.run.stats.newStudents, 0);
  assert.equal(r2.data.run.stats.unchangedStudents, 8);
  assert.equal(await h.ctx.col.history.countDocuments({}), before);
  assert.equal(await h.ctx.col.ratings.countDocuments({ group: 'ТЕСТ-1' }), 8);
});

test('student without a linked rating record cannot change scores', async () => {
  const s = await scoresOf(A);
  assert.equal(s.linked, false);
  const r = await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'СПОУ', value: 30 });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'not_linked');
});

test('administrator links accounts by matching names', async () => {
  const s = await h.call(admin, 'GET', '/api/admin/link-suggestions');
  const names = s.data.items.map((x) => x.userName);
  assert.ok(names.includes(A_NAME) && names.includes(B_NAME));
  const r = await h.call(admin, 'POST', '/api/admin/link-suggestions/apply', { userIds: [A.user.id, B.user.id] });
  assert.equal(r.data.linked, 2);
  const user = await h.ctx.col.users.findOne({ _id: A.user.id });
  assert.equal(user.studentId, ids[A_NAME]);
});

test('student sees own subjects, total and rank', async () => {
  const s = await scoresOf(A);
  assert.equal(s.linked, true);
  assert.equal(s.edit.allowed, true);
  assert.equal(s.subjects.length, 8);
  assert.equal(subj(s, 'СПОУ').value, 21);
  assert.equal(subj(s, 'СПОУ').max, 100);
  assert.equal(s.current.total, 181);
  assert.ok(s.current.rank >= 1);
});

test('student raises a score; history records the change', async () => {
  const r = await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'СПОУ', value: 30, expected: 21 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.entry.oldValue, 21);
  assert.equal(r.data.entry.newValue, 30);
  assert.equal(r.data.entry.delta, 9);
  assert.equal(r.data.entry.source, 'student');
  assert.ok(r.data.entry.opId);
  assert.equal(r.data.total, 190);
  const d = await doc(ids[A_NAME]);
  assert.equal(d.subjects['СПОУ'], 30);
  assert.equal(d.scoreMeta['СПОУ'].source, 'student');
  assert.equal(d.scoreMeta['СПОУ'].sheet, 21, 'last synced value kept');
  assert.equal(d.scoreMeta['СПОУ'].original, 21);
  const hist = await h.call(A, 'GET', '/api/me/history');
  assert.equal(hist.data.items[0].newValue, 30);
});

test('decrease, equal value, over maximum, wrong types and unknown subjects are rejected', async () => {
  const cases = [
    [{ subject: 'СПОУ', value: 25 }, 'not_increase'],
    [{ subject: 'СПОУ', value: 30 }, 'not_increase'],
    [{ subject: 'СПОУ', value: 101 }, 'over_max'],
    [{ subject: 'СПОУ', value: 'abc' }, 'score_type'],
    [{ subject: 'СПОУ', value: true }, 'score_type'],
    [{ subject: 'СПОУ', value: { $gt: 1 } }, 'score_type'],
    [{ subject: 'СПОУ', value: '0x40' }, 'score_type'],
    [{ subject: 'СПОУ', value: -3 }, 'score_negative'],
    [{ subject: 'Астрологія', value: 50 }, 'unknown_subject'],
    [{ subject: 'СПОУ' }, 'score_required'],
  ];
  for (const [body, code] of cases) {
    const r = await h.call(A, 'POST', '/api/me/scores/increase', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.code, code, JSON.stringify(body));
  }
  assert.equal((await doc(ids[A_NAME])).subjects['СПОУ'], 30);
});

test('a student cannot target another student (identity comes from the session)', async () => {
  const r = await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'Укр', value: 25, studentId: ids[B_NAME], userId: B.user.id });
  assert.equal(r.status, 200);
  assert.equal((await doc(ids[A_NAME])).subjects['Укр'], 25);
  assert.equal((await doc(ids[B_NAME])).subjects['Укр'], 34, 'other student untouched');
  const hist = await h.call(A, 'GET', '/api/me/history?limit=100');
  assert.ok(hist.data.items.length > 0);
  assert.ok(hist.data.items.every((x) => x.studentId === undefined));
  const own = await h.ctx.col.history.find({ _id: { $in: hist.data.items.map((x) => x.id) } }).toArray();
  assert.ok(own.every((x) => x.studentId === ids[A_NAME]));
  for (const p of ['/api/admin/dashboard', '/api/admin/students', '/api/admin/score-history', '/api/admin/audit', '/api/admin/sync']) {
    assert.equal((await h.call(A, 'GET', p)).status, 403, p);
  }
  assert.equal((await h.call(A, 'POST', '/api/admin/sync/run', {})).status, 403);
  assert.equal((await h.call(A, 'PUT', `/api/admin/students/${ids[A_NAME]}/scores`, { subject: 'Укр', value: 99, reason: 'хочу' })).status, 403);
});

test('repeated request id is applied once', async () => {
  const body = { subject: 'КПУ', value: 10, requestId: 'req-0000-aaaa-1111' };
  const r1 = await h.call(A, 'POST', '/api/me/scores/increase', body);
  const r2 = await h.call(A, 'POST', '/api/me/scores/increase', body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.replay, true);
  assert.equal(await h.ctx.col.history.countDocuments({ studentId: ids[A_NAME], subject: 'КПУ', source: 'student' }), 1);
});

test('concurrent increases never lose an update', async () => {
  const values = [33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
  const res = await Promise.all(values.map((v) => h.call(B, 'POST', '/api/me/scores/increase', { subject: 'СФП', value: v })));
  const ok = res.filter((r) => r.status === 200).length;
  assert.ok(ok >= 1);
  assert.ok(res.every((r) => r.status === 200 || r.data.code === 'not_increase'), JSON.stringify(res.map((r) => r.data)));
  const d = await doc(ids[B_NAME]);
  assert.equal(d.subjects['СФП'], 42);
  const entries = await h.ctx.col.history.find({ studentId: ids[B_NAME], subject: 'СФП', source: 'student' }).toArray();
  assert.equal(entries.length, ok);
  // Every change starts exactly where the previous one ended: 32 → … → 42.
  const next = new Map(entries.map((e) => [e.oldValue, e.newValue]));
  let v = 32;
  let steps = 0;
  while (next.has(v)) { const n = next.get(v); assert.ok(n > v); v = n; steps++; }
  assert.equal(v, 42);
  assert.equal(steps, ok);
  assert.equal(d.points, Object.values(d.subjects).reduce((a, b) => a + b, 0));
});

test('auto-added device must be trusted by an administrator before changing scores', async () => {
  A2 = await h.login(A_NAME);
  const r = await h.call(A2, 'POST', '/api/me/scores/increase', { subject: 'Англ', value: 31 });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'device_untrusted');
  assert.equal((await scoresOf(A2)).edit.code, 'device_untrusted');
  const users = (await h.call(admin, 'GET', '/api/admin/users')).data;
  const dev = users.find((u) => u.id === A.user.id).deviceList.find((d) => !d.trusted);
  assert.ok(dev);
  const t = await h.call(admin, 'POST', `/api/admin/users/${A.user.id}/devices/${dev.key}/trust`, { trusted: true });
  assert.equal(t.status, 200);
  assert.equal((await h.call(A2, 'POST', '/api/me/scores/increase', { subject: 'Англ', value: 31 })).status, 200);
  // Removing the device revokes its session immediately.
  assert.equal((await h.call(admin, 'DELETE', `/api/admin/users/${A.user.id}/devices/${dev.key}`)).status, 200);
  assert.equal((await h.call(A2, 'GET', '/api/sync')).status, 401);
  assert.equal((await h.call(A, 'GET', '/api/sync')).status, 200);
});

test('sheet updates: authoritative changes apply, lower values on student scores become conflicts', async () => {
  assert.equal((await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'Інформ', value: 60 })).status, 200);
  h.sheet.body = h.FIXTURE
    .replace('1,Андрієнко Андрій Андрійович,21,21,21,12,7,48,21,30,', '1,Андрієнко Андрій Андрійович,25,18,21,12,7,70,21,30,')
    .replace(',65,58,72,', ',65,58,80,');
  const r = await sync();
  const run = r.data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.stats.changedScores, 3, JSON.stringify(run.stats));
  assert.equal(run.stats.conflicts, 1);
  const a = await doc(ids[A_NAME]);
  assert.equal(a.subjects['СПОУ'], 30, 'student score not overwritten by lower sheet value');
  assert.equal(a.subjects['ТіДтП'], 18, 'sheet-sourced value follows the sheet');
  assert.equal(a.subjects['Інформ'], 70, 'higher sheet value supersedes the student value');
  assert.equal((await doc(ids[B_NAME])).subjects['Англ'], 80);
  const c = (await h.call(admin, 'GET', '/api/admin/conflicts')).data;
  assert.equal(c.open, 1);
  assert.deepEqual([c.items[0].subject, c.items[0].sheetPrev, c.items[0].sheetValue, c.items[0].effectiveValue, c.items[0].effectiveSource, c.items[0].currentValue],
    ['СПОУ', 21, 25, 30, 'student', 30]);
  ids.conflict = c.items[0].id;
  // B was notified about the sheet change.
  const nb = (await h.call(B, 'GET', '/api/me/notifications')).data;
  assert.ok(nb.items.some((n) => n.type === 'sheet_update' && n.body.includes('«Англ»: 72 → 80 (+8)')), JSON.stringify(nb.items));
});

test('a conflict is updated, not duplicated, and an administrator resolves it traceably', async () => {
  assert.equal((await sync()).data.run.status, 'unchanged');
  h.sheet.body = h.sheet.body.replace('1,Андрієнко Андрій Андрійович,25,', '1,Андрієнко Андрій Андрійович,27,');
  const r = await sync();
  assert.equal(r.data.run.stats.conflicts, 1);
  const c = (await h.call(admin, 'GET', '/api/admin/conflicts')).data;
  assert.equal(c.open, 1);
  assert.equal(c.items[0].id, ids.conflict);
  assert.equal(c.items[0].sheetValue, 27);
  assert.equal(c.items[0].sheetValues.length, 2);
  const res = await h.call(admin, 'POST', `/api/admin/conflicts/${ids.conflict}/resolve`, { resolution: 'accept_sheet', note: 'Перевірено з викладачем' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.conflict.status, 'resolved');
  assert.equal((await doc(ids[A_NAME])).subjects['СПОУ'], 27);
  const e = await h.ctx.col.history.findOne({ conflictId: ids.conflict });
  assert.deepEqual([e.source, e.oldValue, e.newValue], ['admin', 30, 27]);
  assert.equal((await h.call(admin, 'POST', `/api/admin/conflicts/${ids.conflict}/resolve`, { resolution: 'keep_current' })).status, 409);
  const na = (await h.call(A, 'GET', '/api/me/notifications')).data;
  assert.ok(na.items.some((n) => n.type === 'admin_change' && n.body.includes('30 → 27')));
});

test('new, removed and returning rows; removed students are archived, not deleted', async () => {
  h.sheet.body += '9,Ігнатенко Ігор Ігорович,10,10,10,10,10,10,10,10,\n';
  let run = (await sync()).data.run;
  assert.equal(run.stats.newStudents, 1);
  assert.equal(run.stats.changedScores, 8);
  const full = h.sheet.body;
  h.sheet.body = full.split('\n').filter((l) => !l.includes('Заєць')).join('\n');
  run = (await sync()).data.run;
  assert.equal(run.stats.archived, 1);
  const z = await doc(ids['Заєць Зіновій Захарович']);
  assert.equal(z.active, false);
  assert.equal(z.archivedReason, 'Відсутній у Google-таблиці');
  assert.ok(await h.ctx.col.history.countDocuments({ studentId: z._id }) > 0, 'history kept');
  const rating = (await h.call(admin, 'GET', '/api/rating?group=' + encodeURIComponent('ТЕСТ-1'))).data;
  assert.equal(rating.entries.some((e) => e.fullName.startsWith('Заєць')), false);
  h.sheet.body = full;
  run = (await sync()).data.run;
  assert.equal(run.stats.reactivated, 1);
  assert.equal((await doc(ids['Заєць Зіновій Захарович'])).active, true);
});

test('safety guard stops a suspicious automatic import; administrator can force it', async () => {
  const full = h.sheet.body;
  h.sheet.body = full.split('\n').slice(0, 4).join('\n');
  let run = (await sync()).data.run;
  assert.equal(run.status, 'aborted');
  assert.match(run.error, /бракує/);
  assert.equal(await h.ctx.col.ratings.countDocuments({ group: 'ТЕСТ-1', active: { $ne: false } }), 9);
  run = (await sync(true)).data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.stats.archived, 6);
  h.sheet.body = full;
  run = (await sync()).data.run;
  assert.equal(run.stats.reactivated, 6);
});

test('download errors are recorded and data is preserved', async () => {
  const total = (await doc(ids[A_NAME])).points;
  h.sheet.status = 500;
  let run = (await sync()).data.run;
  assert.equal(run.status, 'error');
  assert.match(run.error, /HTTP 500/);
  h.sheet.status = 200;
  h.sheet.type = 'text/html; charset=utf-8';
  const body = h.sheet.body;
  h.sheet.body = '<!doctype html><html><body>Sign in</body></html>';
  run = (await sync()).data.run;
  assert.equal(run.status, 'error');
  assert.match(run.error, /сторінку входу/);
  let st = (await h.call(admin, 'GET', '/api/admin/sync')).data;
  assert.equal(st.state.consecutiveErrors, 2);
  assert.ok(st.runs.items.length >= 2);
  h.sheet.type = 'text/csv; charset=utf-8';
  h.sheet.body = body;
  run = (await sync()).data.run;
  assert.equal(run.status, 'unchanged');
  st = (await h.call(admin, 'GET', '/api/admin/sync')).data;
  assert.equal(st.state.consecutiveErrors, 0);
  assert.equal((await doc(ids[A_NAME])).points, total);
});

test('administrator correction requires a reason and notifies the student', async () => {
  const url = `/api/admin/students/${ids[A_NAME]}/scores`;
  assert.equal((await h.call(admin, 'PUT', url, { subject: 'Укр', value: 20 })).data.code, 'reason_required');
  assert.equal((await h.call(admin, 'PUT', url, { subject: 'Укр', value: 120, reason: 'Помилка' })).data.code, 'over_max');
  const r = await h.call(admin, 'PUT', url, { subject: 'Укр', value: 20, reason: 'Помилка введення' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.entry.source, r.data.entry.oldValue, r.data.entry.newValue], ['admin', 25, 20]);
  const na = (await h.call(A, 'GET', '/api/me/notifications')).data;
  assert.ok(na.items.some((n) => n.body.includes('«Укр»: 25 → 20') && n.body.includes('Помилка введення')));
});

test('daily statistics and notifications use real history (next day)', async () => {
  const today = util.dayKey(new Date());
  const tomorrow = util.addDays(today, 1);
  const at21 = new Date(util.dayStart(tomorrow).getTime() + 21 * 3600 * 1000);
  h.ctx.now = () => at21;
  try {
    const before = (await doc(ids[A_NAME])).points;
    const inc = await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'Укр', value: 32 });
    assert.equal(inc.status, 200);
    await h.app.progressTick();
    const notes = (await h.call(A, 'GET', '/api/me/notifications')).data;
    const bodies = notes.items.map((n) => n.body);
    assert.ok(bodies.includes('Ваш загальний рейтинг зріс на 12 балів за останню добу.'), JSON.stringify(bodies));
    assert.ok(bodies.includes('Ваш результат із предмета «Укр» покращився на 60% порівняно з учорашнім днем.'), JSON.stringify(bodies));
    const count = await h.ctx.col.notifications.countDocuments({});
    await h.app.progressTick();
    assert.equal((await notify.dailyDigest(at21)).created, 0, 'no duplicate summaries');
    assert.equal(await h.ctx.col.notifications.countDocuments({}), count);

    const st = (await h.call(A, 'GET', '/api/me/stats?range=7d')).data;
    assert.equal(st.linked, true);
    assert.equal(st.range.to, tomorrow);
    assert.equal(st.historySince, today);
    assert.equal(st.daily.available, true);
    assert.equal(st.daily.baseTotal, before);
    assert.equal(st.daily.delta, 12);
    assert.equal(st.daily.pct, util.pctChange(before, before + 12));
    assert.equal(st.weekly.available, false, 'no data from a week ago');
    assert.equal(st.weekly.since, today);
    assert.equal(subj(st, 'Укр').previous, 20);
    assert.equal(subj(st, 'Укр').delta, 12);
    assert.equal(subj(st, 'Укр').pct, 60);
    assert.ok(st.series.length >= 2);
    assert.ok(Array.isArray(st.periods.day));
    const custom = await h.call(A, 'GET', `/api/me/stats?range=custom&from=${today}&to=${tomorrow}`);
    assert.equal(custom.status, 200);
    assert.equal((await h.call(A, 'GET', `/api/me/stats?range=custom&from=${tomorrow}&to=${today}`)).status, 400);

    const unread = notes.unread;
    assert.ok(unread >= 2);
    const read = await h.call(A, 'POST', '/api/me/notifications/read', { all: true });
    assert.equal(read.data.unread, 0);
  } finally {
    h.ctx.now = () => new Date();
  }
});

test('administrator dashboard and student list match the database', async () => {
  const d = (await h.call(admin, 'GET', '/api/admin/dashboard')).data;
  const active = await h.ctx.col.ratings.find({ active: { $ne: false } }).toArray();
  assert.equal(d.kpis.students, active.length);
  assert.equal(d.kpis.groups, 2);
  const all = active.flatMap((r) => Object.values(r.subjects || {}));
  assert.equal(d.kpis.scores, all.length);
  assert.equal(d.kpis.avgScore, util.round2(all.reduce((a, b) => a + b, 0) / all.length));
  assert.equal(d.kpis.highest.value, Math.max(...all));
  assert.equal(d.kpis.lowest.value, Math.min(...all));
  assert.equal(d.distribution.reduce((a, b) => a + b.count, 0) + d.unscored, active.length);
  assert.equal(d.sync.configured, true);
  const q = (await h.call(admin, 'GET', '/api/admin/students?q=' + encodeURIComponent('андрієнко'))).data;
  assert.equal(q.total, 1);
  assert.equal(q.items[0].accounts.length, 1);
  const p = (await h.call(admin, 'GET', '/api/admin/students?group=' + encodeURIComponent('ТЕСТ-1') + '&sort=total&dir=desc&limit=5')).data;
  assert.equal(p.total, 9);
  assert.equal(p.pages, 2);
  for (let i = 1; i < p.items.length; i++) assert.ok((p.items[i - 1].total ?? -1) >= (p.items[i].total ?? -1));
  const prof = (await h.call(admin, 'GET', `/api/admin/students/${ids[A_NAME]}`)).data;
  assert.equal(prof.student.fullName, A_NAME);
  assert.ok(prof.recent.length > 0);
  const an = await h.call(admin, 'GET', '/api/admin/analytics?range=30d');
  assert.equal(an.status, 200);
  assert.ok(Array.isArray(an.data.subjectImprovement));
});

test('history and audit log are complete, filterable and cannot be deleted', async () => {
  const hs = (await h.call(admin, 'GET', '/api/admin/score-history?source=student&limit=100')).data;
  assert.ok(hs.items.length > 0 && hs.items.every((x) => x.source === 'student'));
  const mine = (await h.call(admin, 'GET', `/api/admin/score-history?studentId=${ids[A_NAME]}&limit=100`)).data;
  assert.ok(mine.items.every((x) => x.studentId === ids[A_NAME]));
  const audit = (await h.call(admin, 'GET', '/api/admin/audit?limit=100')).data;
  const actions = new Set(audit.items.map((x) => x.action));
  for (const a of ['score.increase', 'score.admin_set', 'conflict.resolve', 'sync.manual', 'sync.force', 'device.trust', 'device.remove', 'user.link_student']) {
    assert.ok(actions.has(a), a);
  }
  assert.equal((await h.call(admin, 'DELETE', '/api/admin/audit')).status, 405);
  assert.equal((await h.call(admin, 'DELETE', '/api/admin/score-history')).status, 405);
});

test('subject catalog: title and maximum are editable and enforced', async () => {
  const cat = (await h.call(admin, 'GET', '/api/admin/catalog')).data;
  assert.ok(cat.items.some((c) => c.key === 'Укр'));
  assert.equal((await h.call(admin, 'PUT', '/api/admin/catalog/' + encodeURIComponent('Укр'), { title: 'Українська мова', maxScore: 35 })).status, 200);
  const s = await scoresOf(A);
  assert.equal(subj(s, 'Укр').title, 'Українська мова');
  const r = await h.call(A, 'POST', '/api/me/scores/increase', { subject: 'Укр', value: 36 });
  assert.equal(r.data.code, 'over_max');
});

test('score history: a first value has no change amount, legacy entries are corrected, titles are included', async () => {
  const id = ids[A_NAME];
  assert.equal(await h.ctx.col.history.countDocuments({ oldValue: null, delta: { $ne: null } }), 0, 'stored without a fake «+N»');
  await h.ctx.col.history.insertOne({
    _id: 'legacy-first-value', at: new Date(), studentId: id, studentName: A_NAME, group: 'ТЕСТ-1', subject: 'Укр',
    oldValue: null, newValue: 35, delta: 35, source: 'sheet', actorName: 'Google Sheets',
  });
  const r = await h.call(admin, 'GET', `/api/admin/score-history?studentId=${encodeURIComponent(id)}&limit=100`);
  assert.equal(r.status, 200);
  const legacy = r.data.items.find((x) => x.id === 'legacy-first-value');
  assert.equal(legacy.delta, null);
  assert.equal(legacy.subjectTitle, 'Українська мова');
  for (const x of r.data.items) {
    assert.equal(x.delta, typeof x.oldValue === 'number' && typeof x.newValue === 'number' ? util.round2(x.newValue - x.oldValue) : null);
  }
  const mine = (await h.call(A, 'GET', '/api/me/history?limit=100')).data.items;
  assert.equal(mine.find((x) => x.id === 'legacy-first-value').delta, null);
  const dash = (await h.call(admin, 'GET', '/api/admin/dashboard')).data;
  assert.ok(dash.recent.filter((x) => x.kind === 'score').every((x) => 'subjectTitle' in x));
  await h.ctx.col.history.deleteOne({ _id: 'legacy-first-value' });
});

test('groups: create, validate, prevent duplicates, rename and delete without losing students', async () => {
  const groups = async () => (await h.call(admin, 'GET', '/api/admin/groups')).data;
  assert.equal((await h.call(A, 'POST', '/api/admin/groups', { name: 'ТЕСТ-2' })).status, 403, 'administrators only');
  assert.equal((await h.call(admin, 'POST', '/api/admin/groups', { name: '  ТЕСТ-2 ' })).status, 200);
  let r = await h.call(admin, 'POST', '/api/admin/groups', { name: 'тест-2' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'group_exists');
  for (const bad of ['', 'А', '<b>x</b>', 'Г'.repeat(41)]) {
    assert.equal((await h.call(admin, 'POST', '/api/admin/groups', { name: bad })).status, 400, `«${bad}»`);
  }
  let list = await groups();
  assert.equal(list.find((g) => g.name === 'ТЕСТ-1').synced, true);
  assert.deepEqual(list.find((g) => g.name === 'ТЕСТ-2'), { name: 'ТЕСТ-2', students: 0, archived: 0, accounts: 0, synced: false });

  assert.equal((await h.call(admin, 'PATCH', '/api/admin/groups', { from: 'ТЕСТ-2', to: 'тест-1' })).data.code, 'group_exists');
  assert.equal((await h.call(admin, 'PATCH', '/api/admin/groups', { from: 'ТЕСТ-2', to: 'ТЕСТ-3' })).status, 200);
  const created = await h.call(admin, 'POST', '/api/admin/rating', { fullName: 'Шевчук Олег Петрович', group: 'ТЕСТ-3', subjects: { СПОУ: 50 } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const sid = created.data.id;
  const historyBefore = await h.ctx.col.history.countDocuments({ studentId: sid });
  const acc = await h.login('Шевчук Олег Петрович');
  assert.equal((await h.call(admin, 'POST', `/api/admin/users/${acc.user.id}/group`, { group: 'ТЕСТ-3' })).status, 200);

  r = await h.call(admin, 'DELETE', '/api/admin/groups/' + encodeURIComponent('ТЕСТ-3'));
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'group_not_empty');
  assert.equal(r.data.students, 1);
  assert.equal(r.data.accounts, 1);
  // Moving into a group that already has a student with the same name is refused (no silent merge).
  await h.call(admin, 'POST', '/api/admin/rating', { fullName: A_NAME, group: 'ТЕСТ-3' });
  r = await h.call(admin, 'DELETE', `/api/admin/groups/${encodeURIComponent('ТЕСТ-3')}?moveTo=${encodeURIComponent('ТЕСТ-1')}`);
  assert.equal(r.data.code, 'group_name_clash');
  assert.deepEqual(r.data.names, [A_NAME]);
  assert.equal((await h.call(admin, 'DELETE', '/api/admin/groups/' + encodeURIComponent('ТЕСТ-1'))).data.code, 'group_synced');

  await h.call(admin, 'POST', '/api/admin/groups', { name: 'ТЕСТ-4' });
  r = await h.call(admin, 'DELETE', `/api/admin/groups/${encodeURIComponent('ТЕСТ-3')}?moveTo=${encodeURIComponent('ТЕСТ-4')}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await doc(sid)).group, 'ТЕСТ-4', 'same record, new group');
  assert.equal(await h.ctx.col.history.countDocuments({ studentId: sid }), historyBefore, 'history kept');
  assert.equal((await h.ctx.col.users.findOne({ _id: acc.user.id })).group, 'ТЕСТ-4');
  list = await groups();
  assert.equal(list.some((g) => g.name === 'ТЕСТ-3'), false);
  assert.equal(list.find((g) => g.name === 'ТЕСТ-4').students, 2);
  assert.ok(await h.ctx.col.audit.findOne({ action: 'group.delete', 'details.movedTo': 'ТЕСТ-4' }));
  assert.equal(await h.ctx.col.history.countDocuments({ studentId: sid, group: { $ne: 'ТЕСТ-4' } }), 0, 'history follows the group');

  // Renaming the synchronised group while a run is downloading the sheet: the rename waits for the run
  // (which would otherwise find the old group empty and re-create everyone); the sheet keeps filling it.
  const inSync = await h.ctx.col.ratings.countDocuments({ group: 'ТЕСТ-1' });
  h.sheet.delay = 400;
  const hits = h.sheet.hits;
  const overlapping = sync();
  while (h.sheet.hits === hits) await new Promise((resolve) => setTimeout(resolve, 10));
  r = await h.call(admin, 'PATCH', '/api/admin/groups', { from: 'ТЕСТ-1', to: 'ТЕСТ-1А' });
  h.sheet.delay = 0;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.synced, true);
  const o = await overlapping;
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(o.data.run.stats.newStudents, 0);
  assert.equal(await h.ctx.col.history.countDocuments({ group: 'ТЕСТ-1' }), 0, 'history follows the rename');
  const run = (await sync()).data.run;
  assert.equal(run.status, 'unchanged');
  assert.equal(run.stats.newStudents, 0);
  assert.equal(await h.ctx.col.ratings.countDocuments({ group: 'ТЕСТ-1А' }), inSync);
  assert.equal(await h.ctx.col.ratings.countDocuments({ group: 'ТЕСТ-1' }), 0);
  assert.equal((await h.call(admin, 'GET', '/api/admin/sync')).data.settings.group, 'ТЕСТ-1А');
  assert.equal((await h.call(admin, 'PATCH', '/api/admin/groups', { from: 'ТЕСТ-1А', to: 'ТЕСТ-1' })).status, 200);
  assert.equal((await groups()).find((g) => g.name === 'ТЕСТ-1').synced, true);
});

test('sync: a corrected name keeps the record, a different person does not, an administrator archive is kept', async () => {
  const full = h.sheet.body;
  const ev = ids['Євтушенко Єва Євгенівна'];
  const before = await doc(ev);
  h.sheet.body = full.replace('Євтушенко Єва Євгенівна', 'Євтушенко Єва Євгеніївна');
  let run = (await sync()).data.run;
  assert.equal(run.stats.renamed, 1);
  assert.equal(run.stats.newStudents, 0);
  assert.equal(run.stats.archived, 0);
  const d = await doc(ev);
  assert.equal(d.fullName, 'Євтушенко Єва Євгеніївна');
  assert.equal(d.active, true);
  assert.deepEqual(d.subjects, before.subjects);
  assert.ok(run.warnings.some((w) => w.startsWith('ПІБ виправлено')));
  h.sheet.body = full;
  run = (await sync()).data.run;
  assert.equal(run.stats.renamed, 1);
  assert.equal((await doc(ev)).fullName, 'Євтушенко Єва Євгенівна');

  // Another person in the same row is a new student; the old one is archived, never merged.
  h.sheet.body = full.replace('Євтушенко Єва Євгенівна', 'Ковальчук Марина Олегівна');
  run = (await sync()).data.run;
  assert.equal(run.stats.renamed, 0);
  assert.equal(run.stats.newStudents, 1);
  assert.equal(run.stats.archived, 1);
  h.sheet.body = full;
  run = (await sync()).data.run;
  assert.equal(run.stats.reactivated, 1);
  assert.equal((await doc(ev)).active, true);

  // An administrator's archive is not undone by the next run, even though the student is in the sheet.
  const g = ids['Гончаренко Галина Григорівна'];
  assert.equal((await h.call(admin, 'POST', `/api/admin/students/${g}/archive`, { archived: true, reason: 'Академвідпустка' })).status, 200);
  run = (await sync()).data.run;
  assert.equal((await doc(g)).active, false);
  assert.ok(run.warnings.some((w) => w.includes('архівований адміністратором')));
  // A corrected name for an archived student renames the archived record; it is not restored as a new one.
  h.sheet.body = full.replace('Гончаренко Галина Григорівна', 'Гончаренко Галина Григоріївна');
  run = (await sync()).data.run;
  assert.equal(run.stats.renamed, 1);
  assert.equal(run.stats.newStudents, 0);
  assert.equal((await doc(g)).fullName, 'Гончаренко Галина Григоріївна');
  assert.equal((await doc(g)).active, false);
  assert.equal(await h.ctx.col.ratings.countDocuments({ nameKey: util.ratingKey('Гончаренко Галина Григоріївна') }), 1);
  h.sheet.body = full;
  run = (await sync()).data.run;
  assert.equal((await doc(g)).fullName, 'Гончаренко Галина Григорівна');
  assert.equal((await doc(g)).active, false);
  assert.equal((await h.call(admin, 'POST', `/api/admin/students/${g}/archive`, { archived: false })).status, 200);
  assert.equal((await doc(g)).active, true);

  // A student deleted in the app while still in the sheet comes back on the next run (the sheet is unchanged).
  assert.equal((await h.call(admin, 'DELETE', `/api/admin/rating/${ids['Жук Жанна Жорівна']}`)).status, 200);
  run = (await sync()).data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.stats.newStudents, 1);
  assert.ok(await h.ctx.col.ratings.findOne({ group: 'ТЕСТ-1', nameKey: util.ratingKey('Жук Жанна Жорівна'), active: { $ne: false } }));
  assert.equal((await sync()).data.run.status, 'unchanged');
});
