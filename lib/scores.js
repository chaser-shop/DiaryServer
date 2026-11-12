'use strict';
/*
 * Score service: every change of a student's score goes through commitStudent().
 *
 * Data model (collection `navsrating`, one document per student in a group):
 *   subjects  { key: number }       effective score per subject (what everyone sees; kept for API compatibility)
 *   points    number | null         effective total = sum of `subjects`
 *   scoreMeta { key: {              provenance of each subject score
 *     source    'sheet' | 'student' | 'admin' | 'import' | 'seed' | 'migration'  — who set the effective value
 *     sheet     last value read from the spreadsheet (undefined = never synced, null = empty cell)
 *     sheetAt   when that spreadsheet value was first seen
 *     original  first non-empty value ever read from the spreadsheet
 *     base      last value set by an authoritative source (sheet/import/admin) — the student increase is value − base
 *     admin, adminAt   last administrator correction
 *     updatedAt, by, version }
 *   rev       optimistic-concurrency counter (compare-and-swap on every write)
 *
 * Source-priority strategy (also documented in docs/ARCHITECTURE.md):
 *   1. An unchanged spreadsheet value never touches the effective score (change detection against `sheet`).
 *   2. A changed spreadsheet value is applied when the effective value came from the sheet/import/seed,
 *      or when it is not lower than a locally modified (student/admin) value.
 *   3. A changed spreadsheet value that is LOWER than a student/admin value (or an emptied cell) does not
 *      overwrite it: the conflict is stored in `score_conflicts` and shown to administrators.
 *   4. Students may only raise their own scores, up to the subject maximum.
 *   5. Administrators may set any value (with a reason); every change is written to `score_history`.
 */

const ctx = require('./context');
const { HttpError, uuid, round2, sameValue, cleanSubjectKey, parseScore, fmtNum, scoreDelta } = require('./util');

const LOCAL_SOURCES = new Set(['student', 'admin']);
const RETRY = Symbol('retry');

// ───────────── subject catalog ─────────────

let catalogCache = null;
async function catalog() {
  if (catalogCache && Date.now() - catalogCache.at < 15000) return catalogCache.list;
  const list = await ctx.col.catalog.find({}).sort({ order: 1, _id: 1 }).toArray();
  catalogCache = { at: Date.now(), list };
  return list;
}
const invalidateCatalog = () => { catalogCache = null; };
async function catalogMap() {
  return new Map((await catalog()).map((c) => [c._id, c]));
}
const defaultMax = () => ctx.settings.defaultMaxScore || 100;
const maxOf = (entry) => (entry && entry.maxScore > 0 ? entry.maxScore : defaultMax());
const titleOf = (entry, key) => (entry && entry.title ? entry.title : key);
/** Active subjects in display order. */
async function subjectKeys() {
  return (await catalog()).filter((c) => c.active !== false).map((c) => c._id);
}

/**
 * Registers subjects seen in the spreadsheet / an import. Sheet order defines display order;
 * subjects that disappeared from the sheet are kept (their scores are preserved) but flagged.
 */
async function registerSubjects(keys, { fromSheet = false } = {}) {
  const now = ctx.now();
  const existing = await catalogMap();
  const ops = [];
  keys.forEach((key, i) => {
    const set = { updatedAt: now };
    if (fromSheet) { set.inSheet = true; set.order = i; }
    ops.push({
      updateOne: {
        filter: { _id: key },
        update: { $set: set, $setOnInsert: { title: '', maxScore: defaultMax(), active: true, createdAt: now, ...(fromSheet ? {} : { order: existing.size + i, inSheet: false }) } },
        upsert: true,
      },
    });
  });
  if (fromSheet) {
    const gone = [...existing.keys()].filter((k) => !keys.includes(k) && existing.get(k).inSheet !== false);
    if (gone.length) ops.push({ updateMany: { filter: { _id: { $in: gone } }, update: { $set: { inSheet: false, order: 1000 + keys.length, updatedAt: now } } } });
  }
  if (ops.length) await ctx.col.catalog.bulkWrite(ops, { ordered: false });
  invalidateCatalog();
  return [...existing.keys()].length;
}

// ───────────── planning (pure) ─────────────

const currentOf = (doc, subject) => {
  const v = doc.subjects && doc.subjects[subject];
  return typeof v === 'number' ? v : null;
};
const metaOf = (doc, subject) => ({ ...((doc.scoreMeta && doc.scoreMeta[subject]) || {}) });

