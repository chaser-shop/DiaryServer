const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { User, Lesson, Subject, Teacher, Homework, Setting } = require('./models');
const { sign, auth, adminOnly, bindDevice } = require('./auth');
const { cleanName, validName, makeKey } = require('./names');

const router = express.Router();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- серіалізація (у форматі, який чекає iOS-застосунок) ----------

const publicUser = (u) => ({ id: String(u._id), fullName: u.fullName, isAdmin: !!u.isAdmin });

const lessonOut = (l) => ({
  id: l.lid, pair: l.pair, start: l.start, end: l.end,
  subjectKey: l.subjectKey || '', kind: l.kind || '', topic: l.topic || '',
  room: l.room || '', teacher: l.teacher || '', isRemote: !!l.isRemote,
});

const hwOut = (h) => ({
  id: String(h._id),
  subjectKey: h.subjectKey,
  lessonID: h.lessonId || null,
  text: h.text,
  due: h.due,
  created: h.createdAt,
  status: h.status,
  authorID: h.author ? String(h.author) : null,
  authorName: h.authorName || '',
});

// ---------- вхід ----------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Спробуйте за кілька хвилин.' },
});

router.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const fullName = cleanName(req.body.fullName);
  const deviceId = str(req.body.deviceId, 100);
  if (!validName(fullName)) {
    throw new HttpError(400, 'Введіть ПІБ повністю: прізвище, ім’я та по батькові.');
  }
  if (!deviceId) throw new HttpError(400, 'Не вдалося визначити пристрій.');

  const nameKey = makeKey(fullName);
  let user = await User.findOne({ nameKey });

  if (!user) {
    try {
      user = await User.create({ fullName, nameKey, deviceId });
    } catch (e) {
      if (e.code !== 11000) throw e;           // гонка: хтось створив у ту ж мить
      user = await User.findOne({ nameKey });
    }
  }

  if (bindDevice) {
    if (user.deviceId && user.deviceId !== deviceId) {
      throw new HttpError(409, 'Цей ПІБ уже закріплено за іншим пристроєм. Зверніться до адміністратора.');
    }
    if (!user.deviceId) user.deviceId = deviceId;
  }
  user.lastLoginAt = new Date();
  await user.save();

  res.json({ token: sign(user, deviceId), user: publicUser(user) });
}));

// ---------- синхронізація ----------

router.get('/sync', auth, wrap(async (req, res) => {
  const user = req.user;
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  // Усі бачать підтверджене; автор бачить і власні непідтверджені; адмін — ще й чужі в черзі.
  const visible = user.isAdmin
    ? { status: { $in: ['pending', 'approved'] } }
    : { $or: [{ status: 'approved' }, { author: user._id }] };

  const [lessons, subjects, teachers, homework, title] = await Promise.all([
    Lesson.find().sort({ start: 1 }).lean(),
    Subject.find().lean(),
    Teacher.find().lean(),
    Homework.find({ $and: [visible, { $or: [{ due: { $gte: cutoff } }, { status: 'pending' }] }] })
      .sort({ due: 1 }).limit(500).lean(),
    Setting.findOne({ key: 'scheduleTitle' }).lean(),
  ]);

  res.json({
    user: publicUser(user),
    scheduleTitle: (title && title.value) || '',
    lessons: lessons.map(lessonOut),
    subjects: Object.fromEntries(subjects.map((s) => [s.key, { fullName: s.fullName, link: s.link }])),
    teachers: Object.fromEntries(teachers.map((t) => [t.key, t.fullName])),
    homework: homework.map(hwOut),
  });
}));

// ---------- розклад (адмін) ----------

router.put('/schedule', auth, adminOnly, wrap(async (req, res) => {
  const { title, lessons } = req.body;
  if (!Array.isArray(lessons) || lessons.length === 0 || lessons.length > 5000) {
    throw new HttpError(400, 'Некоректний розклад.');
  }

  const byId = new Map();
  for (const l of lessons) {
    const id = str(l && l.id, 40);
    const start = new Date(l && l.start);
    const end = new Date(l && l.end);
    if (!id || isNaN(start) || isNaN(end) || !Number.isInteger(l.pair)) {
      throw new HttpError(400, 'У файлі є некоректна пара.');
    }
    byId.set(id, {
      lid: id, pair: l.pair, start, end,
      subjectKey: str(l.subjectKey, 100), kind: str(l.kind, 20), topic: str(l.topic, 100),
      room: str(l.room, 50), teacher: str(l.teacher, 150), isRemote: l.isRemote === true,
    });
  }

  // Як і раніше: новий файл замінює пари від своєї першої дати, старіші лишаються.
  const docs = [...byId.values()];
  const firstNew = new Date(Math.min(...docs.map((d) => d.start.getTime())));

  await Lesson.bulkWrite([
    { deleteMany: { filter: { start: { $gte: firstNew } } } },
    ...docs.map((document) => ({ insertOne: { document } })),
  ], { ordered: true });

  await Setting.updateOne({ key: 'scheduleTitle' }, { $set: { value: str(title, 200) } }, { upsert: true });
  res.json({ ok: true, count: docs.length });
}));

