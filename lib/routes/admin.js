'use strict';
/* Administrator endpoints: dashboard, analytics, students, history, audit, synchronisation, conflicts, catalog. */

const ctx = require('../context');
const scores = require('../scores');
const stats = require('../stats');
const sync = require('../sync');
const notify = require('../notify');
const { audit } = require('../audit');
const { pubHistory, subjectTitles } = require('./me');
const {
  HttpError, str, toDate, clampInt, escapeRegex, normKey, ratingKey, cleanSubjectKey, parseScore, isDayKey, dayStart, addDays,
} = require('../util');

const page = (query) => ({
  page: Math.max(1, parseInt(query.get('page'), 10) || 1),
  limit: clampInt(query.get('limit'), 5, 100, 25),
});

async function paged(col, filter, sort, query, map) {
  const { page: p, limit } = page(query);
  const [total, items] = await Promise.all([
    col.countDocuments(filter),
    col.find(filter).sort(sort).skip((p - 1) * limit).limit(limit).toArray(),
  ]);
  return { items: items.map(map), total, page: p, pages: Math.max(1, Math.ceil(total / limit)), limit };
}

function dateRangeFilter(query) {
  const f = {};
  const from = query.get('from');
  const to = query.get('to');
  if (from && isDayKey(from)) f.$gte = dayStart(from);
  if (to && isDayKey(to)) f.$lt = dayStart(addDays(to, 1));
  return Object.keys(f).length ? f : null;
}

const pubConflict = (c) => ({
  id: c._id, status: c.status, studentId: c.studentId, studentName: c.studentName, group: c.group, subject: c.subject,
  sheetPrev: c.sheetPrev == null ? null : c.sheetPrev, sheetValue: c.sheetValue == null ? null : c.sheetValue, sheetValues: c.sheetValues || [],
  effectiveValue: c.effectiveValue == null ? null : c.effectiveValue, effectiveSource: c.effectiveSource || null, effectiveUpdatedAt: c.effectiveUpdatedAt || null,
  detectedAt: c.detectedAt, updatedAt: c.updatedAt, syncRunId: c.syncRunId || null,
  resolution: c.resolution || null, resolvedValue: c.resolvedValue == null ? null : c.resolvedValue, resolvedAt: c.resolvedAt || null,
  resolvedByName: c.resolvedByName || null, note: c.note || '', effectiveAtResolution: c.effectiveAtResolution == null ? null : c.effectiveAtResolution,
});

const pubRun = (r) => ({
  id: r._id, kind: r.kind, forced: !!r.forced, actorName: r.actorName, startedAt: r.startedAt, finishedAt: r.finishedAt || null, durationMs: r.durationMs || 0,
  status: r.status, method: r.method || null, gid: r.gid || '', sheetTitle: r.sheetTitle || '', stats: r.stats || {}, warnings: r.warnings || [],
  error: r.error || '', repeats: r.repeats || 0, lastRepeatAt: r.lastRepeatAt || null,
});

const pubAudit = (a) => ({ id: a._id, at: a.at, action: a.action, actorId: a.actorId, actorName: a.actorName, actorRole: a.actorRole, target: a.target || null, details: a.details || {}, ip: a.ip || '' });

/** Full student card for administrators. */
async function studentProfile(id) {
  const doc = await ctx.col.ratings.findOne({ _id: id });
  if (!doc) throw new HttpError(404, 'Студента не знайдено.');
  const [st, accounts, conflicts, recent, title] = await Promise.all([
    stats.studentStats(id, { range: '30d' }),
    ctx.col.users.find({ studentId: id }, { projection: { fullName: 1, lastSeenAt: 1, createdAt: 1, deviceIds: 1, deviceMeta: 1, role: 1, group: 1 } }).toArray(),
    ctx.col.conflicts.find({ studentId: id }).sort({ detectedAt: -1 }).limit(20).toArray(),
    ctx.col.history.find({ studentId: id }).sort({ at: -1 }).limit(15).toArray(),
    subjectTitles(),
  ]);
  return {
    student: {
      id: doc._id, fullName: doc.fullName, group: doc.group, note: doc.note || '', active: doc.active !== false, archivedAt: doc.archivedAt || null,
      archivedReason: doc.archivedReason || '', sheetRow: doc.sheetRow == null ? null : doc.sheetRow, sheetRemark: doc.sheetRemark || '', fromSheet: !!doc.fromSheet,
      createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null, total: doc.points == null ? null : doc.points,
      meta: doc.scoreMeta || {},
    },
    stats: st,
    accounts: accounts.map((a) => ({
      id: a._id, fullName: a.fullName, lastSeenAt: a.lastSeenAt || null, createdAt: a.createdAt || null, devices: (a.deviceIds || []).length, role: a.role || '',
    })),
    conflicts: conflicts.map(pubConflict),
    recent: recent.map((h) => pubHistory(h, { forAdmin: true, title })),
  };
}

