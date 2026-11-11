'use strict';
/*
 * Щоденник студента — сервер.
 * Node.js + MongoDB + Web Push. Віддає вебверсію (папка public) і REST API,
 * сумісний із iOS-застосунком (/api/auth/login, /api/sync, /api/homework …).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const webpush = require('web-push');

// ───────────────────────── Налаштування ─────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'navs';
const APP_TZ = process.env.APP_TZ || 'Europe/Kyiv';
const GRADES_DB = process.env.GRADES_DB || 'diary'; // база, де лежить колекція grades
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_DEVICES = parseInt(process.env.MAX_DEVICES, 10) || 5; // скільки пристроїв може мати одна людина

// Apple відхиляє підписи сповіщень (403 BadJwtToken), якщо «sub» фіктивний (example.com, you@…).
// Тому підставну адресу замінюємо на https-адресу самого сервісу, а в логах просимо вказати реальну.
function resolveVapidSubject() {
  const raw = (process.env.VAPID_SUBJECT || '').trim();
  const fake = !raw || /example\.(com|org|net)|localhost|@you\b|you@/i.test(raw);
  if (!fake) return raw;
  const self = process.env.RENDER_EXTERNAL_URL;
  console.warn('VAPID_SUBJECT не задано або фіктивний — вкажіть реальну пошту (mailto:ви@gmail.com). iOS інакше відповідає 403.');
  if (self && /^https:\/\//.test(self)) return self;
  return raw || 'mailto:admin@example.com';
}
const VAPID_SUBJECT = resolveVapidSubject();
const TICK_MS = parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) || 30000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 5 * 1024 * 1024;

const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const normKey = (s) => normName(s).toLocaleLowerCase('uk');
const ADMIN_NAMES = new Set((process.env.ADMIN_NAMES || '').split(',').map(normKey).filter(Boolean));

if (!MONGODB_URI) {
  console.error('Не задано MONGODB_URI. Додайте змінну середовища з рядком підключення до MongoDB.');
  process.exit(1);
}

// ───────────────────────── Утиліти ─────────────────────────

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
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cleanLink(v) {
  let s = str(v, 500);
  if (!s) return '';
  if (!s.includes('://')) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'Некоректне посилання.'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Посилання має починатися з http:// або https://');
  return u.toString();
}

function cleanSettings(s) {
  s = s || {};
  return {
    notificationsEnabled: s.notificationsEnabled !== false,
    leadMinutes: clampInt(s.leadMinutes, 1, 15, 2),
    askHomework: s.askHomework !== false,
    notifyHomework: s.notifyHomework !== false,
  };
}

const fmtTime = (d) =>
  new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: APP_TZ }).format(d);
const fmtDay = (d) =>
  new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: APP_TZ }).format(d);
const kindTitle = (k) => ({ 'Лк': 'Лекція', 'Пз': 'Практична', 'Сем': 'Семінар', '': 'Пара' }[k] ?? k);
const placeTitle = (l) => (l.isRemote ? 'Дистанційно' : l.room ? 'ауд. ' + l.room : '—');

// ───────────────────────── База даних ─────────────────────────

let db, users, lessons, subjects, teachers, homework, pushSubs, sent, config, noHw, answers, hwImages, grades, gradesSeen, ratings, groupsCol;
let SECRET;
let VAPID_KEY_ID = '';

async function getConfig(key, make) {
  const doc = await config.findOne({ _id: key });
  if (doc) return doc.value;
  const value = make();
  try {
    await config.insertOne({ _id: key, value });
    return value;
  } catch (e) {
    if (e && e.code === 11000) return (await config.findOne({ _id: key })).value;
    throw e;
  }
}

async function initDb() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);
  users = db.collection('users');
  lessons = db.collection('lessons');
  subjects = db.collection('subjects');
  teachers = db.collection('teachers');
  homework = db.collection('homework');
  pushSubs = db.collection('pushSubs');
  sent = db.collection('sentNotifications');
  config = db.collection('config');
  answers = db.collection('answers'); // кому з користувачів уже відповів на «Що задали?» (діє на всіх його пристроях)
  hwImages = db.collection('hwImages'); // зображення, прикріплені до домашнього
  noHw = db.collection('noHomework'); // пари, на які адміністратор сказав «нічого не задали»
  grades = client.db(GRADES_DB).collection('grades'); // оцінки (заповнюються поза цим сервером; тут лише читаємо)
  gradesSeen = db.collection('gradesSeen'); // id оцінок, про які адміністратора вже сповіщено
  ratings = db.collection('ratings'); // рейтинг студентів: один запис = студент у групі
  groupsCol = db.collection('groups'); // навчальні групи (_id = назва)

  await users.createIndex({ nameKey: 1 }, { unique: true });
  await ratings.createIndex({ group: 1, nameKey: 1 }, { unique: true });
  await ratings.createIndex({ nameKey: 1 });
  await lessons.createIndex({ start: 1 });
  await lessons.createIndex({ end: 1 });
  await homework.createIndex({ due: 1 });
  await hwImages.createIndex({ hwId: 1 });
  await pushSubs.createIndex({ userId: 1 });
  await answers.createIndex({ userId: 1 });
  await answers.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
  await noHw.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
  await sent.createIndex({ at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });

  await seedRating();

  SECRET = process.env.JWT_SECRET || (await getConfig('jwtSecret', () => crypto.randomBytes(32).toString('hex')));

  let vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    vapid = await getConfig('vapid', () => webpush.generateVAPIDKeys());
  }
  webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
  VAPID_KEY_ID = sha(vapid.publicKey);
  return vapid.publicKey;
}

// ───────────────────────── Токени ─────────────────────────

const TOKEN_TTL = 365 * 24 * 3600 * 1000;

function signToken(uid) {
  const p = Buffer.from(JSON.stringify({ u: uid, t: Date.now() })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return p + '.' + s;
}

function verifyToken(token) {
  const [p, s] = String(token || '').split('.');
  if (!p || !s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (!safeEq(s, exp)) return null;
  try {
    const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!data.u || Date.now() - data.t > TOKEN_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

const attempts = new Map();
function rateLimit(ip, max = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(ip, list);
  if (list.length > max) throw new HttpError(429, 'Забагато спроб. Спробуйте за кілька хвилин.');
}
setInterval(() => attempts.clear(), 60 * 60 * 1000).unref();

// ───────────────────────── Серіалізація ─────────────────────────

const ROLES = { starosta: 'Староста', deputy: 'Заступник старости' };
/** Адміністратор, староста або заступник старости: підтверджують домашнє й завантажують розклад. */
const isMod = (u) => !!(u && (u.isAdmin || ROLES[u.role]));
const pubUser = (u) => ({ id: u._id, fullName: u.fullName, isAdmin: !!u.isAdmin, role: ROLES[u.role] ? u.role : '', canModerate: isMod(u) });
const pubLesson = (l) => ({
  id: l._id, pair: l.pair, start: l.start, end: l.end, subjectKey: l.subjectKey,
  kind: l.kind, topic: l.topic, room: l.room, teacher: l.teacher, isRemote: !!l.isRemote,
});
const pubHw = (h) => ({
  id: h._id, subjectKey: h.subjectKey, lessonID: h.lessonID || null, text: h.text,
  due: h.due, created: h.created, status: h.status, authorID: h.authorID, authorName: h.authorName,
  links: h.links || [], images: h.images || [],
});

