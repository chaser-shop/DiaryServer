'use strict';
/*
 * Rating, groups and rating-record administration. Response shapes of the pre-existing endpoints
 * (/api/rating, /api/admin/rating*, /api/admin/groups*) are kept for the web and iOS clients.
 */

const ctx = require('../context');
const scores = require('../scores');
const stats = require('../stats');
const sync = require('../sync');
const { audit } = require('../audit');
const {
  HttpError, str, normName, ratingKey, cleanGroup, uuid, parseScore, cleanSubjectKey,
} = require('../util');

const { ACTIVE } = stats;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const ensureGroup = (name) => ctx.col.groups.updateOne({ _id: name }, { $setOnInsert: { createdAt: ctx.now() } }, { upsert: true });

/** Group of an account: assigned by an administrator, else from the linked or name-matched rating record. */
async function groupOf(user) {
  if (user.group) return user.group;
  if (user.studentId) {
    const s = await ctx.col.ratings.findOne({ _id: user.studentId }, { projection: { group: 1 } });
    if (s) return s.group;
  }
  const e = await ctx.col.ratings.findOne({ nameKey: ratingKey(user.fullName) }, { projection: { group: 1 } });
  return e ? e.group : '';
}

async function listGroups() {
  const [named, rAgg, uAgg] = await Promise.all([
    ctx.col.groups.find({}).toArray(),
    ctx.col.ratings.aggregate([{ $match: ACTIVE }, { $group: { _id: '$group', n: { $sum: 1 } } }]).toArray(),
    ctx.col.users.aggregate([{ $match: { group: { $type: 'string', $ne: '' } } }, { $group: { _id: '$group', n: { $sum: 1 } } }]).toArray(),
  ]);
  const map = new Map();
  const get = (name) => { if (!map.has(name)) map.set(name, { name, students: 0, accounts: 0 }); return map.get(name); };
  named.forEach((g) => get(g._id));
  rAgg.forEach((g) => { get(g._id).students = g.n; });
  uAgg.forEach((g) => { get(g._id).accounts = g.n; });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

const dupRating = (e) => {
  if (e && e.code === 11000) throw new HttpError(409, 'Цей студент уже є в рейтингу цієї групи.');
  throw e;
};

async function syncStatusForRating() {
  const st = await sync.getState();
  return { enabled: sync.settings().enabled, ...st };
}

/** { subjectKey: value|null } from a request body; '' and null clear the score. */
async function readSubjectValues(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const cat = await scores.catalogMap();
  for (const [k0, v] of Object.entries(raw).slice(0, 40)) {
    const k = cleanSubjectKey(k0);
    if (!k) continue;
    out[k] = parseScore(v, { max: scores.maxOf(cat.get(k)), allowNull: true });
  }
  return out;
}

function register(route) {
  // Students get ONLY their own group (the `group` parameter is ignored); administrators may choose any.
  // Per-subject breakdown is visible to the student for their own row and to administrators.
  route('GET', '/api/rating', async ({ user, query }) => {
    const assigned = user.studentId ? await ctx.col.ratings.findOne({ _id: user.studentId }) : null;
    const own = assigned ? assigned.group : await groupOf(user);
    let group = own;
    let groups = null;
    if (user.isAdmin) {
      groups = await listGroups();
      group = cleanGroup(query.get('group')) || own || (groups[0] ? groups[0].name : '');
    }
    const cat = await scores.catalog();
    const subjects = cat.filter((c) => c.active !== false).map((c) => c._id);
    const titles = Object.fromEntries(cat.map((c) => [c._id, scores.titleOf(c, c._id)]));
    const want = str(query.get('subject'), 30);
    const subject = subjects.includes(want) ? want : '';
    const extra = user.isAdmin ? { syncStatus: await syncStatusForRating() } : {};
    if (!group || (!user.isAdmin && !assigned)) {
      return { group: '', own: '', groups, subjects, titles, subject, entries: [], me: null, unassigned: !user.isAdmin && !assigned, ...extra };
    }
    const rows = await ctx.col.ratings.find({ group, ...ACTIVE }).toArray();
    const ranked = stats.rankEntries(subject ? rows.map((e) => ({ ...e, points: num((e.subjects || {})[subject]) })) : rows);
    const entries = ranked.map((e) => {
      const isMe = !!assigned && String(e._id) === String(assigned._id);
      return {
        ...(user.isAdmin ? { id: e._id } : {}),
        rank: e.rank, fullName: e.fullName, points: e.points, note: e.note || '', isMe,
        ...(isMe || user.isAdmin ? { subjects: e.subjects || {} } : {}),
      };
    });
    const me = entries.find((e) => e.isMe) || null;
    return {
      group, own, groups, subjects, titles, subject, entries, total: entries.length,
      me: me && { rank: me.rank, points: me.points }, archived: !!(assigned && assigned.active === false), ...extra,
    };
  });

  route('GET', '/api/admin/groups', async () => listGroups(), { admin: true });

  route('POST', '/api/admin/groups', async ({ body, user, ip }) => {
    const name = cleanGroup(body.name);
    if (!name) throw new HttpError(400, 'Введіть назву групи.');
    await ensureGroup(name);
    await audit(user, 'group.create', { target: { type: 'group', id: name, name }, ip });
    return { name };
  }, { admin: true, audit: false });

  route('PATCH', '/api/admin/groups', async ({ body, user, ip }) => {
    const from = cleanGroup(body.from);
    const to = cleanGroup(body.to);
    if (!from || !to) throw new HttpError(400, 'Вкажіть стару й нову назву групи.');
    if (from === to) return {};
    try { await ctx.col.ratings.updateMany({ group: from }, { $set: { group: to }, $inc: { rev: 1 } }); } catch (e) { dupRating(e); }
    await Promise.all([
      ctx.col.users.updateMany({ group: from }, { $set: { group: to } }),
      ctx.col.snapshots.updateMany({ group: from }, { $set: { group: to } }),
      ctx.col.conflicts.updateMany({ group: from, status: 'open' }, { $set: { group: to } }),
    ]);
    await ctx.col.groups.deleteOne({ _id: from });
    await ensureGroup(to);
    await audit(user, 'group.rename', { target: { type: 'group', id: to, name: to }, details: { from, to }, ip });
    return {};
  }, { admin: true, audit: false });

  route('DELETE', '/api/admin/groups/:name', async ({ params, user, ip }) => {
    const name = cleanGroup(params.name);
    if ((await ctx.col.ratings.countDocuments({ group: name })) || (await ctx.col.users.countDocuments({ group: name }))) {
      throw new HttpError(409, 'Група не порожня: спершу перенесіть або видаліть її студентів і зніміть групу в учасників.');
    }
    await ctx.col.groups.deleteOne({ _id: name });
    await audit(user, 'group.delete', { target: { type: 'group', id: name, name }, ip });
    return {};
  }, { admin: true, audit: false });

  // Students of the rating for linking accounts.
  route('GET', '/api/admin/rating-students', async () => {
    const rows = await ctx.col.ratings.find({}, { projection: { _id: 1, fullName: 1, group: 1, active: 1 } }).sort({ fullName: 1 }).toArray();
    return rows.map((r) => ({ id: r._id, fullName: r.fullName, group: r.group || '', active: r.active !== false }));
  }, { admin: true });

  // Link a rating record to a person's account (not a device): all approved devices show the same rating.
  route('POST', '/api/admin/users/:id/student', async ({ params, body, user, ip }) => {
    const account = await ctx.col.users.findOne({ _id: params.id });
    if (!account) throw new HttpError(404, 'Користувача не знайдено.');
    const studentId = str(body.studentId, 64);
    if (!studentId) {
      await ctx.col.users.updateOne({ _id: account._id }, { $unset: { studentId: '', studentName: '' } });
      await audit(user, 'user.unlink_student', { target: { type: 'user', id: account._id, name: account.fullName }, details: { previous: account.studentName || '' }, ip });
      return {};
    }
    const student = await ctx.col.ratings.findOne({ _id: studentId });
    if (!student) throw new HttpError(404, 'Студента не знайдено в рейтингу. Спочатку оновіть таблицю рейтингу.');
    await ctx.col.users.updateOne({ _id: account._id }, { $set: { studentId: student._id, studentName: student.fullName } });
    const others = await ctx.col.users.find({ studentId: student._id, _id: { $ne: account._id } }, { projection: { fullName: 1 } }).toArray();
    await audit(user, 'user.link_student', { target: { type: 'user', id: account._id, name: account.fullName }, details: { studentId: student._id, student: student.fullName }, ip });
    return { ok: true, student: student.fullName, alsoLinked: others.map((o) => o.fullName) };
  }, { admin: true, audit: false });

  route('POST', '/api/admin/users/:id/group', async ({ params, body, user, ip }) => {
    const g = cleanGroup(body.group);
    const r = await ctx.col.users.updateOne({ _id: params.id }, g ? { $set: { group: g } } : { $unset: { group: '' } });
    if (!r.matchedCount) throw new HttpError(404, 'Користувача не знайдено.');
    if (g) await ensureGroup(g);
    await audit(user, 'user.group', { target: { type: 'user', id: params.id }, details: { group: g }, ip });
    return {};
  }, { admin: true, audit: false });

  route('POST', '/api/admin/rating/sync', async ({ user, body }) => {
    const run = await sync.runSync({ kind: 'manual', actor: user, force: body && body.force === true });
    if (run && (run.status === 'error' || run.status === 'aborted')) throw new HttpError(502, run.error || 'Синхронізація не виконана.', { runId: run._id });
    await audit(user, 'sync.manual', { details: { runId: run && run._id, status: run && run.status } });
    return { ok: true, run, ...(await sync.getState()) };
  }, { admin: true, audit: false });

  route('PUT', '/api/admin/rating/import', async ({ user, body }) => {
    const fallback = cleanGroup(body.group) || (await groupOf(user)) || ((await listGroups())[0] || {}).name || sync.settings().group;
    const r = await sync.importFile(user, body, fallback);
    await ensureGroup(r.group);
    return { ok: true, ...r };
  }, { admin: true, audit: false });

  // Create a student (optionally with scores).
  route('POST', '/api/admin/rating', async ({ body, user, ip }) => {
    const fullName = normName(body.fullName);
    if (fullName.split(' ').length < 2 || fullName.length > 100) throw new HttpError(400, 'Введіть прізвище та ім’я (ПІБ).');
    const group = cleanGroup(body.group);
    if (!group) throw new HttpError(400, 'Оберіть групу.');
    const values = await readSubjectValues(body.subjects);
    const now = ctx.now();
    const doc = {
      _id: uuid(), group, fullName, nameKey: ratingKey(fullName), note: str(body.note, 60), active: true, fromSheet: false,
      subjects: {}, scoreMeta: {}, points: null, rev: 0, createdAt: now, updatedAt: now, source: 'admin',
    };
    try { await ctx.col.ratings.insertOne(doc); } catch (e) { dupRating(e); }
    await scores.registerSubjects(Object.keys(values), { fromSheet: false });
    const manual = Object.values(values).some((v) => v != null) ? undefined : parseScore(body.points, { allowNull: true });
    await scores.commitStudent(doc._id, (d) => ({
      source: 'admin', actor: user, reason: 'Створення запису адміністратором',
      items: Object.entries(values).map(([k, v]) => scores.planAdminSet(d, k, v, { max: 100000, now: ctx.now(), actor: user })),
      set: manual !== undefined ? { points: manual } : null,
    }));
    await ensureGroup(group);
    await stats.snapshotGroups([group]);
    await audit(user, 'student.create', { target: { type: 'student', id: doc._id, name: fullName }, details: { group }, ip });
    return { id: doc._id };
  }, { admin: true, audit: false });

  // Edit a student: name, group, note, subject scores (each change → history) or a manual total without subjects.
  route('PATCH', '/api/admin/rating/:id', async ({ params, body, user, ip }) => {
    const set = {};
    if ('fullName' in body) {
      const n = normName(body.fullName);
      if (n.split(' ').length < 2 || n.length > 100) throw new HttpError(400, 'Введіть прізвище та ім’я (ПІБ).');
      set.fullName = n;
      set.nameKey = ratingKey(n);
    }
    if ('group' in body) {
      const g = cleanGroup(body.group);
      if (!g) throw new HttpError(400, 'Оберіть групу.');
      set.group = g;
    }
    if ('note' in body) set.note = str(body.note, 60);
    const values = 'subjects' in body ? await readSubjectValues(body.subjects) : {};
    const reason = str(body.reason, 300) || 'Редагування в керуванні рейтингом';
    if (Object.keys(values).length) await scores.registerSubjects(Object.keys(values), { fromSheet: false });
    let res;
    try {
      res = await scores.commitStudent(params.id, (d) => {
        // Subjects absent from `subjects` in a full-form save are cleared (the form always sends all of them).
        const items = Object.entries(values).map(([k, v]) => scores.planAdminSet(d, k, v, { max: 100000, now: ctx.now(), actor: user }));
        if (body.replaceSubjects === true) {
          for (const k of Object.keys(d.subjects || {})) if (!(k in values)) items.push(scores.planAdminSet(d, k, null, { max: 100000, now: ctx.now(), actor: user }));
        }
        const s = { ...set };
        const willHaveSubjects = Object.keys({ ...(d.subjects || {}), ...values }).some((k) => (k in values ? values[k] != null : true));
        if ('points' in body && !willHaveSubjects) s.points = parseScore(body.points, { allowNull: true });
        return { source: 'admin', actor: user, reason, items, set: Object.keys(s).length ? s : null };
      });
    } catch (e) { dupRating(e); }
    if (set.group) await ensureGroup(set.group);
    await stats.snapshotGroups([res.before.group, res.doc.group]);
    await audit(user, 'student.update', {
      target: { type: 'student', id: res.doc._id, name: res.doc.fullName },
      details: { fields: Object.keys(set), changes: res.entries.map((e) => ({ subject: e.subject, from: e.oldValue, to: e.newValue })), reason }, ip,
    });
    if (set.fullName) {
      await ctx.col.users.updateMany({ studentId: res.doc._id }, { $set: { studentName: res.doc.fullName } });
    }
    return {};
  }, { admin: true, audit: false });

  route('DELETE', '/api/admin/rating/:id', async ({ params, user, ip }) => {
    const doc = await ctx.col.ratings.findOne({ _id: params.id });
    if (!doc) throw new HttpError(404, 'Запис не знайдено.');
    await ctx.col.ratings.deleteOne({ _id: doc._id });
    // History and snapshots are kept (immutable); accounts lose the dangling link.
    await ctx.col.users.updateMany({ studentId: doc._id }, { $unset: { studentId: '', studentName: '' } });
    await ctx.col.conflicts.updateMany({ studentId: doc._id, status: 'open' }, { $set: { status: 'resolved', resolution: 'deleted', resolvedAt: ctx.now(), resolvedBy: user._id, resolvedByName: user.fullName } });
    await stats.snapshotGroups([doc.group]);
    await audit(user, 'student.delete', { target: { type: 'student', id: doc._id, name: doc.fullName }, details: { group: doc.group, total: doc.points }, ip });
    return {};
  }, { admin: true, audit: false });
}

module.exports = { register, groupOf, listGroups, ensureGroup };