function register(route) {
  route('GET', '/api/admin/dashboard', async () => ({ ...(await stats.adminDashboard()), sync: await sync.status() }), { admin: true });

  route('GET', '/api/admin/analytics', async ({ query }) => stats.adminAnalytics(query), { admin: true });

  route('GET', '/api/admin/students', async ({ query }) => stats.adminStudents(query), { admin: true });

  route('GET', '/api/admin/students/:id', async ({ params }) => studentProfile(params.id), { admin: true });

  route('GET', '/api/admin/students/:id/stats', async ({ params, query }) => stats.studentStats(params.id, query), { admin: true });

  route('GET', '/api/admin/students/:id/activity', async ({ params }) => {
    const doc = await ctx.col.ratings.findOne({ _id: params.id }, { projection: { fullName: 1 } });
    if (!doc) throw new HttpError(404, 'Студента не знайдено.');
    const accounts = await ctx.col.users.find({ studentId: params.id }, { projection: { _id: 1 } }).toArray();
    const [notes, auditList] = await Promise.all([
      ctx.col.notifications.find({ userId: { $in: accounts.map((a) => a._id) } }).sort({ createdAt: -1 }).limit(20).toArray(),
      ctx.col.audit.find({ $or: [{ 'target.id': params.id }, { 'details.studentId': params.id }] }).sort({ at: -1 }).limit(20).toArray(),
    ]);
    return {
      notifications: notes.map((n) => ({ id: n._id, type: n.type, title: n.title, body: n.body, read: !!n.read, createdAt: n.createdAt })),
      audit: auditList.map(pubAudit),
    };
  }, { admin: true });

  // Administrator correction of one subject score (any direction, reason required).
  route('PUT', '/api/admin/students/:id/scores', async ({ params, body, user, ip }) => {
    const res = await scores.adminSet(user, params.id, body || {});
    const e = res.entries[0];
    await stats.snapshotGroups([res.doc.group]);
    await audit(user, 'score.admin_set', {
      target: { type: 'student', id: res.doc._id, name: res.doc.fullName },
      details: { subject: e.subject, from: e.oldValue, to: e.newValue, reason: e.reason, opId: e.opId }, ip,
    });
    await notify.onAdminChange(e).catch(() => {});
    return { ok: true, entry: pubHistory(e, { forAdmin: true, title: await subjectTitles() }), total: res.doc.points };
  }, { admin: true, audit: false });

  route('POST', '/api/admin/students/:id/archive', async ({ params, body, user, ip }) => {
    const archived = body && body.archived !== false;
    const now = ctx.now();
    const doc = await ctx.col.ratings.findOne({ _id: params.id });
    if (!doc) throw new HttpError(404, 'Студента не знайдено.');
    await ctx.col.ratings.updateOne({ _id: doc._id }, archived
      ? { $set: { active: false, archivedAt: now, archivedReason: str(body && body.reason, 200) || 'Архівовано адміністратором', archivedBy: 'admin', updatedAt: now }, $inc: { rev: 1 } }
      : { $set: { active: true, archivedAt: null, archivedReason: null, archivedBy: null, updatedAt: now }, $inc: { rev: 1 } });
    await stats.snapshotGroups([doc.group]);
    await audit(user, archived ? 'student.archive' : 'student.restore', { target: { type: 'student', id: doc._id, name: doc.fullName }, ip });
    return { ok: true, archived };
  }, { admin: true, audit: false });

  // Complete score history with filters.
  route('GET', '/api/admin/score-history', async ({ query }) => {
    const f = {};
    const studentId = str(query.get('studentId'), 64);
    if (studentId) f.studentId = studentId;
    const subject = cleanSubjectKey(query.get('subject'));
    if (subject) f.subject = subject;
    const source = str(query.get('source'), 20);
    if (['sheet', 'student', 'admin', 'import', 'seed', 'migration'].includes(source)) f.source = source;
    const group = str(query.get('group'), 40);
    if (group) f.group = group;
    const q = normKey(query.get('q')).slice(0, 60);
    if (q) f.studentName = { $regex: escapeRegex(q), $options: 'i' };
    const at = dateRangeFilter(query);
    if (at) f.at = at;
    const title = await subjectTitles();
    return paged(ctx.col.history, f, { at: -1, _id: -1 }, query, (h) => pubHistory(h, { forAdmin: true, title }));
  }, { admin: true });

  route('GET', '/api/admin/audit', async ({ query }) => {
    const f = {};
    const action = str(query.get('action'), 60);
    if (action) f.action = action.endsWith('.') ? { $regex: '^' + escapeRegex(action) } : action;
    const role = str(query.get('role'), 20);
    if (role) f.actorRole = role;
    const q = str(query.get('q'), 60);
    if (q) f.$or = [{ actorName: { $regex: escapeRegex(q), $options: 'i' } }, { 'target.name': { $regex: escapeRegex(q), $options: 'i' } }];
    const at = dateRangeFilter(query);
    if (at) f.at = at;
    return paged(ctx.col.audit, f, { at: -1, _id: -1 }, query, pubAudit);
  }, { admin: true });

  // ── Google Sheets ──
  route('GET', '/api/admin/sync', async ({ query }) => {
    const [status, runs] = await Promise.all([sync.status(), paged(ctx.col.syncRuns, {}, { startedAt: -1 }, query, pubRun)]);
    return { ...status, runs };
  }, { admin: true });

  route('GET', '/api/admin/sync/runs', async ({ query }) => {
    const f = {};
    const st = str(query.get('status'), 20);
    if (st) f.status = st;
    return paged(ctx.col.syncRuns, f, { startedAt: -1 }, query, pubRun);
  }, { admin: true });

  route('POST', '/api/admin/sync/run', async ({ body, user, ip }) => {
    const force = !!(body && body.force === true);
    const run = await sync.runSync({ kind: 'manual', actor: user, force });
    await audit(user, force ? 'sync.force' : 'sync.manual', { details: { runId: run && run._id, status: run && run.status, stats: run && run.stats }, ip });
    return { run: run && pubRun(run), status: await sync.status() };
  }, { admin: true, audit: false });

  route('POST', '/api/admin/sync/diagnostics', async ({ user }) => sync.diagnostics(user), { admin: true, audit: false });

  // ── conflicts ──
  route('GET', '/api/admin/conflicts', async ({ query }) => {
    const status = query.get('status') === 'resolved' ? 'resolved' : query.get('status') === 'all' ? null : 'open';
    const f = status ? { status } : {};
    const studentId = str(query.get('studentId'), 64);
    if (studentId) f.studentId = studentId;
    const res = await paged(ctx.col.conflicts, f, status === 'resolved' ? { resolvedAt: -1 } : { detectedAt: -1 }, query, pubConflict);
    // Current effective value at the time of viewing (it may have changed since detection).
    const ids = [...new Set(res.items.map((c) => c.studentId))];
    const docs = await ctx.col.ratings.find({ _id: { $in: ids } }, { projection: { subjects: 1, scoreMeta: 1 } }).toArray();
    const by = new Map(docs.map((d) => [d._id, d]));
    for (const c of res.items) {
      const d = by.get(c.studentId);
      c.currentValue = d && d.subjects && typeof d.subjects[c.subject] === 'number' ? d.subjects[c.subject] : null;
      c.currentSource = d && d.scoreMeta && d.scoreMeta[c.subject] ? d.scoreMeta[c.subject].source : null;
    }
    res.open = await ctx.col.conflicts.countDocuments({ status: 'open' });
    return res;
  }, { admin: true });

  route('POST', '/api/admin/conflicts/:id/resolve', async ({ params, body, user, ip }) => {
    const res = await scores.resolveConflict(user, params.id, body || {});
    await stats.snapshotGroups([res.doc.group]);
    await audit(user, 'conflict.resolve', {
      target: { type: 'student', id: res.doc._id, name: res.doc.fullName },
      details: { conflictId: params.id, subject: res.conflict.subject, resolution: res.conflict.resolution, value: res.conflict.resolvedValue, note: res.conflict.note }, ip,
    });
    if (res.entries.length) await notify.onAdminChange(res.entries[0]).catch(() => {});
    return { ok: true, conflict: pubConflict(res.conflict) };
  }, { admin: true, audit: false });

  // ── subject catalog ──
  route('GET', '/api/admin/catalog', async () => {
    const [cat, counts] = await Promise.all([
      scores.catalog(),
      ctx.col.ratings.aggregate([
        { $match: stats.ACTIVE }, { $project: { k: { $objectToArray: { $ifNull: ['$subjects', {}] } } } }, { $unwind: '$k' },
        { $group: { _id: '$k.k', n: { $sum: 1 }, max: { $max: '$k.v' } } },
      ]).toArray(),
    ]);
    const by = new Map(counts.map((c) => [c._id, c]));
    return {
      defaultMax: scores.defaultMax(),
      items: cat.map((c) => ({
        key: c._id, title: c.title || '', maxScore: scores.maxOf(c), order: c.order, active: c.active !== false, inSheet: c.inSheet !== false,
        scores: by.get(c._id) ? by.get(c._id).n : 0, highest: by.get(c._id) ? by.get(c._id).max : null,
      })),
    };
  }, { admin: true });

  route('PUT', '/api/admin/catalog/:key', async ({ params, body, user, ip }) => {
    const key = cleanSubjectKey(params.key);
    const entry = (await scores.catalogMap()).get(key);
    if (!entry) throw new HttpError(404, 'Предмет не знайдено.');
    const set = { updatedAt: ctx.now() };
    if ('title' in body) set.title = str(body.title, 80);
    if ('maxScore' in body) {
      const m = parseScore(body.maxScore, { max: 100000 });
      if (!(m > 0)) throw new HttpError(400, 'Максимальний бал має бути більшим за 0.');
      set.maxScore = m;
    }
    if ('active' in body) set.active = body.active !== false;
    await ctx.col.catalog.updateOne({ _id: key }, { $set: set });
    scores.invalidateCatalog();
    const above = set.maxScore ? await ctx.col.ratings.countDocuments({ [`subjects.${key}`]: { $gt: set.maxScore } }) : 0;
    await audit(user, 'catalog.update', { target: { type: 'subject', id: key, name: key }, details: { ...set, updatedAt: undefined }, ip });
    return { ok: true, above };
  }, { admin: true, audit: false });

  // ── account ↔ student linking by matching full names ──
  async function suggestions() {
    const [accounts, students] = await Promise.all([
      ctx.col.users.find({ $or: [{ studentId: { $exists: false } }, { studentId: '' }, { studentId: null }], isAdmin: { $ne: true } }, { projection: { fullName: 1 } }).toArray(),
      ctx.col.ratings.find(stats.ACTIVE, { projection: { fullName: 1, group: 1, nameKey: 1 } }).toArray(),
    ]);
    const byKey = new Map();
    for (const s of students) { const l = byKey.get(s.nameKey) || []; l.push(s); byKey.set(s.nameKey, l); }
    return accounts.map((a) => {
      const m = byKey.get(ratingKey(a.fullName)) || [];
      return m.length === 1 ? { userId: a._id, userName: a.fullName, studentId: m[0]._id, studentName: m[0].fullName, group: m[0].group } : null;
    }).filter(Boolean);
  }

  route('GET', '/api/admin/link-suggestions', async () => ({ items: await suggestions() }), { admin: true });

  route('POST', '/api/admin/link-suggestions/apply', async ({ body, user, ip }) => {
    const wanted = new Set((Array.isArray(body.userIds) ? body.userIds : []).map((x) => String(x)));
    const list = (await suggestions()).filter((s) => wanted.has(s.userId));
    for (const s of list) {
      await ctx.col.users.updateOne({ _id: s.userId }, { $set: { studentId: s.studentId, studentName: s.studentName } });
      await audit(user, 'user.link_student', { target: { type: 'user', id: s.userId, name: s.userName }, details: { studentId: s.studentId, student: s.studentName, matched: 'name' }, ip });
    }
    return { linked: list.length };
  }, { admin: true, audit: false });
}

module.exports = { register, studentProfile };
