'use strict';
/*
 * Google Sheets → rating synchronisation.
 *
 *  • Polls every GOOGLE_SHEET_INTERVAL_MS (default 2 min, exponential back-off after errors, max 1 h).
 *  • Every run compares the whole sheet with the database (cheaply, in memory) and writes only real
 *    differences, so changes made in the app between runs (a deleted student, a moved group) are reconciled
 *    even when the sheet itself did not change. A run with an identical sheet and nothing to apply is
 *    logged as «unchanged» (SHA-256 of the downloaded CSV).
 *  • Per student and subject the value is merged through scores.planSheetValue() (see lib/scores.js
 *    for the source-priority rules); every applied value is written to score_history with the run id.
 *  • Students are matched by normalised full name inside the target group (the sheet has no other
 *    stable identifier). A name corrected in the sheet (same «№ з/п», a typo-sized difference) keeps the
 *    existing record instead of creating a duplicate.
 *  • Students missing from the sheet are archived, never deleted, so history and account links survive;
 *    a student archived by an administrator is not brought back by the sheet.
 *  • Safety guard: an automatic run that would archive more than half of the students or empty more than
 *    30 % of the values is aborted (an administrator can force it after checking the sheet).
 */

const os = require('os');
const ctx = require('./context');
const sheets = require('./sheets');
const scores = require('./scores');
const stats = require('./stats');
const notify = require('./notify');
const { audit } = require('./audit');
const { parse: parseRatingGrid } = require('../public/rating.js');
const {
  HttpError, uuid, sha256, cleanGroup, normName, ratingKey, fmtNum, str, similarNames,
} = require('./util');

const STATE_KEY = 'googleRatingSync';
const LOCK_KEY = 'syncLock';
const GROUP_KEY = 'syncGroup';
const SYNC_ARCHIVE_REASON = 'Відсутній у Google-таблиці';
const IMPORT_ARCHIVE_REASON = 'Відсутній у завантаженому файлі';
const OWNER = `${os.hostname()}:${process.pid}:${uuid().slice(0, 8)}`;
const HAS = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

let cfg = { enabled: false };
let running = null;
let timer = null;
let nextRunAt = null;
let ranSinceStart = false;

/** Archived by an administrator on purpose (records from before `archivedBy` are recognised by the reason). */
const archivedByAdmin = (d) => d.active === false && (d.archivedBy === 'admin'
  || (!d.archivedBy && !!d.archivedReason && d.archivedReason !== SYNC_ARCHIVE_REASON && d.archivedReason !== IMPORT_ARCHIVE_REASON));

function configure(env = process.env) {
  const s = sheets.sheetSettings(env);
  cfg = {
    ...s,
    group: cleanGroup(env.GOOGLE_SHEET_GROUP || '101 СПД') || '101 СПД',
    intervalMs: Math.max(60000, parseInt(env.GOOGLE_SHEET_INTERVAL_MS, 10) || 2 * 60 * 1000),
    enabled: !!(s.id || s.csvUrl) && String(env.GOOGLE_SHEET_SYNC || '').toLowerCase() !== 'off',
  };
  return cfg;
}

const settings = () => cfg;

async function getState() {
  const doc = await ctx.col.config.findOne({ _id: STATE_KEY });
  return (doc && doc.value) || {};
}

async function setState(patch) {
  const $set = {};
  for (const [k, v] of Object.entries(patch)) $set['value.' + k] = v;
  await ctx.col.config.updateOne({ _id: STATE_KEY }, { $set }, { upsert: true });
}

/**
 * Group the sheet fills: GOOGLE_SHEET_GROUP, or the new name after an administrator renamed that group.
 * The stored name applies only while GOOGLE_SHEET_GROUP is unchanged, so editing the setting still wins.
 */
async function targetGroup() {
  const doc = await ctx.col.config.findOne({ _id: GROUP_KEY });
  const v = doc && doc.value;
  return v && v.env === cfg.group && v.group ? v.group : cfg.group;
}