// ───────────────────────── Push ─────────────────────────

/**
 * Повертає { ok, status, body }. Підписки, яких push-сервіс уже не приймає (404/410), видаляємо.
 * 403/401 зазвичай означає, що підписку створено з ІНШИМ VAPID-ключем (ключі перегенерувалися) —
 * така підписка нікому не потрібна, видаляємо її, а клієнт сам створить нову.
 */
async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), {
      TTL: payload.ttl || 600,
      urgency: 'high',
    });
    return { ok: true };
  } catch (e) {
    const status = (e && e.statusCode) || 0;
    const body = e && e.body ? String(e.body).slice(0, 200) : '';
    if (status === 404 || status === 410 || /VapidPkHashMismatch/i.test(body)) {
      // 400 VapidPkHashMismatch: підписку створено з іншим VAPID-ключем — вона марна, клієнт створить нову.
      await pushSubs.deleteOne({ _id: sub._id }).catch(() => {});
      if (status === 400) console.error('push 400: VapidPkHashMismatch — стару підписку видалено');
    } else if ((status === 401 || status === 403) && sub.vapidKey !== VAPID_KEY_ID) {
      await pushSubs.deleteOne({ _id: sub._id }).catch(() => {});
      console.error(`push ${status}: підписка зі старим VAPID-ключем видалена`, body);
    } else {
      console.error('push error:', status || (e && e.message) || e, body);
    }
    return { ok: false, status, body };
  }
}

async function subjectNames() {
  const map = {};
  for (const s of await subjects.find({}).toArray()) {
    if (s.fullName && s.fullName.trim()) map[s._id] = s.fullName.trim();
  }
  return map;
}

const enc = encodeURIComponent;

function startPayload(l, names, now) {
  const mins = Math.max(1, Math.round((l.start.getTime() - now) / 60000));
  return {
    title: `Пара через ${mins} хв — заходь!`,
    body: `${names[l.subjectKey] || l.subjectKey} · ${kindTitle(l.kind)} · ${fmtTime(l.start)} · ${placeTitle(l)}`,
    tag: 'start-' + l._id,
    data: { url: `/?lesson=${enc(l._id)}&join=1` },
    actions: [{ action: 'open', title: 'Відкрити пару' }],
    ttl: 300,
  };
}

function endPayload(l, names) {
  return {
    title: `Пара закінчилась: ${names[l.subjectKey] || l.subjectKey}`,
    body: 'Що задали додому?',
    tag: 'end-' + l._id,
    data: { url: `/?homework=${enc(l._id)}`, noneUrl: `/?answered=${enc(l._id)}` },
    actions: [
      { action: 'write', title: 'Записати ДЗ' },
      { action: 'none', title: 'Нічого не задали' },
    ],
    ttl: 1800,
  };
}

async function claim(key) {
  try {
    await sent.insertOne({ _id: key, at: new Date() });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false;
    throw e;
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const subs = await pushSubs.find({ 'settings.notificationsEnabled': true }).toArray();
    if (!subs.length) return;
    const starting = await lessons.find({ start: { $gt: new Date(now), $lte: new Date(now + 16 * 60000) } }).toArray();
    const ended = await lessons.find({ end: { $gt: new Date(now - 20 * 60000), $lte: new Date(now) } }).toArray();
    if (!starting.length && !ended.length) return;
    const names = await subjectNames();
    const noHwIds = new Set(ended.length ? (await noHw.find({ _id: { $in: ended.map((l) => l._id) } }).toArray()).map((x) => x._id) : []);

    await Promise.allSettled(subs.map(async (sub) => {
      const lead = clampInt(sub.settings && sub.settings.leadMinutes, 1, 15, 2) * 60000;
      for (const l of starting) {
        if (l.start.getTime() - lead > now) continue;
        if (!(await claim(`s|${sub._id}|${l._id}`))) continue;
        await sendPush(sub, startPayload(l, names, now));
      }
      if (sub.settings && sub.settings.askHomework === false) return;
      for (const l of ended) {
        if (noHwIds.has(l._id)) continue; // адмін уже відмітив «нічого не задали»
        if (!(await claim(`e|${sub._id}|${l._id}`))) continue;
        await sendPush(sub, endPayload(l, names));
      }
    }));
  } catch (e) {
    console.error('scheduler error:', e);
  } finally {
    ticking = false;
  }
}

async function notifyApproved(hw) {
  try {
    const subs = await pushSubs.find({ 'settings.notificationsEnabled': true }).toArray();
    const names = await subjectNames();
    const payload = {
      title: `Нове домашнє: ${names[hw.subjectKey] || hw.subjectKey}`,
      body: `${hw.text.slice(0, 160)} (до ${fmtDay(hw.due)})`,
      tag: 'hw-' + hw._id,
      data: { url: '/?tab=homework' },
      ttl: 3600,
    };
    await Promise.allSettled(
      subs
        .filter((s) => s.userId !== hw.authorID && s.settings && s.settings.notifyHomework !== false)
        .map((s) => sendPush(s, payload))
    );
  } catch (e) {
    console.error('notifyApproved:', e);
  }
}

async function notifyPending(hw) {
  try {
    const admins = await users.find({ $or: [{ isAdmin: true }, { role: { $in: Object.keys(ROLES) } }] }).toArray();
    if (!admins.length) return;
    const ids = new Set(admins.map((a) => a._id));
    const subs = (await pushSubs.find({ 'settings.notificationsEnabled': true }).toArray()).filter((s) => ids.has(s.userId));
    const names = await subjectNames();
    const payload = {
      title: 'Домашнє на підтвердження',
      body: `${hw.authorName}: ${names[hw.subjectKey] || hw.subjectKey} — ${hw.text.slice(0, 140)}`,
      tag: 'hw-pending-' + hw._id,
      data: { url: '/?tab=moderation' },
      ttl: 3600,
    };
    await Promise.allSettled(subs.map((s) => sendPush(s, payload)));
  } catch (e) {
    console.error('notifyPending:', e);
  }
}

/** Людині, якій адміністратор змінив роль: сповіщення на всі її пристрої (незалежно від налаштувань нагадувань). */
async function notifyRole(target, role) {
  try {
    const subs = await pushSubs.find({ userId: target._id }).toArray();
    if (!subs.length) return 0;
    const payload = role
      ? {
        title: 'Вас призначено на роль',
        body: `Ви успішно призначені: ${ROLES[role]}. Тепер вам доступні розклад, підтвердження домашнього, предмети й викладачі.`,
        tag: 'role-' + target._id,
        data: { url: '/?tab=settings' },
        ttl: 86400,
      }
      : {
        title: 'Роль змінено',
        body: 'Ваша роль у щоденнику знята — ви знову студент.',
        tag: 'role-' + target._id,
        data: { url: '/?tab=settings' },
        ttl: 86400,
      };
    const results = await Promise.all(subs.map((s) => sendPush(s, payload)));
    return results.filter((r) => r.ok).length;
  } catch (e) {
    console.error('notifyRole:', e);
    return 0;
  }
}