// ---------- предмети й викладачі (адмін) ----------

router.put('/subjects', auth, adminOnly, wrap(async (req, res) => {
  const key = str(req.body.key, 100);
  if (!key) throw new HttpError(400, 'Не вказано предмет.');
  const fullName = str(req.body.fullName, 200);
  const link = str(req.body.link, 500);
  if (link) {
    if (/\s/.test(link)) throw new HttpError(400, 'Посилання не може містити пробілів.');
    if (link.includes('://') && !/^https?:\/\//i.test(link)) {
      throw new HttpError(400, 'Посилання має починатися з http:// або https://');
    }
  }
  await Subject.updateOne({ key }, { $set: { fullName, link } }, { upsert: true });
  res.json({ ok: true });
}));

router.put('/teachers', auth, adminOnly, wrap(async (req, res) => {
  const key = str(req.body.key, 150);
  if (!key) throw new HttpError(400, 'Не вказано викладача.');
  const fullName = str(req.body.fullName, 200);
  if (fullName) {
    await Teacher.updateOne({ key }, { $set: { fullName } }, { upsert: true });
  } else {
    await Teacher.deleteOne({ key });
  }
  res.json({ ok: true });
}));

// ---------- домашнє завдання ----------

function parseHomework(body) {
  const subjectKey = str(body.subjectKey, 100);
  const text = str(body.text, 2000);
  const due = new Date(body.due);
  if (!subjectKey) throw new HttpError(400, 'Оберіть предмет.');
  if (!text) throw new HttpError(400, 'Опишіть завдання.');
  if (isNaN(due)) throw new HttpError(400, 'Вкажіть дату здачі.');
  return { subjectKey, text, due };
}

async function findHomework(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Завдання не знайдено.');
  const h = await Homework.findById(id);
  if (!h) throw new HttpError(404, 'Завдання не знайдено.');
  return h;
}

const isOwner = (h, user) => h.author && String(h.author) === String(user._id);

// Додати може будь-хто: у користувача завдання чекає підтвердження, у адміна — одразу активне.
router.post('/homework', auth, wrap(async (req, res) => {
  const user = req.user;
  const data = parseHomework(req.body);

  if (!user.isAdmin) {
    const waiting = await Homework.countDocuments({ author: user._id, status: 'pending' });
    if (waiting >= 20) {
      throw new HttpError(429, 'У вас забагато завдань, що чекають підтвердження.');
    }
  }

  const h = await Homework.create({
    ...data,
    lessonId: str(req.body.lessonID, 60) || null,
    status: user.isAdmin ? 'approved' : 'pending',
    author: user._id,
    authorName: user.fullName,
    ...(user.isAdmin ? { reviewedBy: user.fullName, reviewedAt: new Date() } : {}),
  });
  res.status(201).json(hwOut(h.toObject()));
}));

router.patch('/homework/:id', auth, wrap(async (req, res) => {
  const user = req.user;
  const h = await findHomework(req.params.id);
  if (!user.isAdmin && !(isOwner(h, user) && h.status !== 'approved')) {
    throw new HttpError(403, 'Це завдання не можна змінити.');
  }
  const data = parseHomework(req.body);
  h.subjectKey = data.subjectKey;
  h.text = data.text;
  h.due = data.due;
  if (!user.isAdmin && h.status === 'rejected') h.status = 'pending';   // виправив і надіслав знову
  await h.save();
  res.json(hwOut(h.toObject()));
}));

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  router.post(`/homework/:id/${action}`, auth, adminOnly, wrap(async (req, res) => {
    const h = await findHomework(req.params.id);
    h.status = status;
    h.reviewedBy = req.user.fullName;
    h.reviewedAt = new Date();
    await h.save();
    res.json(hwOut(h.toObject()));
  }));
}

router.delete('/homework/:id', auth, wrap(async (req, res) => {
  const user = req.user;
  const h = await findHomework(req.params.id);
  if (!user.isAdmin && !(isOwner(h, user) && h.status !== 'approved')) {
    throw new HttpError(403, 'Це завдання не можна видалити.');
  }
  await h.deleteOne();
  res.json({ ok: true });
}));

module.exports = router;
