'use strict';
/*
 * In-app notifications (collection `notifications`), optionally mirrored to Web Push.
 * Every notification is generated from stored data (history / snapshots); `dedupeKey` (unique)
 * guarantees the same event is never announced twice, even after restarts.
 */

const ctx = require('./context');
const scores = require('./scores');
const {
  uuid, dayKey, addDays, isoWeekKey: isoWeekKeyOf, round2, pctChange, fmtNum, fmtPct, pointsWord, positionsWord,
} = require('./util');

const DEFAULT_PREFS = { scores: true, daily: true, rank: true, weekly: true, push: true };
const prefsOf = (u) => ({ ...DEFAULT_PREFS, ...((u && u.notifyPrefs) || {}) });

function cleanPrefs(body) {
  const out = {};
  for (const k of Object.keys(DEFAULT_PREFS)) out[k] = !(body && body[k] === false);
  return out;
}

const pts = (n) => `${fmtNum(n)} ${pointsWord(n)}`;

/** Accounts linked to a rating student. */
const accountsOf = (studentId) => ctx.col.users.find({ studentId }, { projection: { fullName: 1, notifyPrefs: 1 } }).toArray();

async function pushTo(userId, n) {
  if (!ctx.sendPush) return;
  try {
    const subs = await ctx.col.pushSubs.find({ userId }).toArray();
    const payload = { title: n.title, body: n.body, tag: 'progress-' + n._id, data: { url: '/?tab=notifications' }, ttl: 86400 };
    await Promise.allSettled(subs.filter((s) => !s.settings || s.settings.notifyProgress !== false).map((s) => ctx.sendPush(s, payload)));
  } catch (e) {
    console.error('notification push:', e.message);
  }
}

/**
 * Creates one notification per account. `pref` names the preference that must be enabled.
 * Returns the number of notifications actually created (duplicates are skipped).
 */
async function notifyAccounts(accounts, { type, title, body, data = {}, dedupeKey, pref }) {
  let created = 0;
  for (const u of accounts) {
    const prefs = prefsOf(u);
    if (pref && !prefs[pref]) continue;
    const n = { _id: uuid(), userId: u._id, type, title, body, data, read: false, createdAt: ctx.now(), dedupeKey: dedupeKey ? `${dedupeKey}|${u._id}` : undefined };
    if (!n.dedupeKey) delete n.dedupeKey;
    try {
      await ctx.col.notifications.insertOne(n);
      created++;
      if (prefs.push) pushTo(u._id, n);
    } catch (e) {
      if (!(e && e.code === 11000)) console.error('notification:', e.message);
    }
  }
  return created;
}

async function notifyStudent(studentId, payload) {
  return notifyAccounts(await accountsOf(studentId), payload);
}

// ───────────── event notifications ─────────────

/** Scores changed by the spreadsheet sync or a file import (one notification per student per run). */
async function onSheetChanges(runId, student, entries, via = 'sheet') {
  if (!entries.length) return 0;
  const cat = await scores.catalogMap();
  const parts = entries.slice(0, 4).map((e) => {
    const t = scores.titleOf(cat.get(e.subject), e.subject);
    const d = e.delta > 0 ? `+${fmtNum(e.delta)}` : fmtNum(e.delta);
    return `«${t}»: ${e.oldValue == null ? '—' : fmtNum(e.oldValue)} → ${e.newValue == null ? '—' : fmtNum(e.newValue)}${e.oldValue != null && e.newValue != null ? ` (${d})` : ''}`;
  });
  const more = entries.length > 4 ? ` та ще ${entries.length - 4}` : '';
  return notifyStudent(student._id, {
    type: via === 'import' ? 'import_update' : 'sheet_update', pref: 'scores', dedupeKey: `${via}|${runId}|${student._id}`,
    title: via === 'import' ? 'Оновлення балів' : 'Оновлення балів із таблиці',
    body: `${via === 'import' ? 'Адміністратор оновив бали з файлу' : 'Бали оновлено з Google-таблиці'}: ${parts.join(', ')}${more}.`,
    data: { url: '/?tab=progress&sub=scores' },
  });
}

/** An administrator changed the student's score (correction or conflict resolution). */
async function onAdminChange(entry) {
  const cat = await scores.catalogMap();
  const t = scores.titleOf(cat.get(entry.subject), entry.subject);
  return notifyStudent(entry.studentId, {
    type: 'admin_change', dedupeKey: `admin|${entry._id}`,
    title: 'Бал змінено адміністратором',
    body: `Адміністратор змінив ваш бал із предмета «${t}»: ${entry.oldValue == null ? '—' : fmtNum(entry.oldValue)} → ${entry.newValue == null ? '—' : fmtNum(entry.newValue)}.${entry.reason ? ' Причина: ' + entry.reason : ''}`,
    data: { url: '/?tab=progress&sub=scores' },
  });
}