async function notifyDeviceRequest(user, label) {
  try {
    const admins = await users.find({ isAdmin: true }).toArray();
    const ids = new Set(admins.map((a) => a._id));
    const subs = (await pushSubs.find({}).toArray()).filter((s) => ids.has(s.userId));
    const payload = {
      title: 'Запит на новий пристрій',
      body: `${user.fullName} хоче увійти з нового пристрою${label ? ' (' + label + ')' : ''}`,
      tag: 'device-' + user._id,
      data: { url: '/?tab=users' },
      ttl: 3600,
    };
    await Promise.allSettled(subs.map((s) => sendPush(s, payload)));
  } catch (e) {
    console.error('notifyDeviceRequest:', e);
  }
}


// ───────────────────────── Оцінки ─────────────────────────
// Колекція `grades` лише читається. Раз на добу (о GRADES_HOUR за APP_TZ, типово 20:00 за Києвом)
// сервер порівнює її з уже баченими оцінками й сповіщає адміністратора про нові.

const GRADES_HOUR = clampInt(process.env.GRADES_HOUR, 0, 23, 20);
const pickField = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };
const VALUE_KEYS = ['grade', 'value', 'mark', 'score', 'points', 'rating'];
const DATE_KEYS = ['date', 'day', 'start', 'at', 'time'];
const TYPE_KEYS = ['kind', 'type'];

function parseGradeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(v);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12));
    const k = /^(\d{4})(\d{2})(\d{2})-\d+/.exec(v.trim()); // id пари виду 20261012-3
    if (k) return new Date(Date.UTC(+k[1], +k[2] - 1, +k[3], 12));
  }
  return toDate(v);
}
const gradeText = (v) => (v && typeof v === 'object' ? str(v.fullName || v.name || v.title || v.label || '', 200) : str(v, 200));
const listText = (arr, single) => (Array.isArray(arr) ? arr : [single]).map(gradeText).filter(Boolean).join(', ');

/**
 * Один документ колекції grades = один предмет за період:
 *   { period, subject, grades: [3, 4, 4, 4], lessons: [...], teachers: [...], kinds: [...], ... }
 * Масиви grades і lessons паралельні: lessons[i] — пара, за яку виставлено grades[i].
 * Повертає окремі оцінки; id оцінки = документ + пара + значення (нова пара або змінене значення = нова оцінка).
 */
function gradeEntries(doc, names) {
  const subjRaw = str(pickField(doc, ['subject', 'subjectKey', 'name', 'discipline']), 200);
  const subject = (names && names[subjRaw]) || subjRaw;
  const teacher = listText(doc.teachers, doc.teacher);
  const kinds = listText(doc.kinds, doc.kind);
  const arr = Array.isArray(doc.grades) ? doc.grades : [];
  const ls = Array.isArray(doc.lessons) && doc.lessons.length === arr.length ? doc.lessons : [];
  return arr.map((g, i) => {
    const obj = g && typeof g === 'object' ? g : null;
    const l = ls.length ? ls[i] : null;
    const lObj = l && typeof l === 'object' ? l : null;
    const value = str(obj ? pickField(obj, VALUE_KEYS) : g, 40);
    const date = parseGradeDate(pickField(obj, DATE_KEYS)) || parseGradeDate(lObj ? pickField(lObj, DATE_KEYS) : l);
    const type = gradeText(pickField(obj, TYPE_KEYS)) || gradeText(pickField(lObj, TYPE_KEYS)) || kinds;
    const lessonKey = l == null ? String(i) : typeof l === 'object' ? JSON.stringify(l) : String(l);
    return {
      id: `${doc._id}|${sha(lessonKey)}|${value}`,
      subject, period: str(doc.period, 60), value, date, type, teacher,
    };
  });
}
const allGradeEntries = (docs, names) => docs.flatMap((d) => gradeEntries(d, names));

async function adminPushSubs() {
  const ids = new Set((await users.find({ isAdmin: true }).toArray()).map((a) => a._id));
  return (await pushSubs.find({ 'settings.notificationsEnabled': true }).toArray()).filter((s) => ids.has(s.userId));
}

async function notifyNewGrades(list) {
  const subs = await adminPushSubs();
  if (!subs.length || !list.length) return 0;
  let payloads;
  if (list.length <= 3) {
    payloads = list.map((g) => ({
      title: `Нова оцінка: ${g.subject || 'предмет не вказано'}`,
      body: `Оцінка: ${g.value || '—'}${g.type ? ' · ' + g.type : ''}${g.date ? ' · ' + fmtDay(g.date) : ''}`,
      tag: 'grade-' + g.id,
      data: { url: '/?tab=grades' },
      ttl: 86400,
    }));
  } else {
    const lines = list.map((g) => `${g.subject || '—'}: ${g.value || '—'}`).join('; ');
    payloads = [{
      title: `Нових оцінок: ${list.length}`,
      body: lines.length > 220 ? lines.slice(0, 217) + '…' : lines,
      tag: 'grades-' + Date.now(),
      data: { url: '/?tab=grades' },
      ttl: 86400,
    }];
  }
  let delivered = 0;
  for (const p of payloads) {
    const res = await Promise.all(subs.map((s) => sendPush(s, p)));
    delivered += res.filter((r) => r.ok).length;
  }
  return delivered;
}

/** Порівнює `grades` з уже баченими. notify=false — лише запам'ятати (перший запуск). */
async function checkGrades({ notify = true } = {}) {
  const names = await subjectNames();
  const all = allGradeEntries(await grades.find({}).toArray(), names);
  const seen = new Set((await gradesSeen.find({}, { projection: { _id: 1 } }).toArray()).map((x) => x._id));
  const fresh = all.filter((g) => !seen.has(g.id));
  if (fresh.length) {
    await gradesSeen.insertMany(fresh.map((g) => ({ _id: g.id, at: new Date() })), { ordered: false }).catch((e) => {
      if (!(e && (e.code === 11000 || (e.writeErrors || []).every((w) => w.code === 11000)))) throw e;
    });
  }
  await config.updateOne({ _id: 'gradesLastCheck' }, { $set: { value: new Date() } }, { upsert: true });
  let notified = 0;
  if (notify && fresh.length) notified = await notifyNewGrades(fresh);
  return { fresh: fresh.length, notified, total: all.length };
}

/** Перший запуск: поточні оцінки вважаємо «баченими», щоб не засипати сповіщеннями. */
async function ensureGradesBaseline() {
  if (await config.findOne({ _id: 'gradesBaseline' })) return;
  await checkGrades({ notify: false });
  await config.updateOne({ _id: 'gradesBaseline' }, { $set: { value: new Date() } }, { upsert: true });
}

function kyivNow() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

let gradesBusy = false;
async function gradesTick() {
  if (gradesBusy) return;
  const { date, hour } = kyivNow();
  if (hour < GRADES_HOUR) return;
  gradesBusy = true;
  const key = `grades|${date}`;
  try {
    if (!(await claim(key))) return; // сьогодні вже перевіряли (навіть після перезапуску сервера)
    try {
      const r = await checkGrades();
      console.log(`Оцінки: нових ${r.fresh}, сповіщень доставлено ${r.notified}`);
    } catch (e) {
      await sent.deleteOne({ _id: key }).catch(() => {}); // спробуємо ще раз на наступному тіку
      throw e;
    }
  } catch (e) {
    console.error('gradesTick:', e);
  } finally {
    gradesBusy = false;
  }
}

// ───────────────────────── Пристрої ─────────────────────────