async function setTargetGroup(group) {
  await ctx.col.config.updateOne({ _id: GROUP_KEY }, { $set: { value: { env: cfg.group, group, at: ctx.now() } } }, { upsert: true });
}

/** True until the first run after start-up has finished (clients re-check shortly to pick up fresh data). */
const pending = () => !!cfg.enabled && (!!running || !ranSinceStart);

async function acquireLock(ms = 5 * 60 * 1000) {
  const now = new Date();
  try {
    await ctx.col.config.findOneAndUpdate(
      { _id: LOCK_KEY, $or: [{ 'value.expiresAt': { $lt: now } }, { 'value.owner': OWNER }] },
      { $set: { value: { owner: OWNER, expiresAt: new Date(now.getTime() + ms) } } },
      { upsert: true },
    );
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false;
    throw e;
  }
}
const releaseLock = () => ctx.col.config.deleteOne({ _id: LOCK_KEY, 'value.owner': OWNER }).catch(() => {});

const emptyStats = () => ({
  rows: 0, newStudents: 0, updatedStudents: 0, unchangedStudents: 0, reactivated: 0, archived: 0,
  changedScores: 0, conflicts: 0, invalidCells: 0, newSubjects: 0, renamed: 0,
});

async function createStudent(group, e, source) {
  const now = ctx.now();
  const doc = {
    _id: uuid(), group, fullName: e.fullName, nameKey: e.nameKey, note: e.note || '', sheetRemark: e.remark || '', sheetRow: e.number == null ? null : e.number,
    active: true, fromSheet: source === 'google-sheets', subjects: {}, scoreMeta: {}, points: null, rev: 0, createdAt: now, updatedAt: now, source,
  };
  try {
    await ctx.col.ratings.insertOne(doc);
    return { doc, created: true };
  } catch (err) {
    if (err && err.code === 11000) return { doc: await ctx.col.ratings.findOne({ group, nameKey: e.nameKey }), created: false };
    throw err;
  }
}

async function finishRun(run, state, patch) {
  run.finishedAt = ctx.now();
  run.durationMs = run.finishedAt - run.startedAt;
  if (run.status === 'unchanged' && !run.forced) {
    // Identical sheet: extend the previous «unchanged» record instead of flooding the history.
    const last = await ctx.col.syncRuns.find({}).sort({ startedAt: -1 }).limit(1).next();
    if (last && last.status === 'unchanged' && last.contentHash === run.contentHash && last.kind === run.kind) {
      await ctx.col.syncRuns.updateOne({ _id: last._id }, { $inc: { repeats: 1 }, $set: { lastRepeatAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs } });
      run._id = last._id;
    } else {
      await ctx.col.syncRuns.insertOne({ ...run, repeats: 0 });
    }
  } else {
    await ctx.col.syncRuns.insertOne({ ...run, repeats: 0 });
  }
  await setState({ ...patch, lastRunId: run._id, lastRunStatus: run.status, lastAttemptAt: run.startedAt });
  return run;
}

