'use strict';
/*
 * Shared server helpers: errors, input normalisation, score parsing, calendar keys in the
 * application time zone (Europe/Kyiv by default) and Ukrainian number/plural formatting.
 */

const crypto = require('crypto');
const { nameKey } = require('../public/rating.js');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const toDate = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uuid = () => crypto.randomUUID();
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const normKey = (s) => normName(s).toLocaleLowerCase('uk');
/** Key for matching a person between the spreadsheet, the rating and accounts (no "(староста)", one apostrophe). */
const ratingKey = nameKey;
const cleanGroup = (v) => str(normName(v), 40);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const sameValue = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);

/** Subject keys come from spreadsheet headers and are used as MongoDB field names. */
const cleanSubjectKey = (k) => str(k, 30).replace(/[.$]/g, '').replace(/\s+/g, ' ').trim();

const NUMERIC = /^\d+(?:[.,]\d+)?$/;

/**
 * Strict score parser used for every value that comes from a person (student or administrator).
 * Accepts finite non-negative numbers or plain decimal strings ("82", "82,5"); rejects booleans,
 * objects, hex/exponent notation, NaN and Infinity. Result is rounded to 2 decimals.
 */
function parseScore(v, { max = 100000, allowNull = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (allowNull) return null;
    throw new HttpError(400, 'Вкажіть бал.', { code: 'score_required' });
  }
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && NUMERIC.test(v.trim())) n = Number(v.trim().replace(',', '.'));
  else throw new HttpError(400, 'Бал має бути числом.', { code: 'score_type' });
  if (!Number.isFinite(n)) throw new HttpError(400, 'Бал має бути числом.', { code: 'score_type' });
  if (n < 0) throw new HttpError(400, 'Бал не може бути від’ємним.', { code: 'score_negative' });
  n = round2(n);
  if (n > max) throw new HttpError(400, `Бал не може перевищувати ${fmtNum(max)}.`, { code: 'over_max', max });
  return n;
}

// ───────────── calendar in the application time zone ─────────────

const TZ = (() => {
  for (const z of [process.env.APP_TZ, 'Europe/Kyiv', 'Europe/Kiev']) {
    if (!z) continue;
    try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { /* next */ }
  }
  return 'UTC';
})();

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function zonedParts(date) {
  const p = {};
  for (const x of partsFmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mi: +p.minute, ss: +p.second };
}
const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' of the given moment in the application time zone. */
function dayKey(date) {
  const p = zonedParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t;
}
const isDayKey = (key) => parseDayKey(key) != null;
function addDays(key, n) {
  const d = new Date(parseDayKey(key) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const daysBetween = (a, b) => Math.round((parseDayKey(b) - parseDayKey(a)) / 86400000);
/** 0 = Sunday … 6 = Saturday */
const weekdayOf = (key) => new Date(parseDayKey(key)).getUTCDay();
/** Monday of the week containing the day. */
const weekStartKey = (key) => addDays(key, -((weekdayOf(key) + 6) % 7));
const monthKey = (key) => String(key).slice(0, 7);
/** ISO week label 'YYYY-Www' (used to deduplicate weekly summaries). */
function isoWeekKey(key) {
  const d = new Date(parseDayKey(key));
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
/** UTC instant of local midnight at the start of the day. */
function dayStart(key) {
  const wall = parseDayKey(key);
  const offsetAt = (ms) => {
    const p = zonedParts(new Date(ms));
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss) - Math.floor(ms / 1000) * 1000;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc);
}
const localHour = (date) => zonedParts(date).hh;

// ───────────── Ukrainian formatting ─────────────

const numFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const fmtNum = (n) => (n == null ? '—' : numFmt.format(n).replace(/\u00a0/g, ' '));
const fmtPct = (n) => (n == null ? '—' : pctFmt.format(n).replace(/\u00a0/g, ' '));

/** Ukrainian plural: forms = [one, few, many]; fractional numbers take the genitive singular («7,5 бала»). */
function plural(n, forms, fraction) {
  const a = Math.abs(n);
  if (!Number.isInteger(a)) return fraction || forms[1];
  const d10 = a % 10;
  const d100 = a % 100;
  if (d10 === 1 && d100 !== 11) return forms[0];
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return forms[1];
  return forms[2];
}
const pointsWord = (n) => plural(n, ['бал', 'бали', 'балів'], 'бала');
/** «на 1 позицію / 2 позиції / 5 позицій» */
const positionsWord = (n) => plural(n, ['позицію', 'позиції', 'позицій'], 'позиції');

/** Percentage change ((new − old) / old × 100); null when it cannot be computed (missing or zero base). */
function pctChange(oldValue, newValue) {
  if (oldValue == null || newValue == null || oldValue === 0) return null;
  return round1(((newValue - oldValue) / Math.abs(oldValue)) * 100);
}

/** Change between two scores; null when either side is missing (a first score or a cleared score is not «+N»). */
const scoreDelta = (oldValue, newValue) => (typeof oldValue === 'number' && typeof newValue === 'number' ? round2(newValue - oldValue) : null);

function editDistance(a, b) {
  const x = String(a);
  const y = String(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/**
 * The same person with a corrected spelling: same number of words, same initials and at most two changed
 * letters. Deliberately strict — a wrong match would hand one student's record to another.
 */
function similarNames(a, b) {
  const x = ratingKey(a).split(' ');
  const y = ratingKey(b).split(' ');
  if (x.length !== y.length || x.some((w, i) => w.charAt(0) !== y[i].charAt(0))) return false;
  return editDistance(x.join(' '), y.join(' ')) <= 2;
}

module.exports = {
  HttpError, clampInt, str, toDate, sha, sha256, uuid, normName, normKey, ratingKey, cleanGroup, escapeRegex,
  round2, round1, sameValue, cleanSubjectKey, parseScore,
  TZ, zonedParts, dayKey, parseDayKey, isDayKey, addDays, daysBetween, weekdayOf, weekStartKey, monthKey, isoWeekKey, dayStart, localHour,
  fmtNum, fmtPct, plural, pointsWord, positionsWord, pctChange, scoreDelta, editDistance, similarNames,
};