// ───────────── daily and weekly summaries ─────────────

/**
 * Daily summary for every linked student: compares the current state with the end of the previous
 * day (latest snapshot before today). Students without such history get no summary.
 */
async function dailyDigest(now = ctx.now()) {
  const today = dayKey(now);
  const yesterday = addDays(today, -1);
  const accounts = await ctx.col.users.find({ studentId: { $type: 'string', $ne: '' } }, { projection: { fullName: 1, notifyPrefs: 1, studentId: 1 } }).toArray();
  if (!accounts.length) return { created: 0 };
  const byStudent = new Map();
  for (const a of accounts) { const l = byStudent.get(a.studentId) || []; l.push(a); byStudent.set(a.studentId, l); }
  const ids = [...byStudent.keys()];
  const [docs, todaySnaps, prevSnaps, cat] = await Promise.all([
    ctx.col.ratings.find({ _id: { $in: ids }, active: { $ne: false } }).toArray(),
    ctx.col.snapshots.find({ date: today, studentId: { $in: ids } }).toArray(),
    ctx.col.snapshots.aggregate([
      { $match: { date: { $lte: yesterday }, studentId: { $in: ids } } },
      { $sort: { studentId: 1, date: -1 } },
      { $group: { _id: '$studentId', s: { $first: '$$ROOT' } } },
    ]).toArray(),
    scores.catalogMap(),
  ]);
  const snapNow = new Map(todaySnaps.map((s) => [s.studentId, s]));
  const prev = new Map(prevSnaps.map((x) => [x._id, x.s]));
  let created = 0;
  for (const doc of docs) {
    const p = prev.get(doc._id);
    if (!p) continue; // no previous-day data → nothing to compare
    const accs = byStudent.get(doc._id);
    const nowSnap = snapNow.get(doc._id);
    const total = typeof doc.points === 'number' ? doc.points : null;
    const key = `daily|${today}|${doc._id}`;
    if (total != null && p.total != null && Math.abs(total - p.total) >= 0.01) {
      const d = round2(total - p.total);
      created += await notifyAccounts(accs, {
        type: 'daily_total', pref: 'daily', dedupeKey: `${key}|total`, data: { url: '/?tab=progress&sub=stats' },
        title: d > 0 ? 'Загальний бал зріс' : 'Загальний бал змінився',
        body: d > 0 ? `Ваш загальний рейтинг зріс на ${pts(d)} за останню добу.` : `Ваш загальний бал знизився на ${pts(-d)} за останню добу.`,
      });
    }
    const improved = [];
    for (const [k, v] of Object.entries(doc.subjects || {})) {
      const old = p.subjects ? p.subjects[k] : null;
      if (typeof v !== 'number') continue;
      if (typeof old === 'number' && v > old) improved.push({ k, v, old, pct: pctChange(old, v) });
      else if (old == null && v > 0) improved.push({ k, v, old: null, pct: null });
    }
    improved.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    for (const it of improved.slice(0, 3)) {
      const t = scores.titleOf(cat.get(it.k), it.k);
      created += await notifyAccounts(accs, {
        type: 'daily_subject', pref: 'daily', dedupeKey: `${key}|subj|${it.k}`, data: { url: '/?tab=progress&sub=scores', subject: it.k },
        title: 'Результат покращився',
        body: it.pct != null
          ? `Ваш результат із предмета «${t}» покращився на ${fmtPct(it.pct)}% порівняно з учорашнім днем.`
          : `Ви отримали перші бали з предмета «${t}»: ${pts(it.v)}.`,
      });
    }
    const rankNow = nowSnap ? nowSnap.rank : null;
    if (rankNow != null && p.rank != null && rankNow !== p.rank) {
      const diff = p.rank - rankNow;
      created += await notifyAccounts(accs, {
        type: 'daily_rank', pref: 'rank', dedupeKey: `${key}|rank`, data: { url: '/?tab=progress&sub=rating' },
        title: diff > 0 ? 'Ви піднялися в рейтингу' : 'Позиція в рейтингу змінилася',
        body: diff > 0
          ? `Ви піднялися на ${diff} ${positionsWord(diff)} в рейтингу групи. Тепер ви на ${rankNow} місці.`
          : `Ви опустилися на ${-diff} ${positionsWord(-diff)} в рейтингу групи. Тепер ви на ${rankNow} місці.`,
      });
    }
  }
  return { created };
}