const devKey = (deviceId) => sha('dev|' + deviceId);

function devLabel(body, req) {
  const given = str(body.deviceLabel, 80);
  if (given) return given;
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Пристрій';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

/** Старі записи могли не мати deviceIds / deviceMeta — приводимо до єдиного вигляду. */
function normDevices(user) {
  if (!Array.isArray(user.deviceIds)) user.deviceIds = user.deviceId ? [String(user.deviceId)] : [];
  if (!user.deviceMeta || typeof user.deviceMeta !== 'object') user.deviceMeta = {};
  if (!Array.isArray(user.pendingDevices)) user.pendingDevices = [];
  return user;
}

async function addDevice(user, deviceId, label) {
  normDevices(user);
  if (!user.deviceIds.includes(deviceId)) user.deviceIds.push(deviceId);
  user.deviceMeta[devKey(deviceId)] = { label, addedAt: new Date() };
  user.pendingDevices = user.pendingDevices.filter((p) => p.deviceId !== deviceId);
  await users.updateOne({ _id: user._id }, {
    $set: { deviceIds: user.deviceIds, deviceMeta: user.deviceMeta, pendingDevices: user.pendingDevices },
  });
}

// ───────────────────────── Маршрути ─────────────────────────

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin, mod: !!opts.mod });
}

const ok = () => ({});

let VAPID_PUBLIC = '';

// — вхід
route('POST', '/api/auth/login', async ({ body, ip, req }) => {
  rateLimit(ip);
  const fullName = normName(body.fullName);
  const deviceId = str(body.deviceId, 100);
  if (fullName.length > 100 || fullName.split(' ').length < 2) {
    throw new HttpError(400, 'Введіть прізвище, ім’я та по батькові.');
  }
  if (!deviceId) throw new HttpError(400, 'Не вказано ідентифікатор пристрою.');
  const nameKey = normKey(fullName);
  const adminByName = ADMIN_NAMES.has(nameKey);

  const label = devLabel(body, req);
  let user = await users.findOne({ nameKey });
  if (!user) {
    const isAdmin = adminByName || (ADMIN_NAMES.size === 0 && (await users.countDocuments({})) === 0);
    user = {
      _id: crypto.randomUUID(), fullName, nameKey, isAdmin, deviceIds: [deviceId],
      deviceMeta: { [devKey(deviceId)]: { label, addedAt: new Date() } }, pendingDevices: [], createdAt: new Date(),
    };
    try {
      await users.insertOne(user);
    } catch (e) {
      if (e && e.code === 11000) throw new HttpError(409, 'Цей ПІБ щойно зареєстровано. Спробуйте ще раз.');
      throw e;
    }
  } else {
    if (adminByName && !user.isAdmin) {
      user.isAdmin = true;
      await users.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
    }
    normDevices(user);
    if (!user.deviceIds.includes(deviceId)) {
      if (user.deviceIds.length === 0) {
        // Адміністратор відв'язав усі пристрої — перший, хто увійде, стає новим.
        await addDevice(user, deviceId, label);
      } else if (user.isAdmin && ADMIN_PASSWORD && body.password) {
        // Адміністратор може додати пристрій сам — паролем.
        if (!safeEq(String(body.password), ADMIN_PASSWORD)) throw new HttpError(403, 'Невірний пароль.', { code: 'password_required' });
        await addDevice(user, deviceId, label);
      } else if (user.isAdmin && ADMIN_PASSWORD && !body.password && !user.pendingDevices.some((p) => p.deviceId === deviceId)) {
        throw new HttpError(403, 'Для входу адміністратора з нового пристрою введіть пароль.', { code: 'password_required' });
      } else {
        // Новий пристрій людини, яка вже має інші: не відмовляємо, а надсилаємо запит адміністратору.
        const already = user.pendingDevices.some((p) => p.deviceId === deviceId);
        if (!already) {
          if (user.deviceIds.length >= MAX_DEVICES) {
            throw new HttpError(403, `До акаунта вже прив’язано максимум пристроїв (${MAX_DEVICES}). Попросіть адміністратора відв’язати непотрібний.`, { code: 'device_limit' });
          }
          const entry = { key: devKey(deviceId), deviceId, label, requestedAt: new Date() };
          user.pendingDevices = [...user.pendingDevices.slice(-4), entry];
          await users.updateOne({ _id: user._id }, { $set: { pendingDevices: user.pendingDevices } });
          notifyDeviceRequest(user, label);
        }
        throw new HttpError(403, 'Запит на додавання пристрою надіслано адміністратору. Щойно він підтвердить — вхід відбудеться автоматично.', { code: 'device_pending' });
      }
    }
  }
  return { token: signToken(user._id), user: pubUser(user) };
}, { auth: false });

// — стан запиту на новий пристрій (клієнт опитує його, поки адміністратор не підтвердить)
route('POST', '/api/auth/device-status', async ({ body, ip }) => {
  rateLimit('ds|' + ip, 400);
  const deviceId = str(body.deviceId, 100);
  const user = await users.findOne({ nameKey: normKey(body.fullName) });
  if (!user || !deviceId) return { status: 'none' };
  normDevices(user);
  if (user.deviceIds.includes(deviceId)) return { status: 'approved' };
  if (user.pendingDevices.some((p) => p.deviceId === deviceId)) return { status: 'pending' };
  return { status: 'none' };
}, { auth: false });

// — синхронізація
route('GET', '/api/sync', async ({ user }) => {
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const [ls, subs, tchs, hws, title, reqUsers, noHws, myAnswers] = await Promise.all([
    lessons.find({}).sort({ start: 1 }).toArray(),
    subjects.find({}).toArray(),
    teachers.find({}).toArray(),
    homework.find({ due: { $gte: since } }).sort({ due: 1 }).toArray(),
    config.findOne({ _id: 'scheduleTitle' }),
    user.isAdmin ? users.find({ 'pendingDevices.0': { $exists: true } }).toArray() : [],
    noHw.find({}).toArray(),
    answers.find({ userId: user._id }).toArray(),
  ]);
  const subjectMap = {};
  for (const s of subs) subjectMap[s._id] = { fullName: s.fullName || '', link: s.link || '' };
  const teacherMap = {};
  for (const t of tchs) teacherMap[t._id] = t.fullName || '';
  const visible = hws.filter((h) => isMod(user) || h.status === 'approved' || h.authorID === user._id);
  return {
    user: pubUser(user),
    scheduleTitle: (title && title.value) || '',
    noHomework: noHws.map((x) => x._id),
    answered: myAnswers.map((x) => x.lessonId),
    deviceRequests: reqUsers.reduce((n, u) => n + u.pendingDevices.length, 0),
    lessons: ls.map(pubLesson),
    subjects: subjectMap,
    teachers: teacherMap,
    homework: visible.map(pubHw),
  };
});