/** Student raises own score. Throws HttpError with a Ukrainian message when the rule is violated. */
function planStudentIncrease(doc, subject, value, { max, now, actor, expected }) {
  const current = currentOf(doc, subject);
  if (expected !== undefined && !sameValue(expected, current)) {
    throw new HttpError(409, `Бал щойно змінився: зараз ${current == null ? 'немає балу' : fmtNum(current)}. Перевірте значення й спробуйте ще раз.`, { code: 'stale', current });
  }
  if (value > max) throw new HttpError(400, `Максимальний бал з цього предмета — ${fmtNum(max)}.`, { code: 'over_max', max });
  if (!(value > (current == null ? 0 : current))) {
    throw new HttpError(400, current == null
      ? 'Новий бал має бути більшим за 0.'
      : `Новий бал має бути більшим за поточний (${fmtNum(current)}). Знизити бал неможливо.`, { code: 'not_increase', current });
  }
  const meta = metaOf(doc, subject);
  return {
    kind: 'change', subject, oldValue: current, newValue: value,
    meta: {
      ...meta, source: 'student', base: meta.source === 'student' ? (meta.base == null ? current : meta.base) : current,
      updatedAt: now, by: actor ? actor._id : null, version: (meta.version || 0) + 1,
    },
  };
}

/** Administrator correction: any value in [0, max] or null (clear). */
function planAdminSet(doc, subject, value, { max, now, actor }) {
  const current = currentOf(doc, subject);
  if (value != null && value > max) throw new HttpError(400, `Максимальний бал з цього предмета — ${fmtNum(max)}.`, { code: 'over_max', max });
  if (sameValue(current, value)) return { kind: 'none', subject };
  const meta = metaOf(doc, subject);
  return {
    kind: 'change', subject, oldValue: current, newValue: value,
    meta: { ...meta, source: 'admin', base: value, admin: value, adminAt: now, updatedAt: now, by: actor ? actor._id : null, version: (meta.version || 0) + 1 },
  };
}

/** Value from an administrator's file import (bulk, deliberate, applied as is). */
function planImportValue(doc, subject, value, { now, actor }) {
  const current = currentOf(doc, subject);
  if (sameValue(current, value)) return { kind: 'none', subject };
  const meta = metaOf(doc, subject);
  return {
    kind: 'change', subject, oldValue: current, newValue: value,
    meta: { ...meta, source: 'import', base: value, updatedAt: now, by: actor ? actor._id : null, version: (meta.version || 0) + 1 },
  };
}

/**
 * Spreadsheet value for one subject (sheetValue: number, or null for an empty cell).
 *   none     — the sheet did not change since the last sync;
 *   meta     — only the sync baseline moves (effective value already equal);
 *   change   — effective value takes the sheet value;
 *   conflict — sheet changed to a value lower than a student/admin value: effective value is preserved.
 */
function planSheetValue(doc, subject, sheetValue, { now }) {
  const meta = metaOf(doc, subject);
  const current = currentOf(doc, subject);
  if (meta.sheet !== undefined && sameValue(meta.sheet, sheetValue)) return { kind: 'none', subject };
  if (meta.sheet === undefined && sheetValue == null && current == null) return { kind: 'none', subject };
  const next = { ...meta, sheet: sheetValue, sheetAt: now };
  if (next.original == null && sheetValue != null) next.original = sheetValue;
  const conflictInfo = { sheetPrev: meta.sheet === undefined ? null : meta.sheet, sheetValue, effectiveValue: current, effectiveSource: meta.source || null, effectiveUpdatedAt: meta.updatedAt || null };

  if (sameValue(current, sheetValue)) {
    return { kind: 'meta', subject, meta: { ...next, source: 'sheet', base: sheetValue }, resolves: true };
  }
  const local = LOCAL_SOURCES.has(meta.source);
  if (!local || (sheetValue != null && (current == null || sheetValue > current))) {
    return {
      kind: 'change', subject, oldValue: current, newValue: sheetValue, resolves: true,
      meta: { ...next, source: 'sheet', base: sheetValue, updatedAt: now, by: null, version: (meta.version || 0) + 1 },
    };
  }
  return { kind: 'conflict', subject, meta: next, conflict: conflictInfo };
}

// ───────────── atomic commit ─────────────

async function runAtomic(fn) {
  if (!ctx.txn) return fn(undefined);
  const session = ctx.client.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession().catch(() => {});
  }
}

function totalOf(subjects, doc, set) {
  const vals = Object.values(subjects).filter((v) => typeof v === 'number');
  if (vals.length) return round2(vals.reduce((a, b) => a + b, 0));
  if (set && 'points' in set) return set.points;
  const had = doc.subjects && Object.keys(doc.subjects).length;
  return had ? null : (doc.points == null ? null : doc.points);
}

const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

/**
 * Applies planner(doc) to one student atomically: compare-and-swap on `rev`, history entries and
 * conflict records are written together (inside a transaction when the deployment supports it).
 * planner(doc) → { items: [plans], set?, source, actor?, reason?, requestId?, syncRunId?, conflictId?, after?(session, next, now) }
 */
