'use strict';
/*
 * Statistics. History is stored as one snapshot per student per day (collection `rating_snapshots`,
 * _id = "<YYYY-MM-DD>|<studentId>"), refreshed whenever a group's scores change and once a day.
 * A day without a snapshot inherits the previous day's values (nothing can change without the server).
 * All comparisons use real snapshots; when the needed history does not exist the result says so
 * (`available: false`) instead of inventing numbers.
 */

const ctx = require('./context');
const scores = require('./scores');
const {
  HttpError, dayKey, addDays, daysBetween, isDayKey, dayStart, weekStartKey, monthKey, round2, pctChange, escapeRegex, normKey, scoreDelta,
} = require('./util');

const ACTIVE = { active: { $ne: false } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Places by points (desc); equal points share a place (1, 2, 2, 4); no points → no place, listed last. */
function rankEntries(list, key = 'points') {
  const val = (e) => num(e[key]);
  const sorted = [...list].sort((a, b) => (val(b) == null ? -1 : val(b)) - (val(a) == null ? -1 : val(a))
    || String(a.fullName || '').localeCompare(String(b.fullName || ''), 'uk'));
  let prev = null;
  let rank = 0;
  return sorted.map((e, i) => {
    const v = val(e);
    if (v == null) return { ...e, rank: null };
    if (v !== prev) { rank = i + 1; prev = v; }
    return { ...e, rank };
  });
}

function subjectStats(row) {
  const vals = Object.values(row.subjects || {}).filter((v) => num(v) != null);
  return { count: vals.length, avg: vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
}

/** Map studentId → { rank, of, subjectRanks: { key: { rank, of } } } for the rows of one group. */
function groupRanking(rows, keys) {
  const ranked = rankEntries(rows);
  const of = ranked.filter((e) => e.rank != null).length;
  const out = new Map(ranked.map((e) => [e._id, { rank: e.rank, of, subjectRanks: {} }]));
  for (const key of keys) {
    const rk = rankEntries(rows.map((r) => ({ _id: r._id, fullName: r.fullName, points: num((r.subjects || {})[key]) })));
    const n = rk.filter((e) => e.rank != null).length;
    for (const e of rk) if (e.rank != null) out.get(e._id).subjectRanks[key] = { rank: e.rank, of: n };
  }
  return out;
}

const groupRows = (group) => ctx.col.ratings.find({ group, ...ACTIVE }).toArray();

// ───────────── snapshots ─────────────

async function snapshotGroups(groups, now = ctx.now()) {
  const date = dayKey(now);
  const keys = await scores.subjectKeys();
  for (const group of new Set(groups)) {
    if (!group) continue;
    const rows = await groupRows(group);
    if (!rows.length) continue;
    const ranks = groupRanking(rows, keys);
    await ctx.col.snapshots.bulkWrite(rows.map((r) => {
      const st = subjectStats(r);
      const rk = ranks.get(r._id);
      const subjectRanks = {};
      for (const [k, v] of Object.entries(rk.subjectRanks)) subjectRanks[k] = v.rank;
      return {
        updateOne: {
          filter: { _id: `${date}|${r._id}` },
          update: { $set: { date, studentId: r._id, group, total: num(r.points), subjects: r.subjects || {}, rank: rk.rank, of: rk.of, subjectRanks, count: st.count, avg: st.avg, at: now } },
          upsert: true,
        },
      };
    }), { ordered: false });
  }
}

async function snapshotAll(now = ctx.now()) {
  await snapshotGroups(await ctx.col.ratings.distinct('group', ACTIVE), now);
}

/** Latest snapshot on or before `key` for every student matching `match` → Map(studentId → snapshot). */
async function snapshotsAt(key, match = {}) {
  const list = await ctx.col.snapshots.aggregate([
    { $match: { date: { $lte: key }, ...match } },
    { $sort: { studentId: 1, date: -1 } },
    { $group: { _id: '$studentId', s: { $first: '$$ROOT' } } },
  ]).toArray();
  return new Map(list.map((x) => [x._id, x.s]));
}

/** Daily points from `from` to `to`; days without a snapshot carry the previous values. */
function fillDaily(before, inRange, from, to) {
  const byDate = new Map(inRange.map((s) => [s.date, s]));
  const out = [];
  let last = before || null;
  for (let k = from; k <= to; k = addDays(k, 1)) {
    const s = byDate.get(k);
    if (s) last = s;
    out.push(last
      ? { date: k, known: true, total: num(last.total), rank: last.rank == null ? null : last.rank, of: last.of || 0, avg: num(last.avg), count: last.count || 0, subjects: last.subjects || {}, subjectRanks: last.subjectRanks || {} }
      : { date: k, known: false });
  }
  return out;
}

// ───────────── ranges ─────────────

const RANGE_DAYS = { today: 0, '7d': 6, '30d': 29, '90d': 89 };

function resolveRange(query, now = ctx.now()) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) : query && query[k]) || '';
  const today = dayKey(now);
  const range = String(get('range') || '7d');
  if (range === 'custom') {
    const from = String(get('from'));
    let to = String(get('to'));
    if (!isDayKey(from) || !isDayKey(to)) throw new HttpError(400, 'Вкажіть коректні дати періоду.');
    if (from > to) throw new HttpError(400, 'Початок періоду має бути не пізніше за кінець.');
    if (from > today) throw new HttpError(400, 'Період не може починатися в майбутньому.');
    if (to > today) to = today;
    if (daysBetween(from, to) > 366) throw new HttpError(400, 'Період не може перевищувати рік.');
    return { range, from, to, today };
  }
  const key = Object.prototype.hasOwnProperty.call(RANGE_DAYS, range) ? range : '7d';
  return { range: key, from: addDays(today, -RANGE_DAYS[key]), to: today, today };
}

