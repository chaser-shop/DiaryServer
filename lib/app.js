const path = require('path');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { MONGODB_URI, DB_NAME = 'navs_diary', JWT_SECRET, ADMIN_LOGIN = 'admin', ADMIN_PASSWORD } = process.env;

const SUBJECTS = ['СПОУ', 'Інформ', 'Англ', 'Вступ', 'КПУ', 'Укр', 'СФП', 'ТіДтП'];
const app = express();
app.use(express.json({ limit: '100kb' }));

// Підключення до MongoDB з кешем: на Vercel інстанс функції переживає кілька запитів
let users;
let colPromise;
async function getUsers() {
  if (!MONGODB_URI || !JWT_SECRET) throw new Error('Не задано MONGODB_URI або JWT_SECRET');
  if (!colPromise) {
    colPromise = (async () => {
      const client = await MongoClient.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
      const col = client.db(DB_NAME).collection('users');
      await col.createIndex({ login: 1 }, { unique: true });
      if (!(await col.findOne({ role: 'admin' }))) {
        if (!ADMIN_PASSWORD) throw new Error('Не задано ADMIN_PASSWORD для першого адміністратора');
        await col.insertOne({ role: 'admin', login: ADMIN_LOGIN, fullName: 'Адміністратор системи', passHash: await bcrypt.hash(ADMIN_PASSWORD, 10), createdAt: new Date() });
      }
      return col;
    })().catch((e) => { colPromise = null; throw e; });
  }
  return colPromise;
}
app.use('/api', async (req, res, next) => {
  try { users = await getUsers(); next(); }
  catch (e) { console.error('MongoDB:', e.message); res.status(503).json({ error: 'База даних недоступна' }); }
});

const oid = (id) => new ObjectId(String(id));
const pub = (u) => { const { _id, passHash, ...rest } = u; return { id: String(_id), ...rest }; };
const sign = (u) => jwt.sign({ id: String(u._id), role: u.role }, JWT_SECRET, { expiresIn: '8h' });
const auth = (roles) => (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(t, JWT_SECRET);
    if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостатньо прав' });
    next();
  } catch { res.status(401).json({ error: 'Потрібно увійти' }); }
};
const admin = auth(['admin']);
const str = (v) => String(v == null ? '' : v).trim();

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', async (req, res) => {
  const { login, password, faculty, course, group } = req.body || {};
  const u = await users.findOne({ login: str(login) });
  if (!u || !(await bcrypt.compare(str(password), u.passHash))) return res.status(401).json({ error: 'Невірний логін або пароль.' });
  if (u.role === 'student' && (u.faculty !== faculty || u.course !== str(course) || u.group !== group))
    return res.status(401).json({ error: 'Факультет, курс або група не збігаються з обліковим записом.' });
  res.json({ token: sign(u), user: pub(u) });
});

app.get('/api/me', auth(), async (req, res) => {
  const u = await users.findOne({ _id: oid(req.user.id) });
  u ? res.json(pub(u)) : res.status(404).json({ error: 'Користувача не знайдено' });
});

app.put('/api/me', auth(), async (req, res) => {
  const set = {};
  if (str(req.body.fullName)) set.fullName = str(req.body.fullName);
  if (req.body.password) {
    if (str(req.body.password).length < 6) return res.status(400).json({ error: 'Пароль має бути не коротший за 6 символів' });
    set.passHash = await bcrypt.hash(str(req.body.password), 10);
  }
  if (Object.keys(set).length) await users.updateOne({ _id: oid(req.user.id) }, { $set: set });
  res.json(pub(await users.findOne({ _id: oid(req.user.id) })));
});

app.get('/api/students', admin, async (req, res) => {
  const list = await users.find({ role: 'student' }).sort({ fullName: 1 }).toArray();
  res.json(list.map(pub));
});

app.post('/api/students', admin, async (req, res) => {
  const b = req.body || {};
  if (!str(b.fullName) || !str(b.login) || !str(b.group)) return res.status(400).json({ error: 'Вкажіть ПІБ, логін і групу' });
  if (await users.findOne({ login: str(b.login) })) return res.status(409).json({ error: 'Цей логін уже зайнятий' });
  const doc = {
    role: 'student', login: str(b.login), fullName: str(b.fullName), faculty: str(b.faculty), course: str(b.course), group: str(b.group),
    passHash: await bcrypt.hash(str(b.password) || '12345678', 10),
    scores: SUBJECTS.map((subject) => ({ subject, score: 0 })), createdAt: new Date(),
  };
  const r = await users.insertOne(doc);
  res.status(201).json(pub({ ...doc, _id: r.insertedId }));
});

app.put('/api/students/:id', admin, async (req, res) => {
  const b = req.body || {};
  const set = { fullName: str(b.fullName), login: str(b.login), faculty: str(b.faculty), course: str(b.course), group: str(b.group) };
  if (!set.fullName || !set.login || !set.group) return res.status(400).json({ error: 'Вкажіть ПІБ, логін і групу' });
  if (await users.findOne({ login: set.login, _id: { $ne: oid(req.params.id) } })) return res.status(409).json({ error: 'Цей логін уже зайнятий' });
  if (b.password) {
    if (str(b.password).length < 6) return res.status(400).json({ error: 'Пароль має бути не коротший за 6 символів' });
    set.passHash = await bcrypt.hash(str(b.password), 10);
  }
  const r = await users.updateOne({ _id: oid(req.params.id), role: 'student' }, { $set: set });
  r.matchedCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Курсанта не знайдено' });
});

app.put('/api/students/:id/scores', admin, async (req, res) => {
  const arr = Array.isArray(req.body.scores) ? req.body.scores : [];
  const clean = arr.map((x) => ({ subject: str(x.subject), score: Number(x.score) }));
  if (!clean.length || clean.some((x) => !x.subject || !Number.isFinite(x.score) || x.score < 0 || x.score > 100))
    return res.status(400).json({ error: 'Бали мають бути числами від 0 до 100' });
  const r = await users.updateOne({ _id: oid(req.params.id), role: 'student' }, { $set: { scores: clean } });
  r.matchedCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Курсанта не знайдено' });
});

app.delete('/api/students/:id', admin, async (req, res) => {
  const r = await users.deleteOne({ _id: oid(req.params.id), role: 'student' });
  r.deletedCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Курсанта не знайдено' });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Помилка сервера' }); });

module.exports = app;
