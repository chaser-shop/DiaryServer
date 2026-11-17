'use strict';
/* Портал розкладу: розбір справжньої сторінки (фікстура з відповіді порталу) і клієнт на локальному «порталі». */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'portal-group.html'), 'utf8');

// ───────── чистий розбір ─────────

const T0 = require('../lib/timetable');

test('форма: факультети, курси, групи, вибране', () => {
  const f = T0.parseForm(FIXTURE);
  assert.equal(f.hasForm, true);
  assert.equal(f.faculties.length, 12);
  assert.deepEqual(f.faculties.find((x) => x.id === '98'), { id: '98', name: 'Навчально-науковиий інститут права та психології' });
  assert.equal(f.faculties.find((x) => x.id === '26').name, 'Аспірантура (ад\'юнктура) та докторантура'); // &#039;
  assert.deepEqual(f.courses.map((c) => c.id), ['1', '2', '3', '4']);
  assert.equal(f.groups.length, 20);
  assert.deepEqual(f.selected, { faculty: '98', course: '1', group: '8614' });
  assert.ok(f.csrf.length > 20);
});

test('розклад: 48 пар, час за Києвом, повні назви з підказок', () => {
  const s = T0.parseSchedule(FIXTURE);
  assert.equal(s.found, true);
  assert.equal(s.dates, 5);
  assert.equal(s.lessons.length, 48);
  assert.equal(new Set(s.lessons.map((l) => l.id)).size, 48);

  const l = s.lessons.find((x) => x.id === '20261123-3');
  assert.equal(l.subjectKey, 'Інф ТтаС');
  assert.equal(l.subjectFull, 'Інформаційні технології та системи');
  assert.match(l.theme, /^Безпечне інформаційне середовище/);
  assert.equal(l.kind, 'Пз');
  assert.equal(l.topic, 'т.7/з.2');
  assert.equal(l.isRemote, true);
  assert.equal(l.room, '');
  assert.equal(l.teacher, 'Панібратов СФ Р.С.');
  assert.equal(l.teacherFull, 'Панібратов СФ Роман Сергійович');
  assert.equal(l.group, '101_СПД_2026');
  assert.equal(l.added, '2026-11-12');
  assert.equal(l.updated, true);
  assert.equal(l.start, '2026-11-23T09:00:00.000Z'); // 11:00 за Києвом (UTC+2)
  assert.equal(l.end, '2026-11-23T10:20:00.000Z');
});

test('розклад: «closed» і порожні клітинки пропущено, іменовані пари на початку періоду', () => {
  const s = T0.parseSchedule(FIXTURE);
  assert.ok(!s.lessons.some((l) => l.date === '2026-11-16')); // до початку періоду
  assert.equal(s.lessons[0].date, '2026-11-17');
  const sorted = [...s.lessons].sort((a, b) => (a.start < b.start ? -1 : 1));
  assert.deepEqual(s.lessons.map((l) => l.id), sorted.map((l) => l.id));
});

test('розклад: кілька викладачів, кілька аудиторій, тип пари', () => {
  const s = T0.parseSchedule(FIXTURE);
  const pe = s.lessons.find((l) => l.subjectFull === 'Спеціальна фізична підготовка');
  assert.equal(pe.teacherFull, 'Сідельніков СФ Ігор Олексійович, Дячук СФ Владислав Вадимович');
  assert.equal(pe.teacher, 'Сідельніков СФ І.О., Дячук СФ В.В.');
  const two = s.lessons.find((l) => l.room.includes(','));
  assert.equal(two.isRemote, false);
  assert.ok(s.lessons.some((l) => l.updated) && s.lessons.some((l) => !l.updated));
  assert.deepEqual([...new Set(s.lessons.map((l) => l.typeClass))].sort(), ['2', '20', '3']);
});

test('розклад: порожня або чужа сторінка не ламає розбір', () => {
  assert.deepEqual(T0.parseSchedule('<html>нічого</html>'), { found: false, lessons: [], dates: 0 });
  assert.equal(T0.parseForm('<html></html>').hasForm, false);
});

test('діапазон дат перевіряється', () => {
  assert.deepEqual(T0.normRange('2026-11-17', '2026-12-15'), { from: '17.11.2026', to: '15.12.2026' });
  assert.throws(() => T0.normRange('2026-12-15', '2026-11-17'), /не раніше/);
  assert.throws(() => T0.normRange('2026-01-01', '2026-12-31'), /задовгий/);
  assert.throws(() => T0.normRange('2026-02-31', '2026-03-01'), /не існує/);
  assert.throws(() => T0.normRange('17.11.2026', '2026-12-15'), /формат/);
});

// ───────── клієнт проти локального «порталу» ─────────