/** Change of a series field from the end of the day before `from` (or the first known day, marked partial). */
function changeOver(points, before, field) {
  const known = points.filter((p) => p.known && p[field] != null);
  if (!known.length) return null;
  const end = known[known.length - 1];
  let base = before && num(before[field]) != null ? { value: before[field], date: before.date, partial: false } : null;
  if (!base) base = { value: known[0][field], date: known[0].date, partial: true };
  const delta = round2(end[field] - base.value);
  return { from: base.value, to: end[field], fromDate: base.date, partial: base.partial, delta, pct: pctChange(base.value, end[field]) };
}

function periodDeltas(points, field, bucketOf) {
  const out = [];
  let prevValue = null;
  for (const p of points) {
    if (!p.known || p[field] == null) continue;
    const label = bucketOf(p.date);
    let b = out[out.length - 1];
    if (!b || b.label !== label) { b = { label, start: prevValue, end: p[field] }; out.push(b); }
    b.end = p[field];
    prevValue = p[field];
  }
  return out.map((b) => ({ label: b.label, value: b.end, delta: b.start == null ? null : round2(b.end - b.start) }));
}

// ───────────── student statistics ─────────────

async function lastChangesBySubject(studentId) {
  const list = await ctx.col.history.aggregate([
    { $match: { studentId } },
    { $sort: { at: -1 } },
    { $group: { _id: '$subject', last: { $first: '$$ROOT' }, changes: { $sum: 1 } } },
  ]).toArray();
  return new Map(list.map((x) => [x._id, { ...x.last, changes: x.changes }]));
}

/**
 * Personal statistics of one student. `query`: { range, from, to }. Options: { series } (default true).
 * Every number is derived from stored scores, history and snapshots.
 */