async function doSync({ kind, actor, force }) {
  const state = await getState();
  const group = await targetGroup();
  const run = {
    _id: uuid(), kind, forced: !!force, actorId: actor ? actor._id : null, actorName: actor ? actor.fullName : 'Автоматично',
    startedAt: ctx.now(), status: 'running', group, stats: emptyStats(), warnings: [],
  };
  await setState({ status: 'running', runningSince: run.startedAt });
  let sheet;
  try {
    sheet = await sheets.readSheet(cfg);
  } catch (e) {
    run.status = 'error';
    run.error = String((e && e.message) || e).slice(0, 500);
    const errors = (state.consecutiveErrors || 0) + 1;
    return finishRun(run, state, { status: 'error', lastError: run.error, lastErrorAt: run.startedAt, consecutiveErrors: errors });
  }
  const hash = sha256(sheet.raw);
  Object.assign(run, { method: sheet.method, gid: sheet.gid, sheetTitle: sheet.sheetTitle, contentHash: hash });
  run.warnings.push(...sheet.warnings);
  const common = {
    method: sheet.method, methodTitle: sheets.METHOD_TITLES[sheet.method] || sheet.method, gid: sheet.gid,
    sheetTitle: sheet.sheetTitle || state.sheetTitle || '', title: sheet.title || state.title || '', group,
  };
  // An identical sheet is still compared with the database (see the header); it only affects the run status.
  const sameContent = state.contentHash === hash && !!state.lastSuccessAt;

  let parsed;
  try {
    parsed = parseRatingGrid(sheet.grid);
  } catch (e) {
    run.status = 'error';
    run.error = 'Структура таблиці не розпізнана: ' + String(e.message || e).slice(0, 400);
    return finishRun(run, state, { ...common, status: 'error', lastError: run.error, lastErrorAt: run.startedAt, consecutiveErrors: (state.consecutiveErrors || 0) + 1 });
  }
  if (parsed.entries.length > 2000) {
    run.status = 'error';
    run.error = 'У таблиці понад 2000 студентів — синхронізацію зупинено.';
    return finishRun(run, state, { ...common, status: 'error', lastError: run.error, lastErrorAt: run.startedAt, consecutiveErrors: (state.consecutiveErrors || 0) + 1 });
  }
  const subjects = parsed.subjects;
  run.stats.rows = parsed.entries.length;
  for (const d of parsed.duplicates) run.warnings.push(`Рядок із ПІБ «${d}» повторюється — використано перший.`);

  const existing = await ctx.col.ratings.find({ group }).toArray();
  const byKey = new Map(existing.map((d) => [d.nameKey, d]));
  const inSheet = new Set(parsed.entries.map((e) => e.nameKey));
  const absent = existing.filter((d) => d.active !== false && d.fromSheet && !inSheet.has(d.nameKey));
  // A name corrected in the sheet: an unknown name in the row («№ з/п») of a student who has just
  // disappeared, spelled almost the same. That student's record is renamed instead of duplicated.
  // Administrator-archived records are candidates too, so a correction never brings them back as a new active record.
  const candidates = absent.concat(existing.filter((d) => archivedByAdmin(d) && d.fromSheet && !inSheet.has(d.nameKey)));
  const renames = new Map();
  for (const e of parsed.entries) {
    if (byKey.has(e.nameKey) || e.number == null) continue;
    const d = candidates.find((x) => x.sheetRow != null && String(x.sheetRow) === String(e.number)
      && ![...renames.values()].includes(x) && similarNames(x.fullName, e.fullName));
    if (d) renames.set(e.nameKey, d);
  }
  const renamedIds = new Set([...renames.values()].map((d) => d._id));
  const missing = absent.filter((d) => !renamedIds.has(d._id));
  const activeFromSheet = existing.filter((d) => d.active !== false && d.fromSheet).length;

  // Safety guard against a broken / half-empty sheet.
  let sheetValues = 0;
  let clears = 0;
  for (const e of parsed.entries) {
    const d = byKey.get(e.nameKey) || renames.get(e.nameKey);
    if (!d) continue;
    for (const s of subjects) {
      const m = (d.scoreMeta || {})[s];
      if (m && m.sheet != null) {
        sheetValues++;
        if (!HAS(e.subjects, s) && !HAS(e.invalid, s)) clears++;
      }
    }
  }
  const guard = !force && ((activeFromSheet >= 5 && missing.length > activeFromSheet * 0.5) || (sheetValues >= 10 && clears > sheetValues * 0.3));
  if (guard) {
    run.status = 'aborted';
    run.error = missing.length > activeFromSheet * 0.5
      ? `У таблиці бракує ${missing.length} із ${activeFromSheet} студентів. Синхронізацію зупинено, щоб не втратити дані. Перевірте таблицю або запустіть примусову синхронізацію.`
      : `Таблиця очистила б ${clears} із ${sheetValues} балів. Синхронізацію зупинено, щоб не втратити дані. Перевірте таблицю або запустіть примусову синхронізацію.`;
    return finishRun(run, state, { ...common, status: 'aborted', lastError: run.error, lastErrorAt: run.startedAt });
  }

  const catalogBefore = await scores.catalogMap();
  await scores.registerSubjects(subjects, { fromSheet: true });
  run.stats.newSubjects = subjects.filter((s) => !catalogBefore.has(s)).length;
  const catalog = await scores.catalogMap();
  const initial = !state.lastSuccessAt;
  const changedStudents = [];

  for (const e of parsed.entries) {
    for (const [s, raw] of Object.entries(e.invalid || {})) {
      run.stats.invalidCells++;
      if (run.warnings.length < 40) run.warnings.push(`Рядок ${e.row}, «${s}»: значення «${raw}» не є числом — пропущено.`);
    }
    for (const [s, v] of Object.entries(e.subjects)) {
      const max = scores.maxOf(catalog.get(s));
      if (v > max && run.warnings.length < 40) run.warnings.push(`Рядок ${e.row}, «${s}»: ${fmtNum(v)} перевищує максимум ${fmtNum(max)}.`);
    }
    const renamedFrom = !byKey.has(e.nameKey) ? renames.get(e.nameKey) : null;
    let doc = byKey.get(e.nameKey) || renamedFrom;
    let created = false;
    if (!doc) {
      const c = await createStudent(group, e, 'google-sheets');
      doc = c.doc;
      created = c.created;
      if (c.created) run.stats.newStudents++;
    }
    const keepArchived = archivedByAdmin(doc);
    if (keepArchived && run.warnings.length < 40) {
      run.warnings.push(`«${e.fullName}» є в таблиці, але архівований адміністратором — запис не відновлено (відновити можна в картці студента).`);
    }
    let reactivated = false;
    const planner = (d) => {
      const items = [];
      for (const s of subjects) {
        if (HAS(e.invalid, s)) continue;
        items.push(scores.planSheetValue(d, s, HAS(e.subjects, s) ? e.subjects[s] : null, { now: ctx.now() }));
      }
      const set = {};
      if (d.fullName !== e.fullName) set.fullName = e.fullName;
      if (d.nameKey !== e.nameKey) set.nameKey = e.nameKey;
      if ((d.note || '') !== (e.note || '')) set.note = e.note || '';
      if ((d.sheetRemark || '') !== (e.remark || '')) set.sheetRemark = e.remark || '';
      if ((d.sheetRow == null ? null : d.sheetRow) !== (e.number == null ? null : e.number)) set.sheetRow = e.number == null ? null : e.number;
      if (d.active === false && !archivedByAdmin(d)) {
        Object.assign(set, { active: true, archivedAt: null, archivedReason: null, archivedBy: null });
        reactivated = true;
      }
      if (!d.fromSheet) set.fromSheet = true;
      return { items, set: Object.keys(set).length ? set : null, source: 'sheet', syncRunId: run._id };
    };
    // Nothing differs from the copy read at the start of the run → no write (commitStudent re-reads otherwise).
    const preview = created ? null : planner(doc);
    if (preview && !preview.set && preview.items.every((p) => p.kind === 'none')) {
      run.stats.unchangedStudents++;
      continue;
    }
    reactivated = false;
    const res = await scores.commitStudent(doc._id, planner);
    if (renamedFrom) {
      run.stats.renamed++;
      await ctx.col.users.updateMany({ studentId: doc._id }, { $set: { studentName: e.fullName } });
      if (run.warnings.length < 40) {
        run.warnings.push(`ПІБ виправлено в таблиці: «${renamedFrom.fullName}» → «${e.fullName}» (№ ${e.number}). Бали, історію й прив’язку облікового запису збережено.`);
      }
    }
    if (reactivated) run.stats.reactivated++;
    run.stats.changedScores += res.entries.length;
    run.stats.conflicts += res.conflicts.length;
    if (res.entries.length || res.conflicts.length || res.items.length) run.stats.updatedStudents++;
    else run.stats.unchangedStudents++;
    if (res.entries.length) changedStudents.push({ doc: res.doc, entries: res.entries });
  }

  const now = ctx.now();
  const newRows = new Map(parsed.entries.filter((e) => !byKey.has(e.nameKey) && !renames.has(e.nameKey)).map((e) => [e.number, e]));
  for (const d of missing) {
    await ctx.col.ratings.updateOne(
      { _id: d._id, active: { $ne: false } },
      { $set: { active: false, archivedAt: now, archivedReason: SYNC_ARCHIVE_REASON, archivedBy: 'sync', updatedAt: now }, $inc: { rev: 1 } },
    );
    run.stats.archived++;
    const renamed = d.sheetRow != null && newRows.get(d.sheetRow);
    if (renamed && run.warnings.length < 40) {
      run.warnings.push(`Можливе перейменування: «${d.fullName}» → «${renamed.fullName}» (№ ${d.sheetRow}). ПІБ відрізняються надто сильно, щоб об’єднати записи автоматично, — перевірте прив’язку облікового запису.`);
    }
  }

  if (changedStudents.length || run.stats.archived || run.stats.newStudents || run.stats.reactivated || run.stats.renamed) {
    await stats.snapshotGroups([group], now);
  }
  if (!initial) {
    for (const c of changedStudents) await notify.onSheetChanges(run._id, c.doc, c.entries).catch((e) => console.error('sync notify:', e.message));
  }
  const st = run.stats;
  const changed = !!(st.changedScores || st.newStudents || st.archived || st.reactivated || st.renamed || st.conflicts || st.updatedStudents);
  run.status = !force && sameContent && !changed ? 'unchanged' : 'success';
  const result = await finishRun(run, state, {
    ...common, status: 'ok', contentHash: hash, lastSuccessAt: run.startedAt, lastError: '', consecutiveErrors: 0,
    ...(st.changedScores || st.newStudents || st.archived || st.reactivated || st.renamed ? { lastChangeAt: run.startedAt } : {}),
    students: parsed.entries.length, subjects: subjects.length, warnings: run.warnings.slice(0, 40),
  });
  if (run.status === 'success') {
    console.log(`Google Sheets: ${st.rows} рядків, змінено балів ${st.changedScores}, нових студентів ${st.newStudents}, конфліктів ${st.conflicts}.`);
  }
  return result;
}