// — розклад (адмін)
route('PUT', '/api/schedule', async ({ body }) => {
  if (!Array.isArray(body.lessons)) throw new HttpError(400, 'Некоректний розклад.');
  if (body.lessons.length > 5000) throw new HttpError(400, 'Забагато пар у файлі.');
  const byId = new Map();
  for (const raw of body.lessons) {
    const start = toDate(raw && raw.start);
    const end = toDate(raw && raw.end);
    const id = str(raw && raw.id, 40);
    const subjectKey = str(raw && raw.subjectKey, 100);
    if (!id || !start || !end || end <= start || !subjectKey) continue;
    byId.set(id, {
      _id: id, pair: clampInt(raw.pair, 0, 30, 0), start, end, subjectKey,
      kind: str(raw.kind, 20), topic: str(raw.topic, 80), room: str(raw.room, 60),
      teacher: str(raw.teacher, 200), isRemote: !!raw.isRemote,
    });
  }
  const docs = [...byId.values()];
  if (!docs.length) throw new HttpError(400, 'У розкладі немає жодної пари.');
  const minStart = new Date(Math.min(...docs.map((d) => d.start.getTime())));
  // Новий файл замінює пари від його першої дати; домашнє й посилання лишаються.
  await lessons.deleteMany({ start: { $gte: minStart } });
  await lessons.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  await lessons.insertMany(docs);
  await config.updateOne({ _id: 'scheduleTitle' }, { $set: { value: str(body.title, 300) } }, { upsert: true });
  return ok();
}, { mod: true });

// — відповідь на «Що задали?» (запам'ятовується за користувачем, а не за пристроєм)
async function saveAnswers(user, ids) {
  for (const id of ids) {
    await answers.updateOne({ _id: `${user._id}|${id}` }, { $set: { userId: user._id, lessonId: id, at: new Date() } }, { upsert: true });
  }
}
route('POST', '/api/lessons/:id/answered', async ({ params, user }) => {
  await saveAnswers(user, [str(params.id, 40)]);
  return ok();
});
route('POST', '/api/answered', async ({ body, user }) => {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 300);
  await saveAnswers(user, ids);
  return ok();
});

// — «нічого не задали» (адмін): плашка «Що задали?» зникає в усіх
route('POST', '/api/lessons/:id/no-homework', async ({ params }) => {
  const l = await lessons.findOne({ _id: params.id });
  if (!l) throw new HttpError(404, 'Пару не знайдено.');
  await noHw.updateOne({ _id: l._id }, { $set: { at: new Date() } }, { upsert: true });
  return ok();
}, { mod: true });

// — предмети й викладачі (адмін, староста, заступник)
route('PUT', '/api/subjects', async ({ body }) => {
  const key = str(body.key, 100);
  if (!key) throw new HttpError(400, 'Не вказано предмет.');
  await subjects.updateOne({ _id: key }, { $set: { fullName: str(body.fullName, 200), link: cleanLink(body.link) } }, { upsert: true });
  return ok();
}, { mod: true });

route('PUT', '/api/teachers', async ({ body }) => {
  const key = str(body.key, 200);
  if (!key) throw new HttpError(400, 'Не вказано викладача.');
  await teachers.updateOne({ _id: key }, { $set: { fullName: str(body.fullName, 200) } }, { upsert: true });
  return ok();
}, { mod: true });

// — домашнє
const MAX_LINKS = 5;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