async function studentStats(studentId, query = {}, { series = true } = {}) {
  const now = ctx.now();
  const doc = await ctx.col.ratings.findOne({ _id: studentId });
  if (!doc) throw new HttpError(404, 'Студента не знайдено.');
  const cat = await scores.catalog();
  const catMap = new Map(cat.map((c) => [c._id, c]));
  const keys = cat.filter((c) => c.active !== false || num((doc.subjects || {})[c._id]) != null).map((c) => c._id);
  for (const k of Object.keys(doc.subjects || {})) if (!keys.includes(k)) keys.push(k);
  const { range, from, to, today } = resolveRange(query, now);

  const rows = doc.active === false ? [doc] : await groupRows(doc.group);
  const ranking = groupRanking(rows, keys);
  const me = ranking.get(doc._id) || { rank: null, of: 0, subjectRanks: {} };
  const st = subjectStats(doc);
  const total = num(doc.points);

  const windowFrom = from < addDays(today, -30) ? from : addDays(today, -30);
  const [beforeArr, inRange, firstArr, lastChanges, openConflicts] = await Promise.all([
    ctx.col.snapshots.find({ studentId: doc._id, date: { $lt: windowFrom } }).sort({ date: -1 }).limit(1).toArray(),
    ctx.col.snapshots.find({ studentId: doc._id, date: { $gte: windowFrom, $lte: today } }).sort({ date: 1 }).toArray(),
    ctx.col.snapshots.find({ studentId: doc._id }).sort({ date: 1 }).limit(1).toArray(),
    lastChangesBySubject(doc._id),
    ctx.col.conflicts.find({ studentId: doc._id, status: 'open' }, { projection: { subject: 1 } }).toArray(),
  ]);
  const historySince = firstArr[0] ? firstArr[0].date : null;
  const full = fillDaily(beforeArr[0], inRange, windowFrom, today);
  // Today's point always reflects live values.
  full[full.length - 1] = { date: today, known: true, total, rank: me.rank, of: me.of, avg: st.avg, count: st.count, subjects: doc.subjects || {}, subjectRanks: Object.fromEntries(Object.entries(me.subjectRanks).map(([k, v]) => [k, v.rank])) };
  const at = (key) => {
    if (historySince == null || key < historySince) return null;
    const p = [...full].reverse().find((x) => x.date <= key && x.known);
    return p || null;
  };

  const kpi = (daysBack) => {
    const base = at(addDays(today, -daysBack));
    if (!base) return { available: false, since: historySince };
    return {
      available: true, baseDate: base.date,
      baseTotal: base.total, total, delta: base.total != null && total != null ? round2(total - base.total) : null, pct: pctChange(base.total, total),
      baseRank: base.rank, rankChange: base.rank != null && me.rank != null ? base.rank - me.rank : null,
      baseAvg: base.avg, avg: st.avg, avgDelta: base.avg != null && st.avg != null ? round2(st.avg - base.avg) : null, avgPct: pctChange(base.avg, st.avg),
    };
  };
  const daily = kpi(1);
  const weekly = kpi(7);
  const monthly = kpi(30);

  const rangePoints = full.filter((p) => p.date >= from && p.date <= to);
  const beforeRange = at(addDays(from, -1));

  const conflictSubjects = new Set(openConflicts.map((c) => c.subject));
  const subjects = keys.map((key) => {
    const entry = catMap.get(key);
    const value = num((doc.subjects || {})[key]);
    const meta = (doc.scoreMeta || {})[key] || {};
    const last = lastChanges.get(key);
    const previous = last ? num(last.oldValue) : null;
    const sr = me.subjectRanks[key];
    const sub = changeOver(rangePoints.map((p) => ({ ...p, v: p.known ? num((p.subjects || {})[key]) : null })), beforeRange ? { ...beforeRange, v: num((beforeRange.subjects || {})[key]) } : null, 'v');
    return {
      key, title: scores.titleOf(entry, key), max: scores.maxOf(entry), active: !entry || entry.active !== false,
      // The first value of a subject (nothing before it) is not a change and has no delta.
      value, previous, delta: last && previous != null ? round2((value || 0) - previous) : null, pct: last ? pctChange(previous, value) : null,
      changes: last ? last.changes : 0, lastChangeAt: last ? last.at : null, lastSource: last ? last.source : null,
      source: meta.source || null, updatedAt: meta.updatedAt || (last && last.at) || null,
      sheet: meta.sheet === undefined ? null : meta.sheet, original: meta.original == null ? null : meta.original,
      studentIncrease: meta.source === 'student' && meta.base != null && value != null ? round2(value - meta.base) : 0,
      rank: sr ? sr.rank : null, of: sr ? sr.of : 0, underReview: conflictSubjects.has(key),
      range: sub,
    };
  });

  const scored = subjects.filter((s) => s.value != null);
  const best = [...scored].sort((a, b) => b.value / b.max - a.value / a.max || b.value - a.value).slice(0, 3)
    .map((s) => ({ key: s.key, title: s.title, value: s.value, max: s.max }));
  const improved = subjects.filter((s) => s.range && s.range.delta > 0).sort((a, b) => b.range.delta - a.range.delta).slice(0, 3)
    .map((s) => ({ key: s.key, title: s.title, delta: s.range.delta, pct: s.range.pct, partial: s.range.partial, fromDate: s.range.fromDate }));

  const out = {
    student: { id: doc._id, fullName: doc.fullName, group: doc.group, note: doc.note || '', active: doc.active !== false },
    range: { range, from, to, today }, historySince,
    current: { total, rank: me.rank, of: me.of, avg: st.avg, count: st.count, subjects: keys.length },
    previousRank: daily.available ? daily.baseRank : null,
    daily, weekly, monthly,
    subjects, best, improved,
    totalChange: changeOver(rangePoints, beforeRange, 'total'),
    rankChange: (() => { const c = changeOver(rangePoints, beforeRange, 'rank'); return c ? { ...c, places: -c.delta } : null; })(),
    avgChange: changeOver(rangePoints, beforeRange, 'avg'),
  };

  if (series) {
    out.series = rangePoints.filter((p) => p.known).map((p) => ({ date: p.date, total: p.total, rank: p.rank, of: p.of, avg: p.avg }));
    out.subjectSeries = {};
    for (const key of keys) out.subjectSeries[key] = rangePoints.filter((p) => p.known).map((p) => ({ date: p.date, value: num((p.subjects || {})[key]) }));
    const seed = beforeRange ? [{ ...beforeRange, known: true }] : [];
    const withSeed = [...seed, ...rangePoints];
    out.periods = {
      day: periodDeltas(withSeed, 'total', (d) => d).filter((b) => b.label >= from),
      week: periodDeltas(withSeed, 'total', weekStartKey).filter((b) => b.label >= weekStartKey(from)),
      month: periodDeltas(withSeed, 'total', monthKey).filter((b) => b.label >= monthKey(from)),
    };
    // Changes inside the range: activity per day and the intraday line for «today».
    const hist = await ctx.col.history.find(
      { studentId: doc._id, at: { $gte: dayStart(from), $lt: dayStart(addDays(to, 1)) } },
      { projection: { at: 1, source: 1, subject: 1, oldValue: 1, newValue: 1, totalAfter: 1, totalBefore: 1 } },
    ).sort({ at: 1 }).toArray();
    const activity = new Map();
    for (const h of hist) {
      const k = dayKey(h.at);
      const a = activity.get(k) || { date: k, total: 0, student: 0, sheet: 0, admin: 0, other: 0 };
      a.total++;
      a[['student', 'sheet', 'admin'].includes(h.source) ? h.source : 'other']++;
      activity.set(k, a);
    }
    out.activity = [...activity.values()];
    if (range === 'today') {
      const start = hist.length ? num(hist[0].totalBefore) : total;
      out.intraday = [{ at: dayStart(today), total: start }, ...hist.map((h) => ({ at: h.at, total: num(h.totalAfter) }))];
      if (out.intraday.length === 1) out.intraday.push({ at: now, total });
    }
  }
  return out;
}