/**
 * Runs fn while no synchronisation can run (on this or another instance). Renaming the synced group moves
 * its records first; a run that read the old name meanwhile would re-create every student under it.
 */
async function exclusive(fn) {
  while (running) await running.catch(() => {});
  let done;
  running = new Promise((resolve) => { done = resolve; });
  try {
    if (cfg.enabled && !(await acquireLock(60 * 1000))) {
      throw new HttpError(409, 'Зараз триває синхронізація з Google-таблицею. Спробуйте ще раз за хвилину.', { code: 'sync_locked' });
    }
    try {
      return await fn();
    } finally {
      if (cfg.enabled) await releaseLock();
    }
  } finally {
    running = null;
    done();
  }
}

/** Runs one synchronisation. Automatic runs are skipped silently while another run is in progress. */
async function runSync({ kind = 'auto', actor = null, force = false } = {}) {
  if (!cfg.enabled) throw new HttpError(400, 'Синхронізацію з Google Sheets не налаштовано (GOOGLE_SHEET_ID).', { code: 'sync_disabled' });
  if (running) {
    if (kind === 'auto') return null;
    throw new HttpError(409, 'Синхронізація вже виконується. Зачекайте кілька секунд.', { code: 'sync_running' });
  }
  running = (async () => {
    if (!(await acquireLock())) {
      if (kind === 'auto') return null;
      throw new HttpError(409, 'Синхронізацію вже запущено на іншому екземплярі сервера.', { code: 'sync_locked' });
    }
    try {
      return await doSync({ kind, actor, force });
    } finally {
      await releaseLock();
      ranSinceStart = true;
    }
  })();
  try {
    return await running;
  } catch (e) {
    if (!(e instanceof HttpError)) {
      // Unexpected failure (database etc.): keep the state readable for administrators.
      await setState({ status: 'error', lastError: String(e.message || e).slice(0, 500), lastErrorAt: ctx.now() }).catch(() => {});
    }
    throw e;
  } finally {
    running = null;
  }
}