function imageKind(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readHomeworkBody(body, user, hwId) {
  const subjectKey = str(body.subjectKey, 100);
  const text = str(body.text, 2000);
  const due = toDate(body.due);
  if (!subjectKey) throw new HttpError(400, 'Оберіть предмет.');
  if (!text) throw new HttpError(400, 'Опишіть, що задали.');
  if (!due) throw new HttpError(400, 'Некоректна дата.');

  const links = [];
  for (const raw of Array.isArray(body.links) ? body.links : []) {
    const l = cleanLink(raw);
    if (l && !links.includes(l)) links.push(l);
  }
  if (links.length > MAX_LINKS) throw new HttpError(400, `Не більше ${MAX_LINKS} посилань.`);

  const imageIds = [...new Set((Array.isArray(body.images) ? body.images : []).map((x) => str(x, 60)).filter(Boolean))];
  if (imageIds.length > MAX_IMAGES) throw new HttpError(400, `Не більше ${MAX_IMAGES} зображень.`);
  if (imageIds.length) {
    const found = await hwImages.find({ _id: { $in: imageIds } }, { projection: { authorID: 1, hwId: 1 } }).toArray();
    const known = new Map(found.map((i) => [i._id, i]));
    for (const id of imageIds) {
      const i = known.get(id);
      if (!i || !(i.authorID === user._id || i.hwId === hwId)) throw new HttpError(400, 'Зображення не знайдено — завантажте його ще раз.');
    }
  }
  return { subjectKey, text, due, lessonID: body.lessonID ? str(body.lessonID, 40) : null, links, images: imageIds };
}

// Зображення: клієнт стискає їх і надсилає base64; зберігаємо в MongoDB, віддаємо лише авторизованим.
route('POST', '/api/images', async ({ body, user }) => {
  const b64 = String(body.data || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(400, 'Порожнє зображення.');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Зображення завелике (максимум 1,5 МБ).');
  const mime = imageKind(buf);
  if (!mime) throw new HttpError(400, 'Підтримуються лише JPEG, PNG і WebP.');
  const pending = await hwImages.countDocuments({ authorID: user._id, hwId: null });
  if (pending >= 30) throw new HttpError(429, 'Забагато незбережених зображень. Збережіть домашнє й спробуйте ще раз.');
  const id = crypto.randomUUID();
  await hwImages.insertOne({ _id: id, data: buf, mime, authorID: user._id, hwId: null, created: new Date() });
  return { id };
});

route('GET', '/api/images/:id', async ({ params }) => {
  const img = await hwImages.findOne({ _id: params.id });
  if (!img) throw new HttpError(404, 'Зображення не знайдено.');
  const d = img.data;
  const buf = Buffer.isBuffer(d) ? d : Buffer.from(d.buffer.subarray(0, d.position));
  return { __raw: { mime: img.mime, buf } };
});

async function attachImages(hwId, ids, previous) {
  const removed = (previous || []).filter((x) => !ids.includes(x));
  if (removed.length) await hwImages.deleteMany({ _id: { $in: removed }, hwId });
  if (ids.length) await hwImages.updateMany({ _id: { $in: ids } }, { $set: { hwId } });
}

// Незбережені (осиротілі) зображення старші за добу прибираємо.
async function cleanOrphanImages() {
  try { await hwImages.deleteMany({ hwId: null, created: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }); }
  catch (e) { console.error('cleanOrphanImages:', e); }
}

route('POST', '/api/homework', async ({ body, user }) => {
  const id = crypto.randomUUID();
  const data = await readHomeworkBody(body, user, id);
  const hw = {
    _id: id, ...data, created: new Date(),
    status: isMod(user) ? 'approved' : 'pending', authorID: user._id, authorName: user.fullName,
  };
  await homework.insertOne(hw);
  await attachImages(id, data.images, []);
  (isMod(user) ? notifyApproved : notifyPending)(hw);
  return ok();
});

async function loadEditable(id, user) {
  const hw = await homework.findOne({ _id: id });
  if (!hw) throw new HttpError(404, 'Завдання не знайдено.');
  if (!(isMod(user) || (hw.authorID === user._id && hw.status !== 'approved'))) {
    throw new HttpError(403, 'Це завдання вже підтверджене — змінити його може лише адміністратор, староста чи заступник.');
  }
  return hw;
}

route('PATCH', '/api/homework/:id', async ({ params, body, user }) => {
  const hw = await loadEditable(params.id, user);
  const data = await readHomeworkBody(body, user, hw._id);
  const set = { subjectKey: data.subjectKey, text: data.text, due: data.due, links: data.links, images: data.images };
  if (data.lessonID) set.lessonID = data.lessonID;
  if (!isMod(user) && hw.status === 'rejected') set.status = 'pending';
  await homework.updateOne({ _id: hw._id }, { $set: set });
  await attachImages(hw._id, data.images, hw.images);
  if (set.status === 'pending') notifyPending({ ...hw, ...set });
  return ok();
});

route('POST', '/api/homework/:id/approve', async ({ params }) => {
  const hw = await homework.findOne({ _id: params.id });
  if (!hw) throw new HttpError(404, 'Завдання не знайдено.');
  await homework.updateOne({ _id: hw._id }, { $set: { status: 'approved' } });
  if (hw.status !== 'approved') notifyApproved(hw);
  return ok();
}, { mod: true });

route('POST', '/api/homework/:id/reject', async ({ params }) => {
  const res = await homework.updateOne({ _id: params.id }, { $set: { status: 'rejected' } });
  if (!res.matchedCount) throw new HttpError(404, 'Завдання не знайдено.');
  return ok();
}, { mod: true });

route('DELETE', '/api/homework/:id', async ({ params, user }) => {
  const hw = await loadEditable(params.id, user);
  await homework.deleteOne({ _id: hw._id });
  await hwImages.deleteMany({ hwId: hw._id });
  return ok();
});

// — сповіщення
route('GET', '/api/push/config', async () => ({ publicKey: VAPID_PUBLIC }), { auth: false });

route('POST', '/api/push/subscribe', async ({ body, user, req }) => {
  const s = body.subscription || {};
  const keys = s.keys || {};
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 2000 ||
      typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new HttpError(400, 'Некоректна підписка на сповіщення.');
  }
  await pushSubs.updateOne(
    { _id: sha(s.endpoint) },
    {
      $set: {
        userId: user._id,
        subscription: { endpoint: s.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
        settings: cleanSettings(body.settings),
        // З яким ключем створено підписку — щоб відрізняти застарілі після зміни VAPID-ключів.
        vapidKey: body.key && sha(String(body.key)) === VAPID_KEY_ID ? VAPID_KEY_ID : '',
        userAgent: str(req.headers['user-agent'], 200),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  return ok();
});

route('PUT', '/api/push/settings', async ({ body, user }) => {
  const id = sha(str(body.endpoint, 2000));
  const res = await pushSubs.updateOne({ _id: id, userId: user._id }, { $set: { settings: cleanSettings(body.settings), updatedAt: new Date() } });
  if (!res.matchedCount) throw new HttpError(404, 'Підписку не знайдено. Увімкніть сповіщення знову.');
  return ok();
});

route('POST', '/api/push/unsubscribe', async ({ body, user }) => {
  await pushSubs.deleteOne({ _id: sha(str(body.endpoint, 2000)), userId: user._id });
  return ok();
});

route('POST', '/api/push/test', async ({ body, user }) => {
  const sub = await pushSubs.findOne({ _id: sha(str(body.endpoint, 2000)), userId: user._id });
  if (!sub) throw new HttpError(404, 'Підписку не знайдено. Увімкніть сповіщення знову.');
  const names = await subjectNames();
  const now = Date.now();
  const next = await lessons.find({ end: { $gt: new Date(now) } }).sort({ start: 1 }).limit(1).toArray();
  const payload = next.length
    ? { ...startPayload(next[0], names, Math.max(now, next[0].start.getTime() - 120000)), tag: 'test' }
    : { title: 'Тестове сповіщення', body: 'Сповіщення працюють.', tag: 'test', data: { url: '/' } };
  const r = await sendPush(sub, payload);
  if (!r.ok) {
    throw new HttpError(502, `Push-сервіс відхилив сповіщення (${r.status || 'немає відповіді'}).`, { code: 'push_rejected', status: r.status });
  }
  return ok();
});

// — учасники (адмін)
route('GET', '/api/admin/users', async () => {
  const list = await users.find({}).sort({ fullName: 1 }).toArray();
  const subs = await pushSubs.find({}).toArray();
  const pushCount = {};
  for (const sb of subs) pushCount[sb.userId] = (pushCount[sb.userId] || 0) + 1;
  return list.map((u) => {
    normDevices(u);
    return {
      id: u._id, fullName: u.fullName, isAdmin: !!u.isAdmin, role: ROLES[u.role] ? u.role : '', group: u.group || '',
      devices: u.deviceIds.length, pushDevices: pushCount[u._id] || 0, createdAt: u.createdAt,
      deviceList: u.deviceIds.map((id, i) => {
        const m = u.deviceMeta[devKey(id)] || {};
        return { key: devKey(id), label: m.label || `Пристрій ${i + 1}`, addedAt: m.addedAt || null };
      }),
      pending: u.pendingDevices.map((p) => ({ key: p.key || devKey(p.deviceId), label: p.label || 'Пристрій', requestedAt: p.requestedAt })),
    };
  });
}, { admin: true });

// Ручне сповіщення від адміністратора: одному користувачеві або всім (userId: "all").
// Надсилається незалежно від налаштувань нагадувань — потрібна лише підписка на сповіщення.
route('POST', '/api/admin/notify', async ({ body }) => {
  const title = str(body.title, 60) || 'Повідомлення від адміністратора';
  const text = str(body.body, 300);
  if (!text) throw new HttpError(400, 'Введіть текст сповіщення.');
  const toAll = !body.userId || body.userId === 'all';
  let subs = await pushSubs.find({}).toArray();
  if (!toAll) {
    const target = await users.findOne({ _id: str(body.userId, 64) });
    if (!target) throw new HttpError(404, 'Користувача не знайдено.');
    subs = subs.filter((x) => x.userId === target._id);
    if (!subs.length) throw new HttpError(404, 'У цього користувача не ввімкнені сповіщення на жодному пристрої.');
  } else if (!subs.length) {
    throw new HttpError(404, 'Ні в кого ще не ввімкнені сповіщення.');
  }
  const payload = { title, body: text, tag: 'admin-' + Date.now(), data: { url: '/' }, ttl: 3600 };
  const results = await Promise.all(subs.map((x) => sendPush(x, payload)));
  const sent = results.filter((r) => r.ok).length;
  if (!sent) throw new HttpError(502, 'Не вдалося доставити сповіщення: підписки застарілі. Користувачам треба ввімкнути їх знову.');
  return { sent, total: subs.length };
}, { admin: true });

// ───────────────────────── Рейтинг ─────────────────────────
// Ключ для зіставлення студента з обліковим записом: без дужок на кшталт «(староста)», єдиний апостроф.
const ratingKey = (n) => normKey(String(n || '').replace(/\([^)]*\)/g, ' ').replace(/[`'ʼ‘’]/g, '’'));
const cleanGroup = (v) => str(normName(v), 40);

function cleanPoints(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, 'Бали — число від 0 до 100000.');
  return Math.round(n * 100) / 100;
}

function cleanSubjects(o) {
  const out = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o).slice(0, 20)) {
      const key = str(k, 20).replace(/[.$]/g, '');
      const val = key ? cleanPoints(v) : null;
      if (val !== null) out[key] = val;
    }
  }
  return out;
}

// Місця: за спаданням балів; однакові бали — однакове місце (1, 2, 2, 4). Без балів — без місця, внизу.
function rankEntries(list) {
  const sorted = [...list].sort((a, b) => (b.points == null ? -1 : b.points) - (a.points == null ? -1 : a.points) || a.fullName.localeCompare(b.fullName, 'uk'));
  let prev = null;
  let rank = 0;
  return sorted.map((e, i) => {
    if (e.points == null) return { ...e, rank: null };
    if (e.points !== prev) { rank = i + 1; prev = e.points; }
    return { ...e, rank };
  });
}

// Група студента: призначена адміністратором, інакше — з рейтингової таблиці за ПІБ.
async function groupOf(user) {
  if (user.group) return user.group;
  const e = await ratings.findOne({ nameKey: ratingKey(user.fullName) });
  return e ? e.group : '';
}

async function listGroups() {
  const [named, rAgg, uAgg] = await Promise.all([
    groupsCol.find({}).toArray(),
    ratings.aggregate([{ $group: { _id: '$group', n: { $sum: 1 } } }]).toArray(),
    users.aggregate([{ $match: { group: { $type: 'string', $ne: '' } } }, { $group: { _id: '$group', n: { $sum: 1 } } }]).toArray(),
  ]);
  const map = new Map();
  const get = (name) => { if (!map.has(name)) map.set(name, { name, students: 0, accounts: 0 }); return map.get(name); };
  named.forEach((g) => get(g._id));
  rAgg.forEach((g) => { get(g._id).students = g.n; });
  uAgg.forEach((g) => { get(g._id).accounts = g.n; });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

const ensureGroup = (name) => groupsCol.updateOne({ _id: name }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });

// Одноразовий безпечний імпорт першої таблиці (seed/rating-101-spd.json). Не перезаписує вже наявні записи.
async function seedRating() {
  const KEY = 'ratingSeed101spd';
  if (await config.findOne({ _id: KEY })) return;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'rating-101-spd.json'), 'utf8')); } catch (e) { return; }
  const now = new Date();
  let added = 0;
  for (const e of seed.entries || []) {
    try {
      await ratings.insertOne({
        _id: crypto.randomUUID(), group: seed.group, fullName: e.fullName, nameKey: ratingKey(e.fullName),
        points: e.points == null ? null : e.points, subjects: e.subjects || {}, note: e.note || '', createdAt: now, updatedAt: now, source: seed.source,
      });
      added++;
    } catch (err) { if (!err || err.code !== 11000) throw err; }
  }
  await ensureGroup(seed.group);
  await config.updateOne({ _id: KEY }, { $set: { value: { at: now, added } } }, { upsert: true });
  console.log(`Рейтинг: імпортовано ${added} студентів групи «${seed.group}».`);
}

function readRatingBody(body, full) {
  const set = {};
  if (full || 'fullName' in body) {
    const n = normName(body.fullName);
    if (n.split(' ').length < 2 || n.length > 100) throw new HttpError(400, 'Введіть прізвище та ім’я (ПІБ).');
    set.fullName = n;
    set.nameKey = ratingKey(n);
  }
  if (full || 'group' in body) {
    const g = cleanGroup(body.group);
    if (!g) throw new HttpError(400, 'Оберіть групу.');
    set.group = g;
  }
  if (full || 'points' in body) set.points = cleanPoints(body.points);
  if ('subjects' in body) set.subjects = cleanSubjects(body.subjects);
  if ('note' in body) set.note = str(body.note, 60);
  set.updatedAt = new Date();
  return set;
}

const dupRating = (e) => { if (e && e.code === 11000) throw new HttpError(409, 'Цей студент уже є в рейтингу цієї групи.'); throw e; };

// Студент отримує ЛИШЕ свою групу (параметр group ігнорується). Адміністратор може дивитись будь-яку.
// Розбивку за предметами бачить лише сам студент (у своєму рядку) та адміністратор.
route('GET', '/api/rating', async ({ user, query }) => {
  const own = await groupOf(user);
  let group = own;
  let groups = null;
  if (user.isAdmin) {
    groups = await listGroups();
    group = cleanGroup(query.get('group')) || own || (groups[0] ? groups[0].name : '');
  }
  if (!group) return { group: '', own: '', groups, entries: [], me: null };
  const meKey = ratingKey(user.fullName);
  const ranked = rankEntries(await ratings.find({ group }).toArray());
  const entries = ranked.map((e) => {
    const isMe = e.nameKey === meKey;
    return {
      ...(user.isAdmin ? { id: e._id } : {}),
      rank: e.rank, fullName: e.fullName, points: e.points, note: e.note || '', isMe,
      ...(isMe || user.isAdmin ? { subjects: e.subjects || {} } : {}),
    };
  });
  const me = entries.find((e) => e.isMe) || null;
  return { group, own, groups, entries, total: entries.length, me: me && { rank: me.rank, points: me.points } };
});

route('GET', '/api/admin/groups', async () => listGroups(), { admin: true });

route('POST', '/api/admin/groups', async ({ body }) => {
  const name = cleanGroup(body.name);
  if (!name) throw new HttpError(400, 'Введіть назву групи.');
  await ensureGroup(name);
  return { name };
}, { admin: true });

route('PATCH', '/api/admin/groups', async ({ body }) => {
  const from = cleanGroup(body.from);
  const to = cleanGroup(body.to);
  if (!from || !to) throw new HttpError(400, 'Вкажіть стару й нову назву групи.');
  if (from === to) return ok();
  try {
    await ratings.updateMany({ group: from }, { $set: { group: to } });
  } catch (e) { dupRating(e); }
  await users.updateMany({ group: from }, { $set: { group: to } });
  await groupsCol.deleteOne({ _id: from });
  await ensureGroup(to);
  return ok();
}, { admin: true });

route('DELETE', '/api/admin/groups/:name', async ({ params }) => {
  const name = cleanGroup(params.name);
  if ((await ratings.countDocuments({ group: name })) || (await users.countDocuments({ group: name }))) {
    throw new HttpError(409, 'Група не порожня: спершу видаліть її студентів із рейтингу й зніміть групу в учасників.');
  }
  await groupsCol.deleteOne({ _id: name });
  return ok();
}, { admin: true });

route('POST', '/api/admin/rating', async ({ body }) => {
  const doc = { _id: crypto.randomUUID(), createdAt: new Date(), subjects: {}, note: '', ...readRatingBody(body, true) };
  try { await ratings.insertOne(doc); } catch (e) { dupRating(e); }
  await ensureGroup(doc.group);
  return { id: doc._id };
}, { admin: true });

route('PATCH', '/api/admin/rating/:id', async ({ params, body }) => {
  const set = readRatingBody(body, false);
  let r;
  try { r = await ratings.updateOne({ _id: params.id }, { $set: set }); } catch (e) { dupRating(e); }
  if (!r.matchedCount) throw new HttpError(404, 'Запис не знайдено.');
  if (set.group) await ensureGroup(set.group);
  return ok();
}, { admin: true });

route('DELETE', '/api/admin/rating/:id', async ({ params }) => {
  const r = await ratings.deleteOne({ _id: params.id });
  if (!r.deletedCount) throw new HttpError(404, 'Запис не знайдено.');
  return ok();
}, { admin: true });

route('POST', '/api/admin/users/:id/group', async ({ params, body }) => {
  const g = cleanGroup(body.group);
  const r = await users.updateOne({ _id: params.id }, g ? { $set: { group: g } } : { $unset: { group: '' } });
  if (!r.matchedCount) throw new HttpError(404, 'Користувача не знайдено.');
  if (g) await ensureGroup(g);
  return ok();
}, { admin: true });

// — оцінки (адмін)
route('GET', '/api/admin/grades', async () => {
  const [docs, names, last] = await Promise.all([grades.find({}).toArray(), subjectNames(), config.findOne({ _id: 'gradesLastCheck' })]);
  const items = allGradeEntries(docs, names);
  items.sort((a, b) => (b.date ? +new Date(b.date) : 0) - (a.date ? +new Date(a.date) : 0));
  return { items, docs: docs.length, db: GRADES_DB, lastCheck: (last && last.value) || null, hour: GRADES_HOUR };
}, { admin: true });

// Позачергова перевірка (за тією ж логікою, що й о 20:00): про нові оцінки приходить сповіщення.
route('POST', '/api/admin/grades/check', async () => checkGrades(), { admin: true });

route('POST', '/api/admin/users/:id/devices/:key/approve', async ({ params }) => {
  const user = await users.findOne({ _id: params.id });
  if (!user) throw new HttpError(404, 'Користувача не знайдено.');
  normDevices(user);
  const req = user.pendingDevices.find((p) => (p.key || devKey(p.deviceId)) === params.key);
  if (!req) throw new HttpError(404, 'Запит уже оброблено.');
  if (user.deviceIds.length >= MAX_DEVICES) {
    throw new HttpError(400, `Уже прив’язано максимум пристроїв (${MAX_DEVICES}). Спершу видаліть непотрібний.`);
  }
  await addDevice(user, req.deviceId, req.label || 'Пристрій');
  return ok();
}, { admin: true });

route('POST', '/api/admin/users/:id/devices/:key/reject', async ({ params }) => {
  const user = await users.findOne({ _id: params.id });
  if (!user) throw new HttpError(404, 'Користувача не знайдено.');
  normDevices(user);
  const left = user.pendingDevices.filter((p) => (p.key || devKey(p.deviceId)) !== params.key);
  await users.updateOne({ _id: user._id }, { $set: { pendingDevices: left } });
  return ok();
}, { admin: true });

route('DELETE', '/api/admin/users/:id/devices/:key', async ({ params }) => {
  const user = await users.findOne({ _id: params.id });
  if (!user) throw new HttpError(404, 'Користувача не знайдено.');
  normDevices(user);
  const gone = user.deviceIds.find((id) => devKey(id) === params.key);
  if (!gone) throw new HttpError(404, 'Пристрій не знайдено.');
  const meta = { ...user.deviceMeta };
  delete meta[params.key];
  await users.updateOne({ _id: user._id }, { $set: { deviceIds: user.deviceIds.filter((id) => id !== gone), deviceMeta: meta } });
  return ok();
}, { admin: true });

route('POST', '/api/admin/users/:id/reset-devices', async ({ params }) => {
  const res = await users.updateOne({ _id: params.id }, { $set: { deviceIds: [], deviceMeta: {}, pendingDevices: [] } });
  if (!res.matchedCount) throw new HttpError(404, 'Користувача не знайдено.');
  return ok();
}, { admin: true });

// Призначення ролі: староста / заступник старости / без ролі (адмін).
route('POST', '/api/admin/users/:id/role', async ({ params, body }) => {
  const role = str(body.role, 20);
  if (role && !ROLES[role]) throw new HttpError(400, 'Невідома роль.');
  const target = await users.findOne({ _id: params.id });
  if (!target) throw new HttpError(404, 'Користувача не знайдено.');
  if (target.isAdmin) throw new HttpError(400, 'Адміністратору роль не потрібна.');
  const prev = ROLES[target.role] ? target.role : '';
  await users.updateOne({ _id: target._id }, role ? { $set: { role } } : { $unset: { role: '' } });
  // Сповіщаємо лише якщо роль справді змінилась.
  const notified = prev !== role ? await notifyRole(target, role) : 0;
  return { notified };
}, { admin: true });

route('DELETE', '/api/admin/users/:id', async ({ params, user }) => {
  if (params.id === user._id) throw new HttpError(400, 'Не можна видалити самого себе.');
  await users.deleteOne({ _id: params.id });
  await pushSubs.deleteMany({ userId: params.id });
  return ok();
}, { admin: true });

// ───────────────────────── HTTP ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'";

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Запит завеликий.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Некоректний JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) {
      if (routes.some((x) => x.re.test(url.pathname))) throw new HttpError(405, 'Метод не підтримується.');
      throw new HttpError(404, 'Не знайдено.');
    }
    const m = r.re.exec(url.pathname);
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    let user = null;
    if (r.auth) {
      const auth = req.headers.authorization || '';
      const data = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
      user = data && (await users.findOne({ _id: data.u }));
      if (!user) throw new HttpError(401, 'Сеанс завершено.');
      if (r.admin && !user.isAdmin) throw new HttpError(403, 'Лише для адміністратора.');
      if (r.mod && !isMod(user)) throw new HttpError(403, 'Лише для адміністратора, старости чи заступника.');
    }
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
    const result = await r.handler({ req, params, query: url.searchParams, body, user, ip });
    if (result && result.__raw) {
      res.writeHead(200, {
        'Content-Type': result.__raw.mime,
        'Content-Length': result.__raw.buf.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
        ...SECURITY,
      });
      return res.end(result.__raw.buf);
    }
    sendJson(res, 200, result === undefined ? {} : result);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
    console.error('API error:', req.method, req.url, e);
    sendJson(res, 500, { error: 'Внутрішня помилка сервера.' });
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }

  let stat = null;
  try { stat = fs.statSync(file); if (stat.isDirectory()) { file = path.join(file, 'index.html'); stat = fs.statSync(file); } } catch { stat = null; }
  if (!stat) {
    if (path.extname(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не знайдено'); }
    file = path.join(PUBLIC_DIR, 'index.html');
    try { stat = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }
  }

  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
    ETag: etag,
    ...SECURITY,
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  serveStatic(req, res, url);
});

// ───────────────────────── Запуск ─────────────────────────

(async () => {
  VAPID_PUBLIC = await initDb();
  await ensureGradesBaseline().catch((e) => console.error('ensureGradesBaseline:', e));
  server.listen(PORT, () => console.log(`Щоденник: сервер слухає порт ${PORT}`));
  setInterval(tick, TICK_MS);
  setInterval(gradesTick, 60 * 1000);
  gradesTick();
  cleanOrphanImages();
  setInterval(cleanOrphanImages, 6 * 3600 * 1000).unref();

  // Безкоштовні хостинги «присипляють» сервіс без запитів — тоді сповіщення не відправляються.
  // На Render сервіс сам себе «будить» раз на 10 хвилин (вимкнути: KEEP_ALIVE=0).
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self && process.env.KEEP_ALIVE !== '0') {
    setInterval(() => { fetch(self + '/healthz').catch(() => {}); }, 10 * 60 * 1000).unref();
  }
})().catch((e) => {
  console.error('Не вдалося запустити сервер:', e);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });