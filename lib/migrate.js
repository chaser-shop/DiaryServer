'use strict';
/*
 * Start-up migrations. Idempotent: safe to run on every start, never deletes existing data.
 *   v2 — score provenance (`scoreMeta`), `active`/`rev` on rating records, subject catalog from
 *        config.ratingSubjects, baseline snapshot for statistics.
 */

const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const scores = require('./scores');
const stats = require('./stats');
const { audit } = require('./audit');
const { uuid, ratingKey, dayKey } = require('./util');

const SCHEMA_VERSION = 2;

const sourceOf = (d) => (d.source === 'google-sheets' ? 'sheet' : d.source === 'import' ? 'import' : d.source ? 'seed' : 'migration');

/** One-time import of the first rating table (seed/rating-101-spd.json) on a fresh database. */
async function seedRating() {
  const KEY = 'ratingSeed101spd';
  let seed;
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'rating-101-spd.json'), 'utf8')); } catch { return; }
  if (Array.isArray(seed.subjects) && seed.subjects.length) {
    await ctx.col.config.updateOne({ _id: 'ratingSubjects' }, { $setOnInsert: { value: seed.subjects } }, { upsert: true });
  }
  if (await ctx.col.config.findOne({ _id: KEY })) return;
  const now = ctx.now();
  let added = 0;
  for (const e of seed.entries || []) {
    try {
      await ctx.col.ratings.insertOne({
        _id: uuid(), group: seed.group, fullName: e.fullName, nameKey: ratingKey(e.fullName),
        points: e.points == null ? null : e.points, subjects: e.subjects || {}, note: e.note || '', createdAt: now, updatedAt: now, source: seed.source,
      });
      added++;
    } catch (err) { if (!err || err.code !== 11000) throw err; }
  }
  await ctx.col.groups.updateOne({ _id: seed.group }, { $setOnInsert: { createdAt: now } }, { upsert: true });
  await ctx.col.config.updateOne({ _id: KEY }, { $set: { value: { at: now, added } } }, { upsert: true });
  console.log(`Рейтинг: імпортовано ${added} студентів групи «${seed.group}».`);
}

async function migrate() {
  const col = ctx.col;
  const now = ctx.now();
  await seedRating();

  // Rating records without provenance (created before v2 or by the seed): describe their current values.
  let normalised = 0;
  for await (const d of col.ratings.find({ scoreMeta: { $exists: false } })) {
    const src = sourceOf(d);
    const meta = {};
    for (const [k, v] of Object.entries(d.subjects || {})) {
      if (typeof v !== 'number') continue;
      const m = { source: src, base: v, updatedAt: d.updatedAt || d.createdAt || now, version: 1 };
      if (src === 'sheet') Object.assign(m, { sheet: v, sheetAt: d.updatedAt || now, original: v });
      meta[k] = m;
    }
    const r = await col.ratings.updateOne(
      { _id: d._id, scoreMeta: { $exists: false } },
      { $set: { scoreMeta: meta, active: d.active !== false, rev: d.rev || 0, fromSheet: src === 'sheet' } },
    );
    normalised += r.modifiedCount;
  }

  // Subject catalog: the previous ordered list plus any subject found in the data.
  const listDoc = await col.config.findOne({ _id: 'ratingSubjects' });
  const keys = listDoc && Array.isArray(listDoc.value) ? [...listDoc.value] : [];
  for (const k of await col.ratings.aggregate([
    { $project: { k: { $objectToArray: { $ifNull: ['$subjects', {}] } } } }, { $unwind: '$k' }, { $group: { _id: '$k.k' } },
  ]).toArray().then((x) => x.map((y) => y._id))) if (!keys.includes(k)) keys.push(k);
  const known = await scores.catalogMap();
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length) await scores.registerSubjects(missing, { fromSheet: false });

  const ver = await col.config.findOne({ _id: 'schemaVersion' });
  if (!ver || ver.value < SCHEMA_VERSION) {
    await col.config.updateOne({ _id: 'schemaVersion' }, { $set: { value: SCHEMA_VERSION, migratedAt: now } }, { upsert: true });
    await audit(null, 'system.migrate', { details: { from: ver ? ver.value : 1, to: SCHEMA_VERSION, normalised, subjects: keys.length } });
    console.log(`Міграція схеми до v${SCHEMA_VERSION}: оновлено записів рейтингу — ${normalised}, предметів — ${keys.length}.`);
  }

  // Statistics need a starting point: today's snapshot of every group.
  if (!(await col.snapshots.findOne({ date: dayKey(now) }))) await stats.snapshotAll(now);
}

module.exports = { migrate, seedRating, SCHEMA_VERSION };
