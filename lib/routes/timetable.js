'use strict';
/*
 * Розклад груп із порталу академії: каскад «Факультет → Курс → Група», перегляд розкладу
 * і перенесення його в щоденник обраної групи. Усе — лише для адміністратора.
 */

const crypto = require('crypto');
const ctx = require('../context');
const scores = require('../scores');
const { audit } = require('../audit');
const { portal } = require('../timetable');
const { listGroups } = require('./rating');
const { HttpError, str, cleanGroup, isDayKey, dayStart, addDays } = require('../util');

/** Стабільний короткий ключ групи для id пар (id мають бути унікальними між групами). */
const groupKey = (name) => crypto.createHash('sha1').update(String(name).toLowerCase()).digest('hex').slice(0, 8);

async function requireGroup(raw) {
  const name = cleanGroup(raw);
  const known = name && (await listGroups()).some((g) => g.name === name);
  if (!known) throw new HttpError(404, 'Групу не знайдено.');
  return name;
}

const flag = (query, k) => query.get(k) === '1';

/** Пара порталу → документ колекції lessons (формат той самий, що й у розкладі з файлу, плюс group). */
function toDoc(l, group) {
  return {
    _id: `${groupKey(group)}:${l.id}`,
    group,
    pair: l.pair,
    start: new Date(l.start),
    end: new Date(l.end),
    subjectKey: l.subjectKey.slice(0, 100),
    kind: (l.kind || '').slice(0, 20),
    topic: (l.topic || '').slice(0, 80),
    room: (l.room || '').slice(0, 60),
    teacher: (l.teacher || '').slice(0, 200),
    isRemote: !!l.isRemote,
    source: 'portal',
  };
}

/** Повні назви предметів і викладачів додаємо лише там, де адміністратор ще нічого не вписав. */
async function fillNames(lessons) {
  const subj = new Map();
  const teach = new Map();
  for (const l of lessons) {
    if (l.subjectFull && !subj.has(l.subjectKey)) subj.set(l.subjectKey, l.subjectFull);
    if (l.teacher && l.teacherFull && !teach.has(l.teacher)) teach.set(l.teacher, l.teacherFull);
  }
  const fill = async (col, map, maxLen) => {
    if (!map.size) return;
    const have = await col.find({ _id: { $in: [...map.keys()] } }, { projection: { fullName: 1 } }).toArray();
    const filled = new Set(have.filter((d) => d.fullName).map((d) => d._id));
    for (const [key, full] of map) {
      if (filled.has(key)) continue;
      await col.updateOne({ _id: key }, { $set: { fullName: full.slice(0, maxLen) } }, { upsert: true });
    }
  };
  await fill(ctx.col.subjects, subj, 200);
  await fill(ctx.col.teachers, teach, 200);
}

function register(route) {
  route('GET', '/api/admin/timetable/faculties', async ({ query }) => ({ items: await portal.faculties({ refresh: flag(query, 'refresh') }) }), { admin: true });

  route('GET', '/api/admin/timetable/courses', async ({ query }) => ({
    items: await portal.courses(query.get('faculty'), { refresh: flag(query, 'refresh') }),
  }), { admin: true });

  route('GET', '/api/admin/timetable/groups', async ({ query }) => ({
    items: await portal.groups(query.get('faculty'), query.get('course'), { refresh: flag(query, 'refresh') }),
  }), { admin: true });

  // Перегляд: те, що показує портал, у розібраному вигляді. Нічого не зберігає.
  route('GET', '/api/admin/timetable/schedule', async ({ query }) => portal.schedule({
    faculty: query.get('faculty'), course: query.get('course'), group: query.get('group'), from: query.get('from'), to: query.get('to'),
  }, { refresh: flag(query, 'refresh') }), { admin: true });

  // Стан групи: до якої групи порталу прив'язана, скільки пар уже в щоденнику.
  route('GET', '/api/admin/groups/:name/schedule', async ({ params }) => {
    const name = await requireGroup(params.name);
    const [doc, count, first, last] = await Promise.all([
      ctx.col.groups.findOne({ _id: name }, { projection: { portal: 1 } }),
      ctx.col.lessons.countDocuments({ group: name }),
      ctx.col.lessons.find({ group: name }).sort({ start: 1 }).limit(1).toArray(),
      ctx.col.lessons.find({ group: name }).sort({ start: -1 }).limit(1).toArray(),
    ]);
    return { portal: (doc && doc.portal) || null, lessons: count, first: first[0] ? first[0].start : null, last: last[0] ? last[0].start : null };
  }, { admin: true });

  // Застосувати: сервер сам заново читає портал (клієнту розклад не довіряє) і замінює пари групи за період.
  route('POST', '/api/admin/groups/:name/schedule', async ({ params, body, user, ip }) => {
    const name = await requireGroup(params.name);
    const b = body || {};
    const from = str(b.from, 10);
    const to = str(b.to, 10);
    if (!isDayKey(from) || !isDayKey(to)) throw new HttpError(400, 'Вкажіть період дат.');

    const data = await portal.schedule({ faculty: b.faculty, course: b.course, group: b.group, from, to }, { refresh: true });
    if (!data.lessons.length) {
      throw new HttpError(400, 'Портал не повернув жодної пари за цей період — щоденник не змінено.', { code: 'portal_empty' });
    }

    const docs = data.lessons.map((l) => toDoc(l, name));
    const lo = dayStart(from);
    const hi = dayStart(addDays(to, 1));
    let removed = 0;
    await scores.runAtomic(async (session) => {
      const r = await ctx.col.lessons.deleteMany({ group: name, start: { $gte: lo, $lt: hi } }, { session });
      removed = r.deletedCount || 0;
      await ctx.col.lessons.insertMany(docs, { session, ordered: true });
    });
    await fillNames(data.lessons);

    const link = {
      facultyId: data.faculty.id, facultyName: data.faculty.name, course: data.course.id,
      groupId: data.group.id, groupName: data.group.name, from, to, count: docs.length, appliedAt: ctx.now(),
    };
    await ctx.col.groups.updateOne({ _id: name }, { $set: { portal: link } }, { upsert: true });
    await audit(user, 'schedule.import', {
      target: { type: 'group', id: name, name },
      details: { source: 'portal', portalGroup: data.group.name, from, to, count: docs.length, removed }, ip,
    });
    return { ok: true, count: docs.length, removed, from, to, portal: link };
  }, { admin: true, audit: false });

  // Відв'язати розклад порталу від групи й прибрати її пари (студенти групи знову побачать загальний розклад).
  route('DELETE', '/api/admin/groups/:name/schedule', async ({ params, user, ip }) => {
    const name = await requireGroup(params.name);
    const r = await ctx.col.lessons.deleteMany({ group: name });
    await ctx.col.groups.updateOne({ _id: name }, { $unset: { portal: '' } });
    await audit(user, 'schedule.clear', { target: { type: 'group', id: name, name }, details: { removed: r.deletedCount || 0 }, ip });
    return { ok: true, removed: r.deletedCount || 0 };
  }, { admin: true, audit: false });
}

module.exports = { register, groupKey, toDoc };