async function commitStudent(studentId, planner, { requestId } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = await runAtomic(async (session) => {
      const doc = await ctx.col.ratings.findOne({ _id: studentId }, { session });
      if (!doc) throw new HttpError(404, 'Студента не знайдено.');
      if (requestId) {
        // Idempotent replay: the same client request must not be applied twice.
        const prev = await ctx.col.history.findOne({ requestId }, { session });
        if (prev) {
          if (prev.studentId !== doc._id) throw new HttpError(409, 'Повторний ідентифікатор запиту.');
          return { doc, items: [], entries: [prev], conflicts: [], replay: true };
        }
      }
      const plan = await planner(doc);
      const items = plan.items.filter((p) => p.kind !== 'none');
      if (!items.length && !plan.set) return { doc, items: [], entries: [], conflicts: [] };
      const now = ctx.now();
      const subjects = { ...(doc.subjects || {}) };
      const scoreMeta = { ...(doc.scoreMeta || {}) };
      for (const p of items) {
        if (p.kind === 'change') {
          if (p.newValue == null) delete subjects[p.subject]; else subjects[p.subject] = p.newValue;
        }
        if (p.meta) scoreMeta[p.subject] = p.meta;
      }
      const totalBefore = doc.points == null ? null : doc.points;
      const set = { ...(plan.set || {}), subjects, scoreMeta, rev: (doc.rev || 0) + 1, updatedAt: now };
      set.points = totalOf(subjects, doc, plan.set);
      const r = await ctx.col.ratings.updateOne({ _id: doc._id, rev: doc.rev == null ? null : doc.rev }, { $set: set }, { session });
      if (!r.matchedCount) return RETRY;
      const next = { ...doc, ...set };
      const opId = plan.opId || uuid();
      const actor = plan.actor || null;
      const changes = items.filter((p) => p.kind === 'change');
      const entries = changes.map((p, i) => clean({
        _id: uuid(), opId, requestId: i === 0 ? plan.requestId : undefined, at: now,
        studentId: doc._id, studentName: next.fullName, group: next.group,
        subject: p.subject, oldValue: p.oldValue, newValue: p.newValue, delta: scoreDelta(p.oldValue, p.newValue),
        source: plan.source, actorId: actor ? actor._id : null, actorName: actor ? actor.fullName : (plan.source === 'sheet' ? 'Google Sheets' : 'Система'),
        reason: plan.reason || undefined, syncRunId: plan.syncRunId, conflictId: plan.conflictId,
        totalBefore, totalAfter: set.points,
      }));
      if (entries.length) await ctx.col.history.insertMany(entries, { session });

      const conflicts = [];
      for (const p of items) {
        if (p.kind === 'conflict') {
          const res = await ctx.col.conflicts.findOneAndUpdate(
            { studentId: doc._id, subject: p.subject, status: 'open' },
            {
              $set: { studentName: next.fullName, group: next.group, sheetValue: p.conflict.sheetValue, effectiveValue: p.conflict.effectiveValue, effectiveSource: p.conflict.effectiveSource, effectiveUpdatedAt: p.conflict.effectiveUpdatedAt, updatedAt: now, lastSyncRunId: plan.syncRunId || null },
              $setOnInsert: { _id: uuid(), detectedAt: now, sheetPrev: p.conflict.sheetPrev, syncRunId: plan.syncRunId || null },
              $push: { sheetValues: { value: p.conflict.sheetValue, at: now } },
            },
            { upsert: true, returnDocument: 'after', session },
          );
          conflicts.push(res && res.value !== undefined ? res.value : res);
        } else if (p.resolves) {
          await ctx.col.conflicts.updateMany(
            { studentId: doc._id, subject: p.subject, status: 'open' },
            { $set: { status: 'resolved', resolution: 'superseded', resolvedValue: p.kind === 'change' ? p.newValue : currentOf(next, p.subject), resolvedAt: now, resolvedByName: 'Синхронізація', note: 'Нове значення з таблиці не нижче за поточне — конфлікт закрито автоматично.' } },
            { session },
          );
        }
      }
      if (plan.after) await plan.after(session, next, now);
      return { doc: next, before: doc, items, entries, conflicts, totalBefore, totalAfter: set.points };
    });
    if (out !== RETRY) return out;
  }
  throw new HttpError(409, 'Дані щойно змінилися. Спробуйте ще раз.', { code: 'busy' });
}

// ───────────── public operations ─────────────