/** Weekly summary (Sundays): average change over 7 days and the best result this week. */
async function weeklyDigest(now = ctx.now()) {
  const today = dayKey(now);
  const week = isoWeekKeyOf(today);
  const base = addDays(today, -7);
  const accounts = await ctx.col.users.find({ studentId: { $type: 'string', $ne: '' } }, { projection: { fullName: 1, notifyPrefs: 1, studentId: 1 } }).toArray();
  if (!accounts.length) return { created: 0 };
  const byStudent = new Map();
  for (const a of accounts) { const l = byStudent.get(a.studentId) || []; l.push(a); byStudent.set(a.studentId, l); }
  const ids = [...byStudent.keys()];
  const [docs, baseSnaps, cat] = await Promise.all([
    ctx.col.ratings.find({ _id: { $in: ids }, active: { $ne: false } }).toArray(),
    ctx.col.snapshots.aggregate([
      { $match: { date: { $lte: base }, studentId: { $in: ids } } },
      { $sort: { studentId: 1, date: -1 } },
      { $group: { _id: '$studentId', s: { $first: '$$ROOT' } } },
    ]).toArray(),
    scores.catalogMap(),
  ]);
  const baseBy = new Map(baseSnaps.map((x) => [x._id, x.s]));
  let created = 0;
  for (const doc of docs) {
    const accs = byStudent.get(doc._id);
    const vals = Object.entries(doc.subjects || {}).filter(([, v]) => typeof v === 'number');
    if (!vals.length) continue;
    const avg = round2(vals.reduce((a, [, v]) => a + v, 0) / vals.length);
    const b = baseBy.get(doc._id);
    if (b && b.avg != null && Math.abs(avg - b.avg) >= 0.01) {
      const pct = pctChange(b.avg, avg);
      if (pct != null && Math.abs(pct) >= 0.1) {
        created += await notifyAccounts(accs, {
          type: 'weekly_avg', pref: 'weekly', dedupeKey: `weekly|${week}|${doc._id}|avg`, data: { url: '/?tab=progress&sub=stats' },
          title: 'Підсумок тижня',
          body: pct > 0 ? `За останні 7 днів ваш середній бал покращився на ${fmtPct(pct)}%.` : `За останні 7 днів ваш середній бал знизився на ${fmtPct(-pct)}%.`,
        });
      }
    }
    const [bk, bv] = vals.sort((x, y) => y[1] - x[1])[0];
    created += await notifyAccounts(accs, {
      type: 'weekly_best', pref: 'weekly', dedupeKey: `weekly|${week}|${doc._id}|best`, data: { url: '/?tab=progress&sub=scores' },
      title: 'Найкращий результат тижня',
      body: `Ваш найкращий результат цього тижня — ${pts(bv)} з предмета «${scores.titleOf(cat.get(bk), bk)}».`,
    });
  }
  return { created };
}

// ───────────── reading ─────────────

async function list(userId, { limit = 30, before = null, unreadOnly = false } = {}) {
  const q = { userId };
  if (before) q.createdAt = { $lt: before };
  if (unreadOnly) q.read = false;
  const items = await ctx.col.notifications.find(q).sort({ createdAt: -1 }).limit(limit + 1).toArray();
  const more = items.length > limit;
  const page = items.slice(0, limit);
  return {
    items: page.map((n) => ({ id: n._id, type: n.type, title: n.title, body: n.body, data: n.data || {}, read: !!n.read, createdAt: n.createdAt })),
    next: more ? page[page.length - 1].createdAt : null,
    unread: await unreadCount(userId),
  };
}

const unreadCount = (userId) => ctx.col.notifications.countDocuments({ userId, read: false });

async function markRead(userId, { ids, all }) {
  const q = { userId, read: false };
  if (!all) {
    const list2 = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean).slice(0, 200);
    if (!list2.length) return unreadCount(userId);
    q._id = { $in: list2 };
  }
  await ctx.col.notifications.updateMany(q, { $set: { read: true, readAt: ctx.now() } });
  return unreadCount(userId);
}

module.exports = {
  DEFAULT_PREFS, prefsOf, cleanPrefs, notifyAccounts, notifyStudent, onSheetChanges, onAdminChange,
  dailyDigest, weeklyDigest, list, unreadCount, markRead, isoWeekKeyOf,
};