function selects(fac, crs, grp, sel) {
  const o = (list, cur) => list.map(([v, n]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${n}</option>`).join('');
  return `<form id="filter-form"><select id="timetableform-facultyid" name="TimeTableForm[facultyId]"><option value="">--Факультет--</option>${o(fac, sel.f)}</select>`
    + `<select id="timetableform-course" name="TimeTableForm[course]"><option value="">--Курс--</option>${o(crs, sel.c)}</select>`
    + `<select id="timetableform-groupid" name="TimeTableForm[groupId]"><option value="">--Група--</option>${o(grp, sel.g)}</select></form>`;
}
const page = (token, inner) => `<!doctype html><html><head><meta name="csrf-token" content="${token}"></head><body>${inner}</body></html>`;

async function startPortal() {
  const st = { token: 'tok-1', hits: [], mode: 'ok', expireOnce: false };
  const FAC = [[98, 'Інститут права'], [14, 'Поліцейська діяльність']];
  const GRP = [[8614, '101_СПД_2026'], [8615, '102_СПД_2026']];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      st.hits.push({ method: req.method, url: req.url, cookie: req.headers.cookie || '', ua: req.headers['user-agent'], body });
      if (st.mode === 'cf') {
        res.writeHead(403, { server: 'cloudflare', 'Content-Type': 'text/html' });
        return res.end('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>');
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['advanced-frontend=sess1; path=/; HttpOnly', '_csrf-frontend=sec1; path=/'] });
        return res.end(page(st.token, selects(FAC, [], [], {})));
      }
      const p = new URLSearchParams(body);
      if (!/advanced-frontend=sess1/.test(req.headers.cookie || '') || p.get('_csrf-frontend') !== st.token || st.expireOnce) {
        if (st.expireOnce) { st.expireOnce = false; st.token = 'tok-2'; }
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end('Bad Request');
      }
      const f = p.get('TimeTableForm[facultyId]');
      const c = p.get('TimeTableForm[course]');
      const g = p.get('TimeTableForm[groupId]');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (f && c && g) {
        // Портал повертає форму з обраною групою й таблицею (беремо справжню відповідь).
        return res.end(g === '8614' ? FIXTURE : page(st.token, selects(FAC, [[1, '1']], GRP, { f, c, g: '' })));
      }
      if (f && c) return res.end(page(st.token, selects(FAC, [[1, '1'], [2, '2']], GRP, { f, c, g: '' })));
      if (f) return res.end(page(st.token, selects(FAC, [[1, '1'], [2, '2']], [], { f, c: '', g: '' })));
      res.end(page(st.token, selects(FAC, [], [], {})));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, server, base: `http://127.0.0.1:${server.address().port}` };
}

function freshPortal(base) {
  process.env.TIMETABLE_BASE = base;
  process.env.TIMETABLE_GAP_MS = '0';
  delete require.cache[require.resolve('../lib/timetable')];
  return require('../lib/timetable');
}

test('каскад: факультети → курси → групи → розклад, сесія й CSRF', async () => {
  const { st, server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    const p = new Portal();
    const fac = await p.faculties();
    assert.deepEqual(fac.map((x) => x.id), ['98', '14']);
    assert.deepEqual((await p.courses('98')).map((x) => x.id), ['1', '2']);
    assert.deepEqual((await p.groups('98', '1')).map((x) => x.name), ['101_СПД_2026', '102_СПД_2026']);

    const d = await p.schedule({ faculty: '98', course: '1', group: '8614', from: '2026-11-17', to: '2026-12-15' });
    assert.equal(d.lessons.length, 48);
    assert.equal(d.group.name, '101_СПД_2026');
    assert.equal(d.faculty.name, 'Навчально-науковиий інститут права та психології'); // назва з відповіді порталу

    const post = st.hits.filter((h) => h.method === 'POST').pop();
    const body = new URLSearchParams(post.body);
    assert.equal(body.get('TimeTableForm[facultyId]'), '98');
    assert.equal(body.get('TimeTableForm[course]'), '1');
    assert.equal(body.get('TimeTableForm[groupId]'), '8614');
    assert.equal(body.get('TimeTableForm[dateStart]'), '17.11.2026');
    assert.equal(body.get('TimeTableForm[dateEnd]'), '15.12.2026');
    assert.equal(body.get('date-picker'), '17.11.2026 - 15.12.2026');
    assert.equal(body.get('time-table-type'), '1');
    assert.match(post.cookie, /advanced-frontend=sess1/);
    assert.equal(st.hits.filter((h) => h.method === 'GET').length, 1); // одна сесія на всі запити
    assert.match(post.ua, /StudentDiary/);                            // чесний User-Agent
  } finally { server.close(); }
});

test('кеш: повторний запит не б’є по порталу, refresh — б’є', async () => {
  const { st, server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    const p = new Portal();
    await p.faculties();
    await p.faculties();
    assert.equal(st.hits.length, 1);
    await p.faculties({ refresh: true });
    assert.equal(st.hits.length, 2);
  } finally { server.close(); }
});

test('прострочений CSRF: клієнт відкриває сесію знову й повторює запит один раз', async () => {
  const { st, server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    const p = new Portal();
    await p.faculties();
    st.expireOnce = true;
    const crs = await p.courses('98');
    assert.deepEqual(crs.map((x) => x.id), ['1', '2']);
    assert.equal(st.hits.filter((h) => h.method === 'GET').length, 2);
  } finally { server.close(); }
});

test('інша група замість запитаної — помилка, а не чужий розклад', async () => {
  const { server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    await assert.rejects(
      new Portal().schedule({ faculty: '98', course: '1', group: '8615', from: '2026-11-17', to: '2026-11-24' }),
      (e) => e.extra.code === 'portal_no_group' && e.status === 404,
    );
  } finally { server.close(); }
});

test('захист від ботів не обходимо: зрозуміла помилка portal_blocked', async () => {
  const { st, server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    st.mode = 'cf';
    await assert.rejects(new Portal().faculties(), (e) => e.extra.code === 'portal_blocked' && e.status === 502 && /захист/.test(e.message));
  } finally { server.close(); }
});

test('некоректні ідентифікатори відхиляються до звернення до порталу', async () => {
  const { st, server, base } = await startPortal();
  try {
    const { Portal } = freshPortal(base);
    const p = new Portal();
    await assert.rejects(p.courses('98; DROP'), (e) => e.status === 400);
    await assert.rejects(p.groups('98', ''), (e) => e.status === 400);
    await assert.rejects(p.schedule({ faculty: '98', course: '1', group: 'x', from: '2026-11-17', to: '2026-11-18' }), (e) => e.status === 400);
    assert.equal(st.hits.length, 0);
  } finally { server.close(); }
});
