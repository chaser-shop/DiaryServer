'use strict';
/*
 * Student endpoints. The student is ALWAYS taken from the authenticated account (`user.studentId`);
 * no endpoint accepts a student id from the client, so one student can never read or change another's data.
 */

const ctx = require('../context');
const scores = require('../scores');
const stats = require('../stats');
const notify = require('../notify');
const { audit } = require('../audit');
const { HttpError, str, toDate, clampInt, cleanSubjectKey, scoreDelta } = require('../util');

const SOURCE_ACTOR = { sheet: 'Google-таблиця', import: 'Імпорт файлу', admin: 'Адміністратор', seed: 'Початкові дані', migration: 'Перенесення даних' };

/** key → full subject title from the catalog (the key itself when no title is set). */
async function subjectTitles() {
  const cat = await scores.catalogMap();
  return (key) => scores.titleOf(cat.get(key), key);
}

/**
 * History entry as shown to the student (administrator names are not disclosed). The change amount is
 * recomputed from the two values: entries written before this rule stored «+N» for a first score.
 */
function pubHistory(h, { forAdmin = false, title = null } = {}) {
  if (!h) return null;
  return {
    id: h._id, opId: h.opId, at: h.at, studentId: forAdmin ? h.studentId : undefined, studentName: forAdmin ? h.studentName : undefined,
    group: forAdmin ? h.group : undefined, subject: h.subject, subjectTitle: title ? title(h.subject) : h.subject,
    oldValue: h.oldValue, newValue: h.newValue, delta: scoreDelta(h.oldValue, h.newValue), source: h.source,
    actorName: forAdmin || h.source === 'student' ? h.actorName : (SOURCE_ACTOR[h.source] || 'Система'),
    reason: h.reason || '', syncRunId: h.syncRunId || null, conflictId: h.conflictId || null, totalBefore: h.totalBefore, totalAfter: h.totalAfter,
  };
}

function register(route, { deviceTrusted, rateLimit }) {
  const linkedDoc = async (user) => (user.studentId ? ctx.col.ratings.findOne({ _id: user.studentId }) : null);

  function editState(user, doc, req) {
    if (!doc) return { allowed: false, code: 'not_linked', message: 'Ваш обліковий запис ще не прив’язано до студента в рейтингу. Зверніться до адміністратора.' };
    if (doc.active === false) return { allowed: false, code: 'archived', message: 'Ваш запис у рейтингу архівовано — змінювати бали неможливо.' };
    if (ctx.settings.trustedDevicesOnly && !deviceTrusted(user, req.deviceId)) {
      return { allowed: false, code: 'device_untrusted', message: 'Змінювати бали можна лише з підтвердженого пристрою. Попросіть адміністратора підтвердити цей пристрій.' };
    }
    return { allowed: true, code: '', message: '' };
  }

  const notLinked = (user) => ({ linked: false, edit: editState(user, null, {}) });

  // Scores + summary for the score-management page and the dashboard.
  route('GET', '/api/me/scores', async ({ user, req }) => {
    const doc = await linkedDoc(user);
    if (!doc) return notLinked(user);
    const st = await stats.studentStats(doc._id, { range: '7d' }, { series: false });
    return { linked: true, edit: editState(user, doc, req), ...st };
  });

  route('POST', '/api/me/scores/increase', async ({ user, body, req, ip }) => {
    rateLimit('inc|' + user._id, 30, 10 * 60 * 1000);
    const res = await scores.studentIncrease(user, body || {}, { deviceTrusted: deviceTrusted(user, req.deviceId) });
    const entry = res.entries[0];
    if (!res.replay) {
      await stats.snapshotGroups([res.doc.group]);
      await audit(user, 'score.increase', {
        target: { type: 'student', id: res.doc._id, name: res.doc.fullName },
        details: { subject: entry.subject, from: entry.oldValue, to: entry.newValue, opId: entry.opId }, ip,
      });
    }
    return { ok: true, replay: !!res.replay, entry: pubHistory(entry, { title: await subjectTitles() }), total: res.doc.points };
  });

  route('GET', '/api/me/history', async ({ user, query }) => {
    if (!user.studentId) return { items: [], next: null };
    const limit = clampInt(query.get('limit'), 1, 100, 30);
    const q = { studentId: user.studentId };
    const subject = cleanSubjectKey(query.get('subject'));
    if (subject) q.subject = subject;
    const before = toDate(query.get('before'));
    if (before) q.at = { $lt: before };
    const list = await ctx.col.history.find(q).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray();
    const page = list.slice(0, limit);
    const title = await subjectTitles();
    return { items: page.map((h) => pubHistory(h, { title })), next: list.length > limit ? page[page.length - 1].at : null };
  });

  route('GET', '/api/me/stats', async ({ user, query }) => {
    const doc = await linkedDoc(user);
    if (!doc) return { linked: false };
    return { linked: true, ...(await stats.studentStats(doc._id, query)) };
  });

  // Profile: main info, analytics summary and recent activity.
  route('GET', '/api/me/profile', async ({ user, req }) => {
    const doc = await linkedDoc(user);
    const [recentNotes, unread] = await Promise.all([notify.list(user._id, { limit: 5 }), notify.unreadCount(user._id)]);
    const device = (user.deviceMeta || {})[req.deviceKey] || {};
    const base = {
      account: { fullName: user.fullName, role: user.role || '', isAdmin: !!user.isAdmin, group: user.group || '', createdAt: user.createdAt || null, devices: (user.deviceIds || []).length, deviceTrusted: deviceTrusted(user, req.deviceId), deviceLabel: device.label || '' },
      notifications: recentNotes.items, unread,
    };
    if (!doc) return { linked: false, ...base, edit: editState(user, null, req) };
    const [st, recent, syncUpdates, title] = await Promise.all([
      stats.studentStats(doc._id, { range: '30d' }, { series: true }),
      ctx.col.history.find({ studentId: doc._id }).sort({ at: -1 }).limit(10).toArray(),
      ctx.col.history.find({ studentId: doc._id, source: 'sheet' }).sort({ at: -1 }).limit(5).toArray(),
      subjectTitles(),
    ]);
    return { linked: true, ...base, edit: editState(user, doc, req), stats: st, recent: recent.map((h) => pubHistory(h, { title })), syncUpdates: syncUpdates.map((h) => pubHistory(h, { title })) };
  });

  route('GET', '/api/me/notifications', async ({ user, query }) => notify.list(user._id, {
    limit: clampInt(query.get('limit'), 1, 100, 30), before: toDate(query.get('before')), unreadOnly: query.get('unread') === '1',
  }));

  route('POST', '/api/me/notifications/read', async ({ user, body }) => ({ unread: await notify.markRead(user._id, { ids: body.ids, all: body.all === true }) }));

  route('GET', '/api/me/prefs', async ({ user }) => ({ prefs: notify.prefsOf(user) }));

  route('PUT', '/api/me/prefs', async ({ user, body }) => {
    const prefs = notify.cleanPrefs(body && body.prefs);
    await ctx.col.users.updateOne({ _id: user._id }, { $set: { notifyPrefs: prefs } });
    return { prefs };
  });
}

module.exports = { register, pubHistory, subjectTitles };