// ───────────── administrator analytics ─────────────

async function accountStats(now) {
  const since = new Date(now.getTime() - 30 * 86400000);
  const [accounts, linked, activeAccounts, activeStudentIds] = await Promise.all([
    ctx.col.users.countDocuments({}),
    ctx.col.users.countDocuments({ studentId: { $type: 'string', $ne: '' } }),
    ctx.col.users.countDocuments({ lastSeenAt: { $gte: since } }),
    ctx.col.users.distinct('studentId', { studentId: { $type: 'string', $ne: '' }, lastSeenAt: { $gte: since } }),
  ]);
  return { accounts, linked, activeAccounts, activeStudents: activeStudentIds.length };
}

function scoreAggregates(rows, cat) {
  const catMap = new Map(cat.map((c) => [c._id, c]));
  let nScores = 0;
  let sumScores = 0;
  let highest = null;
  let lowest = null;
  const bySubject = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.subjects || {})) {
      if (num(v) == null) continue;
      nScores++;
      sumScores += v;
      const s = bySubject.get(k) || { key: k, n: 0, sum: 0, min: null, max: null };
      s.n++; s.sum += v; s.min = s.min == null ? v : Math.min(s.min, v); s.max = s.max == null ? v : Math.max(s.max, v);
      bySubject.set(k, s);
      if (!highest || v > highest.value) highest = { value: v, studentId: r._id, name: r.fullName, group: r.group, subject: k };
      if (!lowest || v < lowest.value) lowest = { value: v, studentId: r._id, name: r.fullName, group: r.group, subject: k };
    }
  }
  const totals = rows.map((r) => num(r.points)).filter((v) => v != null);
  const topTotal = rows.filter((r) => num(r.points) != null).sort((a, b) => b.points - a.points)[0];
  const lowTotal = rows.filter((r) => num(r.points) != null).sort((a, b) => a.points - b.points)[0];
  const subjects = cat.filter((c) => c.active !== false).map((c) => {
    const s = bySubject.get(c._id);
    return { key: c._id, title: scores.titleOf(c, c._id), max: scores.maxOf(c), count: s ? s.n : 0, avg: s ? round2(s.sum / s.n) : null, min: s ? s.min : null, maxValue: s ? s.max : null };
  });
  // Distribution of students by their average score as a share of the subject maximum.
  const bands = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: 0 }));
  let unscored = 0;
  for (const r of rows) {
    const parts = Object.entries(r.subjects || {}).filter(([, v]) => num(v) != null).map(([k, v]) => (v / scores.maxOf(catMap.get(k))) * 100);
    if (!parts.length) { unscored++; continue; }
    const avgPct = parts.reduce((a, b) => a + b, 0) / parts.length;
    bands[Math.min(9, Math.max(0, Math.floor(avgPct / 10)))].count++;
  }
  return {
    scores: nScores, avgScore: nScores ? round2(sumScores / nScores) : null,
    avgTotal: totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
    highest, lowest,
    highestTotal: topTotal ? { value: topTotal.points, studentId: topTotal._id, name: topTotal.fullName, group: topTotal.group } : null,
    lowestTotal: lowTotal ? { value: lowTotal.points, studentId: lowTotal._id, name: lowTotal.fullName, group: lowTotal.group } : null,
    subjects, distribution: bands, unscored,
  };
}

