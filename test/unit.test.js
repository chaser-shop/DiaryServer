'use strict';
/* Unit tests for pure logic: score validation, merge rules, statistics helpers, formatting, parser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../lib/util');
const scores = require('../lib/scores');
const stats = require('../lib/stats');
const RatingParser = require('../public/rating.js');
const { readCSV } = require('../public/schedule.js');

const NOW = new Date('2026-11-12T10:00:00Z');

test('parseScore accepts only plain non-negative numbers', () => {
  assert.equal(util.parseScore(82, { max: 100 }), 82);
  assert.equal(util.parseScore('82,5', { max: 100 }), 82.5);
  assert.equal(util.parseScore(' 7.125 ', { max: 100 }), 7.13);
  assert.equal(util.parseScore('', { allowNull: true }), null);
  for (const bad of ['abc', '0x10', '1e2', true, {}, [], NaN, Infinity, '-5']) {
    assert.throws(() => util.parseScore(bad, { max: 100 }), (e) => e.status === 400, String(bad));
  }
  assert.throws(() => util.parseScore(-1, { max: 100 }), /від’ємним/);
  assert.throws(() => util.parseScore(101, { max: 100 }), (e) => e.extra.code === 'over_max');
  assert.throws(() => util.parseScore(null), (e) => e.extra.code === 'score_required');
});

test('pctChange handles zero and missing bases', () => {
  assert.equal(util.pctChange(20, 25), 25);
  assert.equal(util.pctChange(25, 20), -20);
  assert.equal(util.pctChange(3, 4), 33.3);
  assert.equal(util.pctChange(0, 5), null);
  assert.equal(util.pctChange(null, 5), null);
  assert.equal(util.pctChange(5, null), null);
});

test('Ukrainian plural forms', () => {
  const p = util.pointsWord;
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(p),
    ['бал', 'бали', 'бали', 'балів', 'балів', 'балів', 'балів', 'бал', 'бали', 'балів', 'бал', 'балів']);
  assert.equal(p(7.5), 'бала');
  assert.deepEqual([1, 3, 5, 21].map(util.positionsWord), ['позицію', 'позиції', 'позицій', 'позицію']);
});

test('calendar helpers use Europe/Kyiv including DST', () => {
  assert.equal(util.dayKey(new Date('2026-11-12T22:30:00Z')), '2026-11-13'); // 00:30 in Kyiv
  assert.equal(util.dayStart('2026-07-01').toISOString(), '2026-06-30T21:00:00.000Z');
  assert.equal(util.dayStart('2026-01-15').toISOString(), '2026-01-14T22:00:00.000Z');
  assert.equal(util.dayStart('2026-03-29').toISOString(), '2026-03-28T22:00:00.000Z');
  assert.equal(util.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(util.daysBetween('2026-11-05', '2026-11-12'), 7);
  assert.equal(util.weekStartKey('2026-11-12'), '2026-11-09');
  assert.equal(util.isoWeekKey('2026-11-12'), '2026-W46');
  assert.equal(util.isoWeekKey('2027-01-01'), '2026-W53');
  assert.equal(util.isDayKey('2026-02-30'), false);
});

const doc = (subjects, meta = {}) => ({ _id: 's1', subjects, scoreMeta: meta, rev: 3 });

test('student may only raise own score, up to the maximum', () => {
  const d = doc({ 'Укр': 75 }, { 'Укр': { source: 'sheet', sheet: 75 } });
  const p = scores.planStudentIncrease(d, 'Укр', 82, { max: 100, now: NOW, actor: { _id: 'u1' } });
  assert.equal(p.kind, 'change');
  assert.equal(p.oldValue, 75);
  assert.equal(p.newValue, 82);
  assert.equal(p.meta.source, 'student');
  assert.equal(p.meta.base, 75);
  assert.equal(p.meta.sheet, 75, 'sync baseline is preserved');
  assert.throws(() => scores.planStudentIncrease(d, 'Укр', 75, { max: 100, now: NOW }), (e) => e.extra.code === 'not_increase');
  assert.throws(() => scores.planStudentIncrease(d, 'Укр', 60, { max: 100, now: NOW }), (e) => e.extra.code === 'not_increase');
  assert.throws(() => scores.planStudentIncrease(d, 'Укр', 101, { max: 100, now: NOW }), (e) => e.extra.code === 'over_max');
  assert.throws(() => scores.planStudentIncrease(d, 'Укр', 90, { max: 100, now: NOW, expected: 70 }), (e) => e.extra.code === 'stale');
  // A second increase keeps the original authoritative base.
  const d2 = doc({ 'Укр': 82 }, { 'Укр': p.meta });
  assert.equal(scores.planStudentIncrease(d2, 'Укр', 90, { max: 100, now: NOW }).meta.base, 75);
  // No score yet: anything above zero.
  assert.equal(scores.planStudentIncrease(doc({}), 'Англ', 5, { max: 100, now: NOW }).oldValue, null);
  assert.throws(() => scores.planStudentIncrease(doc({}), 'Англ', 0, { max: 100, now: NOW }));
});

test('spreadsheet merge rules', () => {
  const sheetDoc = doc({ 'Укр': 40 }, { 'Укр': { source: 'sheet', sheet: 40, original: 40 } });
  assert.equal(scores.planSheetValue(sheetDoc, 'Укр', 40, { now: NOW }).kind, 'none', 'unchanged sheet value is ignored');
  const down = scores.planSheetValue(sheetDoc, 'Укр', 35, { now: NOW });
  assert.equal(down.kind, 'change', 'sheet-sourced value follows the sheet, also downwards');
  assert.equal(down.newValue, 35);
  assert.equal(down.meta.original, 40, 'original sheet value is kept');

  const studentDoc = doc({ 'Укр': 50 }, { 'Укр': { source: 'student', sheet: 40, base: 40 } });
  assert.equal(scores.planSheetValue(studentDoc, 'Укр', 40, { now: NOW }).kind, 'none', 'old sheet value never overwrites a newer score');
  const lower = scores.planSheetValue(studentDoc, 'Укр', 45, { now: NOW });
  assert.equal(lower.kind, 'conflict', 'changed but lower sheet value → conflict');
  assert.equal(lower.meta.sheet, 45);
  assert.deepEqual([lower.conflict.sheetPrev, lower.conflict.sheetValue, lower.conflict.effectiveValue], [40, 45, 50]);
  const higher = scores.planSheetValue(studentDoc, 'Укр', 55, { now: NOW });
  assert.equal(higher.kind, 'change');
  assert.equal(higher.meta.source, 'sheet');
  assert.ok(higher.resolves);
  assert.equal(scores.planSheetValue(studentDoc, 'Укр', 50, { now: NOW }).kind, 'meta', 'sheet caught up exactly');
  assert.equal(scores.planSheetValue(studentDoc, 'Укр', null, { now: NOW }).kind, 'conflict', 'emptied cell never erases a local score');

  const imported = doc({ 'Укр': 30 }, { 'Укр': { source: 'import' } });
  assert.equal(scores.planSheetValue(imported, 'Укр', 20, { now: NOW }).kind, 'change', 'first sync replaces imported values');
  assert.equal(scores.planSheetValue(doc({}), 'Укр', null, { now: NOW }).kind, 'none');
});

test('administrator correction may go in any direction but respects the maximum', () => {
  const d = doc({ 'Укр': 80 }, { 'Укр': { source: 'student' } });
  const p = scores.planAdminSet(d, 'Укр', 60, { max: 100, now: NOW, actor: { _id: 'a' } });
  assert.equal(p.newValue, 60);
  assert.equal(p.meta.source, 'admin');
  assert.equal(scores.planAdminSet(d, 'Укр', 80, { max: 100, now: NOW }).kind, 'none');
  assert.throws(() => scores.planAdminSet(d, 'Укр', 120, { max: 100, now: NOW }));
  assert.equal(scores.totalOf({ a: 10.1, b: 20.2 }, {}), 30.3);
  assert.equal(scores.totalOf({}, { subjects: { a: 1 }, points: 1 }), null);
  assert.equal(scores.totalOf({}, { points: 12 }), 12, 'legacy manual total without subjects');
});

test('ranking: equal points share a place, no points → no place', () => {
  const r = stats.rankEntries([
    { _id: 'a', fullName: 'А', points: 40 }, { _id: 'b', fullName: 'Б', points: 50 }, { _id: 'c', fullName: 'В', points: 40 },
    { _id: 'd', fullName: 'Г', points: null }, { _id: 'e', fullName: 'Ґ', points: 30 },
  ]);
  assert.deepEqual(r.map((x) => [x._id, x.rank]), [['b', 1], ['a', 2], ['c', 2], ['e', 4], ['d', null]]);
});

test('daily series carry values forward and report partial baselines', () => {
  const pts = stats.fillDaily({ date: '2026-11-01', total: 100, rank: 5 }, [{ date: '2026-11-03', total: 110, rank: 4 }], '2026-11-02', '2026-11-04');
  assert.deepEqual(pts.map((p) => [p.date, p.total, p.rank]), [['2026-11-02', 100, 5], ['2026-11-03', 110, 4], ['2026-11-04', 110, 4]]);
  const ch = stats.changeOver(pts, { date: '2026-11-01', total: 100 }, 'total');
  assert.deepEqual([ch.delta, ch.pct, ch.partial], [10, 10, false]);
  const noBase = stats.fillDaily(null, [{ date: '2026-11-03', total: 50 }], '2026-11-02', '2026-11-04');
  assert.equal(noBase[0].known, false);
  const partial = stats.changeOver(noBase, null, 'total');
  assert.equal(partial.partial, true);
  assert.equal(partial.delta, 0);
  assert.equal(stats.changeOver([{ date: '2026-11-02', known: false }], null, 'total'), null);
  const r = stats.resolveRange({ range: 'custom', from: '2026-11-01', to: '2026-12-31' }, NOW);
  assert.equal(r.to, '2026-11-12', 'future end is clamped to today');
  assert.throws(() => stats.resolveRange({ range: 'custom', from: '2026-11-10', to: '2026-11-01' }, NOW));
});

test('rating parser reads the spreadsheet layout', () => {
  const grid = readCSV(fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet.csv')));
  const p = RatingParser.parse(grid);
  assert.deepEqual(p.subjects, ['СПОУ', 'ТіДтП', 'Укр', 'СФП', 'КПУ', 'Інформ', 'вступ', 'Англ']);
  assert.equal(p.entries.length, 8);
  const boyko = p.entries[1];
  assert.equal(boyko.fullName, 'Бойко Богдана Богданівна');
  assert.equal(boyko.note, 'староста');
  assert.equal(boyko.number, 2);
  const zhuk = p.entries.find((e) => e.fullName.startsWith('Жук'));
  assert.deepEqual(zhuk.invalid, { 'Інформ': 'н/а' });
  assert.equal('Інформ' in zhuk.subjects, false);
  const d = p.entries.find((e) => e.fullName.startsWith('Дмитренко'));
  assert.equal(d.remark, 'ПОТРЕБУЄ ОНОВЛЕННЯ');
  assert.equal(d.nameKey, RatingParser.nameKey('дмитренко дар’я олегівна'));
  assert.deepEqual(p.entries[2].subjects, {});
});