/** Student self-service increase. Identity comes ONLY from the authenticated account. */
async function studentIncrease(user, body, { deviceTrusted = true } = {}) {
  if (!user.studentId) throw new HttpError(403, 'Ваш обліковий запис ще не прив’язано до студента в рейтингу. Зверніться до адміністратора.', { code: 'not_linked' });
  if (ctx.settings.trustedDevicesOnly && !deviceTrusted) {
    throw new HttpError(403, 'Змінювати бали можна лише з підтвердженого пристрою. Попросіть адміністратора підтвердити цей пристрій.', { code: 'device_untrusted' });
  }
  const subject = cleanSubjectKey(body && body.subject);
  const entry = (await catalogMap()).get(subject);
  if (!subject || !entry || entry.active === false) throw new HttpError(400, 'Такого предмета немає у вашому списку.', { code: 'unknown_subject' });
  const max = maxOf(entry);
  const value = parseScore(body.value, { max });
  let expected;
  if (body && Object.prototype.hasOwnProperty.call(body, 'expected')) expected = parseScore(body.expected, { allowNull: true });
  const requestId = body && typeof body.requestId === 'string' && /^[\w-]{8,64}$/.test(body.requestId) ? body.requestId : undefined;
  return commitStudent(user.studentId, (doc) => {
    if (doc.active === false) throw new HttpError(403, 'Ваш запис у рейтингу архівовано — змінювати бали неможливо.', { code: 'archived' });
    return {
      source: 'student', actor: user, requestId,
      items: [planStudentIncrease(doc, subject, value, { max, now: ctx.now(), actor: user, expected })],
    };
  }, { requestId });
}

/** Administrator correction of one subject (value null clears the score). */
async function adminSet(admin, studentId, body) {
  const subject = cleanSubjectKey(body && body.subject);
  const entry = (await catalogMap()).get(subject);
  if (!subject || !entry) throw new HttpError(400, 'Невідомий предмет.', { code: 'unknown_subject' });
  const max = maxOf(entry);
  const value = parseScore(body.value, { max, allowNull: true });
  const reason = String((body && body.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (reason.length < 3) throw new HttpError(400, 'Вкажіть причину виправлення (щонайменше 3 символи).', { code: 'reason_required' });
  const res = await commitStudent(studentId, (doc) => ({
    source: 'admin', actor: admin, reason,
    items: [planAdminSet(doc, subject, value, { max, now: ctx.now(), actor: admin })],
  }));
  if (!res.entries.length) throw new HttpError(400, 'Нове значення збігається з поточним.', { code: 'same_value' });
  return res;
}

/** Administrator decision on an open conflict. */
async function resolveConflict(admin, conflictId, body) {
  const c = await ctx.col.conflicts.findOne({ _id: conflictId });
  if (!c) throw new HttpError(404, 'Конфлікт не знайдено.');
  if (c.status !== 'open') throw new HttpError(409, 'Цей конфлікт уже розв’язано.');
  const resolution = String((body && body.resolution) || '');
  if (!['accept_sheet', 'keep_current', 'custom'].includes(resolution)) throw new HttpError(400, 'Оберіть спосіб розв’язання.');
  const note = String((body && body.note) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const entry = (await catalogMap()).get(c.subject);
  const max = maxOf(entry);
  let target;
  if (resolution === 'accept_sheet') target = c.sheetValue == null ? null : c.sheetValue;
  if (resolution === 'custom') target = parseScore(body.value, { max });
  const closeWith = (value, now) => ({
    status: 'resolved', resolution, resolvedValue: value, resolvedAt: now, resolvedBy: admin._id, resolvedByName: admin.fullName, note,
  });
  const res = await commitStudent(c.studentId, (doc) => {
    const current = currentOf(doc, c.subject);
    const items = resolution === 'keep_current' ? [] : [planAdminSet(doc, c.subject, target, { max: Math.max(max, target || 0), now: ctx.now(), actor: admin })];
    return {
      source: 'admin', actor: admin, conflictId: c._id,
      reason: `Розв’язання конфлікту з таблицею${note ? ': ' + note : ''}`,
      items,
      set: { conflictCheckedAt: ctx.now() },
      after: async (session, next, now) => {
        const r = await ctx.col.conflicts.updateOne(
          { _id: c._id, status: 'open' },
          { $set: { ...closeWith(resolution === 'keep_current' ? current : currentOf(next, c.subject), now), effectiveAtResolution: current } },
          { session },
        );
        if (!r.matchedCount) throw new HttpError(409, 'Цей конфлікт уже розв’язано.');
      },
    };
  });
  return { conflict: await ctx.col.conflicts.findOne({ _id: c._id }), ...res };
}

module.exports = {
  LOCAL_SOURCES, catalog, catalogMap, invalidateCatalog, registerSubjects, subjectKeys, maxOf, titleOf, defaultMax,
  planStudentIncrease, planAdminSet, planImportValue, planSheetValue, currentOf, totalOf,
  runAtomic, commitStudent, studentIncrease, adminSet, resolveConflict,
};