function groupAggregates(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.group) || { group: r.group, students: 0, totals: [], scores: [] };
    g.students++;
    if (num(r.points) != null) g.totals.push(r.points);
    for (const v of Object.values(r.subjects || {})) if (num(v) != null) g.scores.push(v);
    map.set(r.group, g);
  }
  const avg = (a) => (a.length ? round2(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return [...map.values()].map((g) => ({ group: g.group, students: g.students, avgTotal: avg(g.totals), avgScore: avg(g.scores) }))
    .sort((a, b) => String(a.group).localeCompare(String(b.group), 'uk'));
}

/** Students whose total changed between `baseKey` (snapshot) and now. */
function movers(rows, baseMap) {
  const list = [];
  for (const r of rows) {
    const b = baseMap.get(r._id);
    if (!b || num(b.total) == null || num(r.points) == null) continue;
    list.push({ studentId: r._id, name: r.fullName, group: r.group, from: b.total, to: r.points, delta: round2(r.points - b.total), pct: pctChange(b.total, r.points), baseDate: b.date, baseRank: b.rank });
  }
  return list;
}

async function activityByDay(fromKey, toKey, match = {}) {
  const hist = await ctx.col.history.find({ at: { $gte: dayStart(fromKey), $lt: dayStart(addDays(toKey, 1)) }, ...match }, { projection: { at: 1, source: 1 } }).toArray();
  const map = new Map();
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) map.set(k, { date: k, total: 0, student: 0, sheet: 0, admin: 0, other: 0 });
  for (const h of hist) {
    const a = map.get(dayKey(h.at));
    if (!a) continue;
    a.total++;
    a[['student', 'sheet', 'admin'].includes(h.source) ? h.source : 'other']++;
  }
  return [...map.values()];
}

function rollup(days, bucketOf) {
  const out = [];
  for (const d of days) {
    const label = bucketOf(d.date);
    let b = out[out.length - 1];
    if (!b || b.label !== label) { b = { label, total: 0, student: 0, sheet: 0, admin: 0, other: 0 }; out.push(b); }
    for (const k of ['total', 'student', 'sheet', 'admin', 'other']) b[k] += d[k];
  }
  return out;
}