function nextDelay(state) {
  const errors = (state && state.consecutiveErrors) || 0;
  return errors ? Math.min(cfg.intervalMs * 2 ** Math.min(errors, 5), 60 * 60 * 1000) : cfg.intervalMs;
}

function schedule(delayMs) {
  clearTimeout(timer);
  nextRunAt = new Date(Date.now() + delayMs);
  setState({ nextRunAt }).catch(() => {});
  timer = setTimeout(async () => {
    try { await runSync({ kind: 'auto' }); } catch (e) { console.error('Google Sheets sync:', e.message); }
    schedule(nextDelay(await getState().catch(() => ({}))));
  }, delayMs);
  if (timer.unref) timer.unref();
}

function start({ firstDelayMs = 3000 } = {}) {
  if (!cfg.enabled) return false;
  schedule(firstDelayMs);
  console.log(`Google Sheets: синхронізація кожні ${Math.round(cfg.intervalMs / 60000)} хв.`);
  return true;
}

function stop() { clearTimeout(timer); timer = null; }

/** Status for the administrator page (no secrets: only booleans for keys and private URLs). */
async function status() {
  const now = ctx.now();
  const since = new Date(now.getTime() - 30 * 86400000);
  const [state, totals, openConflicts, runsCount] = await Promise.all([
    getState(),
    ctx.col.syncRuns.aggregate([
      { $match: { startedAt: { $gte: since } } },
      {
        $group: {
          _id: null, runs: { $sum: { $add: [1, { $ifNull: ['$repeats', 0] }] } },
          errors: { $sum: { $cond: [{ $in: ['$status', ['error', 'aborted']] }, 1, 0] } },
          rows: { $sum: '$stats.rows' }, newStudents: { $sum: '$stats.newStudents' }, updatedStudents: { $sum: '$stats.updatedStudents' },
          changedScores: { $sum: '$stats.changedScores' }, conflicts: { $sum: '$stats.conflicts' }, archived: { $sum: '$stats.archived' },
        },
      },
    ]).toArray(),
    ctx.col.conflicts.countDocuments({ status: 'open' }),
    ctx.col.syncRuns.countDocuments({}),
  ]);
  return {
    configured: cfg.enabled,
    running: !!running,
    settings: {
      spreadsheetId: cfg.id || '', url: cfg.id ? sheets.sheetUrl(cfg.id, state.gid || cfg.gid) : '', gid: cfg.gid || '', group: await targetGroup(), configuredGroup: cfg.group,
      intervalMinutes: Math.round((cfg.intervalMs || 0) / 60000), serviceAccount: !!cfg.serviceAccountJson, customCsvUrl: !!cfg.csvUrl,
    },
    state: { ...state, nextRunAt: nextRunAt || state.nextRunAt || null },
    totals30: totals[0] ? { ...totals[0], _id: undefined } : { runs: 0, errors: 0, rows: 0, newStudents: 0, updatedStudents: 0, changedScores: 0, conflicts: 0, archived: 0 },
    openConflicts, runsCount,
  };
}