async function adminDashboard() {
  const now = ctx.now();
  const today = dayKey(now);
  const [rows, cat, groupsList, accounts, openConflicts, base7, activity, recentHistory, recentAudit, archived] = await Promise.all([
    ctx.col.ratings.find(ACTIVE, { projection: { fullName: 1, group: 1, points: 1, subjects: 1 } }).toArray(),
    scores.catalog(),
    ctx.col.ratings.distinct('group', ACTIVE),
    accountStats(now),
    ctx.col.conflicts.countDocuments({ status: 'open' }),
    snapshotsAt(addDays(today, -7)),
    activityByDay(addDays(today, -13), today),
    ctx.col.history.find({}).sort({ at: -1 }).limit(12).toArray(),
    ctx.col.audit.find({}).sort({ at: -1 }).limit(8).toArray(),
    ctx.col.ratings.countDocuments({ active: false }),
  ]);
  const agg = scoreAggregates(rows, cat);
  const catMap = new Map(cat.map((c) => [c._id, c]));
  const mv = movers(rows, base7);
  const improvementAvg = mv.length ? round2(mv.reduce((a, m) => a + m.delta, 0) / mv.length) : null;
  return {
    generatedAt: now,
    kpis: {
      students: rows.length, archived, groups: groupsList.length, subjects: cat.filter((c) => c.active !== false).length,
      ...accounts, scores: agg.scores, avgScore: agg.avgScore, avgTotal: agg.avgTotal,
      highest: agg.highest, lowest: agg.lowest, highestTotal: agg.highestTotal, lowestTotal: agg.lowestTotal,
      improvement7d: { available: mv.length > 0, avg: improvementAvg, students: mv.length },
      openConflicts,
    },
    distribution: agg.distribution, unscored: agg.unscored,
    bySubject: agg.subjects, byGroup: groupAggregates(rows),
    improvers: mv.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5),
    decliners: mv.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
    activity,
    recent: [
      ...recentHistory.map((h) => ({
        kind: 'score', at: h.at, source: h.source, studentId: h.studentId, studentName: h.studentName, subject: h.subject,
        subjectTitle: scores.titleOf(catMap.get(h.subject), h.subject), oldValue: h.oldValue, newValue: h.newValue,
        delta: scoreDelta(h.oldValue, h.newValue), actorName: h.actorName, reason: h.reason || '',
      })),
      ...recentAudit.map((a) => ({ kind: 'audit', at: a.at, action: a.action, actorName: a.actorName, target: a.target })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 15),
  };
}