async function diagnostics(actor) {
  const result = await sheets.diagnose(cfg);
  await setState({ lastDiagnostics: result }).catch(() => {});
  await audit(actor, 'sync.diagnostics', { details: { accessible: result.accessible, method: result.method } });
  return result;
}

// ───────────── administrator file import ─────────────

/**
 * Bulk import from a file parsed in the browser (RatingParser). Values from the file are applied as an
 * administrator decision (source «import»); empty cells of listed subjects clear the score; students of the
 * group that are missing from the file are archived (not deleted).
 */
async function importFile(admin, body, groupFallback) {
  const subjects = [];
  for (const raw of Array.isArray(body.subjects) ? body.subjects.slice(0, 30) : []) {
    const k = str(raw, 30).replace(/[.$]/g, '').trim();
    if (k && !subjects.includes(k)) subjects.push(k);
  }
  if (!subjects.length) throw new HttpError(400, 'У таблиці немає предметів.');
  if (!Array.isArray(body.entries) || !body.entries.length) throw new HttpError(400, 'У таблиці немає студентів.');
  if (body.entries.length > 2000) throw new HttpError(400, 'Забагато студентів у файлі.');
  const group = cleanGroup(body.group) || groupFallback;
  if (!group) throw new HttpError(400, 'Оберіть групу для імпорту.');

  const rows = new Map();
  for (const raw of body.entries) {
    const fullName = normName(raw && raw.fullName).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (fullName.split(' ').length < 2 || fullName.length > 100) continue;
    const key = ratingKey(fullName);
    if (rows.has(key)) continue;
    const values = {};
    for (const s of subjects) {
      const v = raw && raw.subjects ? raw.subjects[s] : undefined;
      if (v === undefined || v === null || v === '') { values[s] = null; continue; }
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (Number.isFinite(n) && n >= 0 && n <= 100000) values[s] = Math.round(n * 100) / 100;
    }
    rows.set(key, { fullName, nameKey: key, note: str(raw && raw.note, 60), values });
  }
  if (!rows.size) throw new HttpError(400, 'У таблиці не знайдено жодного коректного ПІБ.');

  await scores.registerSubjects(subjects, { fromSheet: false });
  const existing = await ctx.col.ratings.find({ group }).toArray();
  const byKey = new Map(existing.map((d) => [d.nameKey, d]));
  const opId = uuid();
  const result = { group, students: rows.size, subjects: subjects.length, created: 0, changedScores: 0, archived: 0 };
  for (const r of rows.values()) {
    let doc = byKey.get(r.nameKey);
    if (!doc) {
      const c = await createStudent(group, { fullName: r.fullName, nameKey: r.nameKey, note: r.note }, 'import');
      doc = c.doc;
      if (c.created) result.created++;
    }
    const res = await scores.commitStudent(doc._id, (d) => {
      const items = subjects.map((s) => scores.planImportValue(d, s, r.values[s] === undefined ? scores.currentOf(d, s) : r.values[s], { now: ctx.now(), actor: admin }));
      const set = {};
      if ((d.note || '') !== r.note) set.note = r.note;
      if (d.active === false) Object.assign(set, { active: true, archivedAt: null, archivedReason: null, archivedBy: null });
      return { items, set: Object.keys(set).length ? set : null, source: 'import', actor: admin, opId, reason: 'Імпорт таблиці з файлу' };
    });
    result.changedScores += res.entries.length;
    if (res.entries.length) await notify.onSheetChanges(opId, res.doc, res.entries, 'import').catch(() => {});
  }
  const now = ctx.now();
  for (const d of existing) {
    if (d.active === false || rows.has(d.nameKey)) continue;
    await ctx.col.ratings.updateOne({ _id: d._id, active: { $ne: false } }, { $set: { active: false, archivedAt: now, archivedReason: IMPORT_ARCHIVE_REASON, archivedBy: 'import', updatedAt: now }, $inc: { rev: 1 } });
    result.archived++;
  }
  await stats.snapshotGroups([group], now);
  await audit(admin, 'rating.import', { target: { type: 'group', id: group, name: group }, details: { ...result, opId } });
  return result;
}

module.exports = {
  configure, settings, runSync, exclusive, start, stop, status, diagnostics, getState, importFile, targetGroup, setTargetGroup, pending, SYNC_ARCHIVE_REASON,
};