async function adminAnalytics(query) {
  const now = ctx.now();
  const { range, from, to, today } = resolveRange(query, now);
  const group = String((query && typeof query.get === 'function' ? query.get('group') : query && query.group) || '').trim();
  const gm = group ? { group } : {};
  const live = to === today;
  const [rowsNow, cat, trendRaw, baseMap, endMap, days] = await Promise.all([
    ctx.col.ratings.find({ ...ACTIVE, ...gm }, { projection: { fullName: 1, group: 1, points: 1, subjects: 1 } }).toArray(),
    scores.catalog(),
    ctx.col.snapshots.aggregate([
      { $match: { date: { $gte: from, $lte: to }, ...gm } },
      { $group: { _id: { date: '$date', group: '$group' }, avgTotal: { $avg: '$total' }, avgScore: { $avg: '$avg' }, students: { $sum: 1 } } },
      { $sort: { '_id.date': 1 } },
    ]).toArray(),
    snapshotsAt(addDays(from, -1), gm),
    live ? Promise.resolve(null) : snapshotsAt(to, gm),
    activityByDay(from, to, group ? { group } : {}),
  ]);
  // Values at the end of the period: live documents for «today», otherwise that day's snapshots.
  const rows = live ? rowsNow : rowsNow.map((r) => {
    const s = endMap.get(r._id);
    return s ? { ...r, points: s.total, subjects: s.subjects || {}, rank: s.rank } : { ...r, points: null, subjects: {} };
  });
  // Baseline: end of the day before the period, or the first snapshot inside it.
  const firstIn = await snapshotsFirstIn(from, to, gm);
  const base = new Map(baseMap);
  for (const [id, s] of firstIn) if (!base.has(id)) base.set(id, { ...s, partial: true });

  const keys = cat.filter((c) => c.active !== false).map((c) => c._id);
  const rankNow = new Map();
  for (const g of new Set(rows.map((r) => r.group))) {
    for (const [id, v] of groupRanking(rows.filter((r) => r.group === g), [])) rankNow.set(id, v.rank);
  }
  const mv = movers(rows, base);
  const rankMoves = rows.map((r) => {
    const b = base.get(r._id);
    const now2 = rankNow.get(r._id);
    if (!b || b.rank == null || now2 == null) return null;
    return { studentId: r._id, name: r.fullName, group: r.group, from: b.rank, to: now2, change: b.rank - now2 };
  }).filter((x) => x && x.change !== 0).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10);

  const subjectImprovement = keys.map((key) => {
    let n = 0; let sum = 0; let up = 0; let down = 0;
    for (const r of rows) {
      const b = base.get(r._id);
      const v1 = num((r.subjects || {})[key]);
      const v0 = b ? num((b.subjects || {})[key]) : null;
      if (v1 == null || v0 == null) continue;
      n++; sum += v1 - v0;
      if (v1 > v0) up++; else if (v1 < v0) down++;
    }
    const entry = cat.find((c) => c._id === key);
    return { key, title: scores.titleOf(entry, key), students: n, avgDelta: n ? round2(sum / n) : null, improved: up, declined: down };
  }).sort((a, b) => (b.avgDelta == null ? -Infinity : b.avgDelta) - (a.avgDelta == null ? -Infinity : a.avgDelta));

  const trendByDate = new Map();
  const groupsSeen = new Set();
  for (const t of trendRaw) {
    const d = trendByDate.get(t._id.date) || { date: t._id.date, groups: {}, n: 0, sumTotal: 0, sumScore: 0, nScore: 0 };
    d.groups[t._id.group] = { avgTotal: t.avgTotal == null ? null : round2(t.avgTotal), avgScore: t.avgScore == null ? null : round2(t.avgScore), students: t.students };
    groupsSeen.add(t._id.group);
    if (t.avgTotal != null) { d.n += t.students; d.sumTotal += t.avgTotal * t.students; }
    if (t.avgScore != null) { d.nScore += t.students; d.sumScore += t.avgScore * t.students; }
    trendByDate.set(t._id.date, d);
  }
  const agg = scoreAggregates(rows, cat);
  return {
    range: { range, from, to, today }, group,
    trend: [...trendByDate.values()].map((d) => ({ date: d.date, groups: d.groups, avgTotal: d.n ? round2(d.sumTotal / d.n) : null, avgScore: d.nScore ? round2(d.sumScore / d.nScore) : null })),
    trendGroups: [...groupsSeen].sort((a, b) => a.localeCompare(b, 'uk')),
    improvers: mv.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10),
    decliners: mv.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10),
    compared: mv.length,
    rankMoves, subjectImprovement,
    bySubject: agg.subjects, byGroup: groupAggregates(rows), distribution: agg.distribution,
    activity: { day: days, week: rollup(days, weekStartKey), month: rollup(days, monthKey) },
  };
}

async function snapshotsFirstIn(from, to, match = {}) {
  const list = await ctx.col.snapshots.aggregate([
    { $match: { date: { $gte: from, $lte: to }, ...match } },
    { $sort: { studentId: 1, date: 1 } },
    { $group: { _id: '$studentId', s: { $first: '$$ROOT' } } },
  ]).toArray();
  return new Map(list.map((x) => [x._id, x.s]));
}

/** Paginated student list for administrators with real group ranks and 7-day change. */
async function adminStudents(query) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) : query && query[k]) || '';
  const now = ctx.now();
  const today = dayKey(now);
  const status = ['active', 'archived', 'all'].includes(get('status')) ? get('status') : 'active';
  const group = String(get('group')).trim();
  const subject = String(get('subject')).trim();
  const q = normKey(get('q')).slice(0, 60);
  const sort = ['rank', 'name', 'total', 'avg', 'delta', 'subject', 'updated'].includes(get('sort')) ? get('sort') : 'rank';
  const dir = get('dir') === 'desc' ? -1 : get('dir') === 'asc' ? 1 : (['total', 'avg', 'delta', 'subject', 'updated'].includes(sort) ? -1 : 1);
  const limit = Math.min(100, Math.max(5, parseInt(get('limit'), 10) || 25));
  const page = Math.max(1, parseInt(get('page'), 10) || 1);

  const filter = {};
  if (status === 'active') Object.assign(filter, ACTIVE);
  if (status === 'archived') filter.active = false;
  if (group) filter.group = group;
  if (q) filter.nameKey = { $regex: escapeRegex(q) };
  const [rows, cat] = await Promise.all([ctx.col.ratings.find(filter).toArray(), scores.catalog()]);
  const groups = [...new Set(rows.map((r) => r.group))];
  const groupMembers = groups.length ? await ctx.col.ratings.find({ group: { $in: groups }, ...ACTIVE }, { projection: { fullName: 1, group: 1, points: 1, subjects: 1 } }).toArray() : [];
  const keys = subject ? [subject] : [];
  const rank = new Map();
  for (const g of groups) for (const [id, v] of groupRanking(groupMembers.filter((r) => r.group === g), keys)) rank.set(id, v);
  const ids = rows.map((r) => r._id);
  const [base7, accounts] = await Promise.all([
    snapshotsAt(addDays(today, -7), { studentId: { $in: ids } }),
    ctx.col.users.find({ studentId: { $in: ids } }, { projection: { fullName: 1, studentId: 1, lastSeenAt: 1 } }).toArray(),
  ]);
  const accBy = new Map();
  for (const a of accounts) { const l = accBy.get(a.studentId) || []; l.push({ id: a._id, fullName: a.fullName, lastSeenAt: a.lastSeenAt || null }); accBy.set(a.studentId, l); }

  let items = rows.map((r) => {
    const rk = r.active === false ? null : rank.get(r._id);
    const st = subjectStats(r);
    const b = base7.get(r._id);
    const sv = subject ? num((r.subjects || {})[subject]) : null;
    return {
      id: r._id, fullName: r.fullName, group: r.group, note: r.note || '', active: r.active !== false,
      total: num(r.points), avg: st.avg, count: st.count, rank: rk ? rk.rank : null, of: rk ? rk.of : 0,
      delta7: b && num(b.total) != null && num(r.points) != null ? round2(r.points - b.total) : null,
      subjectValue: sv, subjectRank: subject && rk && rk.subjectRanks[subject] ? rk.subjectRanks[subject].rank : null,
      updatedAt: r.updatedAt || null, accounts: accBy.get(r._id) || [],
    };
  });
  const cmpNull = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a - b) * dir);
  const byName = (a, b) => a.fullName.localeCompare(b.fullName, 'uk');
  items.sort((a, b) => {
    switch (sort) {
      case 'name': return byName(a, b) * dir;
      case 'total': return cmpNull(a.total, b.total) || byName(a, b);
      case 'avg': return cmpNull(a.avg, b.avg) || byName(a, b);
      case 'delta': return cmpNull(a.delta7, b.delta7) || byName(a, b);
      case 'subject': return cmpNull(a.subjectValue, b.subjectValue) || byName(a, b);
      case 'updated': return cmpNull(a.updatedAt && +new Date(a.updatedAt), b.updatedAt && +new Date(b.updatedAt)) || byName(a, b);
      default: return String(a.group).localeCompare(String(b.group), 'uk') || cmpNull(a.rank, b.rank) || byName(a, b);
    }
  });
  const total = items.length;
  items = items.slice((page - 1) * limit, page * limit);
  return {
    items, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, sort, dir: dir === -1 ? 'desc' : 'asc', status, group, subject, q: get('q'),
    groups: (await ctx.col.ratings.distinct('group')).sort((a, b) => a.localeCompare(b, 'uk')),
    subjects: cat.filter((c) => c.active !== false).map((c) => ({ key: c._id, title: scores.titleOf(c, c._id) })),
  };
}

module.exports = {
  rankEntries, groupRanking, subjectStats, snapshotGroups, snapshotAll, snapshotsAt, fillDaily, resolveRange, changeOver, periodDeltas,
  studentStats, adminDashboard, adminAnalytics, adminStudents, ACTIVE,
};
