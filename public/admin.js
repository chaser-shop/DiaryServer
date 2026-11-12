/*
 * Адміністрування журналу успішності: огляд, аналітика, студенти й картка студента, синхронізація з Google Sheets,
 * конфлікти, історія балів і журнал дій. Права перевіряє сервер (усі запити — до /api/admin/*); тут лише інтерфейс.
 */
(() => {
  'use strict';
  const D = window.Diary;
  if (!D) return;
  const { S, api, esc, ic, ui, fmt, toast, badge } = D;
  const $ = (s, r = document) => r.querySelector(s);
  const render = () => D.render();

  // ───────────── стан ─────────────

  const blank = () => ({
    dash: null, dashErr: '',
    an: null, anErr: '', anLoading: false, anRange: D.LS.get('adminRange', '30d'), anFrom: '', anTo: '', anGroup: '', anPeriod: 'day',
    groups: null, catalog: null,
    st: { data: null, err: '', q: '', status: 'active', group: '', subject: '', sort: 'rank', dir: '', page: 1 },
    stu: { id: null, data: null, err: '', activity: null },
    sync: { data: null, err: '', runs: null, runsStatus: '', runsPage: 1, busy: false, diag: null },
    cf: { data: null, err: '', status: 'open', page: 1 },
    hist: { data: null, err: '', q: '', subject: '', source: '', group: '', from: '', to: '', studentId: '', studentName: '', page: 1 },
    aud: { data: null, err: '', q: '', action: '', role: '', from: '', to: '', page: 1 },
    grp: { data: null, err: '', edit: '', msg: '', msgCls: 'muted', draft: '', renameDraft: '', editMsg: '' },
  });
  const A = blank();

  // ───────────── допоміжне ─────────────

  const STALE = new Error('stale');
  const seq = {};
  /** GET, що ігнорує застарілі відповіді: якщо фільтр змінили до відповіді, діє лише останній запит. */
  async function latest(key, path) {
    const n = (seq[key] = (seq[key] || 0) + 1);
    let r;
    try { r = await api('GET', path); } catch (e) { throw seq[key] === n ? e : STALE; }
    if (seq[key] !== n) throw STALE;
    return r;
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const enc = encodeURIComponent;
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return keyOf(d); };
  const round2 = (v) => Math.round(v * 100) / 100;
  const toTop = () => { const m = $('main.content'); if (m) m.scrollTop = 0; };
  const pageKey = () => (S.user && S.tab === 'admin' ? D.currentPage().key : '');

  const num = (v) => esc(fmt.num(v));
  const when = (v) => (v ? `<span title="${esc(fmt.dateTime(v))}">${esc(fmt.rel(v))}</span>` : '—');
  const until = (v) => { const m = Math.round((new Date(v) - Date.now()) / 60000); return m <= 0 ? 'найближчим часом' : m < 60 ? `через ${m} хв` : fmt.dateTime(v); };
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`;
  const who = (id, name) => (id ? `<button class="link a-name" data-act="aStudent" data-id="${esc(id)}">${esc(name || '—')}</button>` : esc(name || '—'));
  const box = (title, sub, body, right = '', cls = '') => `<div class="card ${cls}"><div class="card-head"><div><div class="card-title">${esc(title)}</div>${sub ? `<div class="card-sub">${sub}</div>` : ''}</div>${right}</div>${body}</div>`;
  const subjLabel = (x) => (x.title && x.title !== x.key ? `${x.key} — ${x.title}` : x.key);
  const legend = (items) => `<div class="legend">${items.map(([, name, color]) => `<span><i style="background:${color}"></i>${esc(name)}</span>`).join('')}</div>`;
  const plural = (n, a, b, c) => `${n} ${fmt.plural(n, a, b, c)}`;
  const say = (s, text, cls = 'err') => {
    const m = s && s.el && s.el.querySelector('[data-role="msg"]');
    if (m) { m.hidden = !text; m.className = cls + ' small'; m.textContent = text; }
  };
  const field = (s, name) => { const el = s.el.querySelector(`[name="${name}"]`); return el ? el.value.trim() : ''; };
  /** Число з поля: порожньо → null, кома як десятковий роздільник, некоректне → NaN. */
  const parseNum = (raw) => { const t = String(raw || '').trim().replace(',', '.'); if (t === '') return null; const v = Number(t); return Number.isFinite(v) ? v : NaN; };

  // ───────────── довідники ─────────────

  const SRC = D.SOURCE_TITLES;
  const SRC_SERIES = [['student', 'Студенти', 'var(--c1)'], ['sheet', 'Google-таблиця', 'var(--c2)'], ['admin', 'Адміністратор', 'var(--c4)'], ['other', 'Інше', 'var(--c6)']];
  const RUN_STATUS = { success: ['Успішно', ''], unchanged: ['Без змін', 'gray'], error: ['Помилка', 'red'], aborted: ['Зупинено', 'warn'], running: ['Виконується', 'sky'] };
  const runBadge = (s) => { const [t, c] = RUN_STATUS[s] || [s || '—', 'gray']; return badge(t, c); };
  const RUN_KIND = { auto: 'Автоматично', manual: 'Вручну' };
  const ROLE = { admin: 'Адміністратор', starosta: 'Староста', deputy: 'Заступник старости', student: 'Студент', system: 'Система' };
  const RESOLUTION = {
    accept_sheet: 'Прийнято значення з таблиці', keep_current: 'Залишено поточне значення', custom: 'Встановлено інше значення',
    superseded: 'Закрито автоматично', deleted: 'Студента видалено',
  };
  const ACTIONS = {
    'score.increase': 'Підвищення балу студентом', 'score.admin_set': 'Виправлення балу',
    'conflict.resolve': 'Розв’язання конфлікту',
    'sync.manual': 'Синхронізація вручну', 'sync.force': 'Примусова синхронізація', 'sync.diagnostics': 'Перевірка доступу до таблиці',
    'student.create': 'Додавання студента', 'student.update': 'Редагування студента', 'student.delete': 'Видалення студента',
    'student.archive': 'Архівування студента', 'student.restore': 'Відновлення студента',
    'rating.import': 'Імпорт таблиці з файлу', 'catalog.update': 'Зміна предмета рейтингу',
    'group.create': 'Створення групи', 'group.rename': 'Перейменування групи', 'group.delete': 'Видалення групи',
    'user.group': 'Зміна групи учасника', 'user.role': 'Зміна ролі', 'user.delete': 'Видалення учасника',
    'user.link_student': 'Прив’язка до рейтингу', 'user.unlink_student': 'Скасування прив’язки до рейтингу',
    'device.approve': 'Підтвердження входу з пристрою', 'device.reject': 'Відхилення входу з пристрою',
    'device.remove': 'Видалення пристрою', 'device.trust': 'Зміна довіри до пристрою', 'devices.reset': 'Скидання пристроїв',
    'homework.approve': 'Підтвердження домашнього', 'homework.reject': 'Відхилення домашнього', 'lesson.no_homework': 'Позначка «без домашнього»',
    'schedule.upload': 'Завантаження розкладу', 'subject.update': 'Зміна предмета розкладу', 'teacher.update': 'Зміна викладача',
    'grades.check': 'Перевірка оцінок', 'notify.send': 'Надсилання сповіщення', 'system.migrate': 'Перенесення даних',
  };
  const actionTitle = (a) => ACTIONS[a] || (/^api\./.test(a) ? 'Інша дія адміністратора' : a);
  const ACTION_GROUPS = [
    ['', 'Усі дії'], ['score.', 'Бали'], ['conflict.', 'Конфлікти'], ['sync.', 'Синхронізація'], ['student.', 'Студенти'],
    ['rating.', 'Імпорт рейтингу'], ['catalog.', 'Предмети'], ['group.', 'Групи'], ['user.', 'Учасники'], ['device.', 'Пристрої'],
    ['homework.', 'Домашнє'], ['schedule.', 'Розклад'], ['notify.', 'Сповіщення'], ['system.', 'Система'],
  ];
  const TARGET = { user: 'учасник', group: 'група', subject: 'предмет', student: 'студент' };
  // Поля загального аудиту, які показуємо українською; решту (ідентифікатори тощо) не показуємо.
  const DETAIL_KEYS = { role: 'роль', group: 'група', name: 'назва', fullName: 'ПІБ', title: 'заголовок', body: 'текст', points: 'бали', trusted: 'довіра', label: 'назва', archived: 'архів', to: 'нове значення', from: 'попереднє значення' };

  // ───────────── завантаження ─────────────

  async function loadDash() {
    try { A.dash = await latest('dash', '/api/admin/dashboard'); A.dashErr = ''; S.openConflicts = A.dash.kpis.openConflicts; } catch (e) { if (e === STALE) return; A.dashErr = e.message; }
    render();
  }
  async function loadGroups() {
    try { A.groups = await api('GET', '/api/admin/groups'); } catch (e) { A.groups = A.groups || []; }
    render();
  }
  async function loadCatalog() {
    try { A.catalog = await api('GET', '/api/admin/catalog'); } catch (e) { A.catalog = A.catalog || { items: [], defaultMax: 100 }; }
    render();
  }
  function ensureMeta() { if (!A.groups) loadGroups(); if (!A.catalog) loadCatalog(); }

  async function loadAnalytics() {
    if (A.anRange === 'custom' && !(A.anFrom && A.anTo)) { A.anFrom = daysAgo(29); A.anTo = daysAgo(0); }
    A.anLoading = true;
    const custom = A.anRange === 'custom';
    try {
      A.an = await latest('an', '/api/admin/analytics?' + qs({ range: A.anRange, from: custom ? A.anFrom : '', to: custom ? A.anTo : '', group: A.anGroup }));
      A.anErr = '';
    } catch (e) { if (e === STALE) return; A.anErr = e.message; }
    A.anLoading = false;
    render();
  }

  async function loadStudents() {
    const F = A.st;
    try {
      F.data = await latest('st', '/api/admin/students?' + qs({ q: F.q, status: F.status, group: F.group, subject: F.subject, sort: F.sort, dir: F.dir, page: F.page, limit: 25 }));
      F.err = '';
    } catch (e) { if (e === STALE) return; F.err = e.message; }
    render();
  }

  async function loadStudent() {
    const id = A.stu.id;
    if (!id) return;
    try {
      const [p, act] = await Promise.all([
        latest('stu', `/api/admin/students/${enc(id)}`),
        api('GET', `/api/admin/students/${enc(id)}/activity`).catch(() => null),
      ]);
      if (A.stu.id !== id) return;
      Object.assign(A.stu, { data: p, activity: act, err: '' });
    } catch (e) { if (e === STALE || A.stu.id !== id) return; A.stu.err = e.message; }
    render();
  }
  function openStudent(id) {
    if (!id) return;
    if (A.stu.id !== id) A.stu = { id, data: null, err: '', activity: null };
    D.go('admin', 'student');
  }

  async function loadSync() {
    const Y = A.sync;
    try {
      const r = await latest('sync', '/api/admin/sync?limit=15');
      Object.assign(Y, { data: r, err: '' });
      S.openConflicts = r.openConflicts;
      if (!Y.runsStatus && Y.runsPage === 1) Y.runs = r.runs;
      else loadRuns(Y.runsPage);
    } catch (e) { if (e === STALE) return; Y.err = e.message; }
    render();
  }
  async function loadRuns(page) {
    const Y = A.sync;
    try { Y.runs = await latest('runs', '/api/admin/sync/runs?' + qs({ page, limit: 15, status: Y.runsStatus })); Y.runsPage = page; } catch (e) { if (e === STALE) return; toast(e.message); }
    render();
  }

  async function loadConflicts() {
    const C = A.cf;
    try {
      C.data = await latest('cf', '/api/admin/conflicts?' + qs({ status: C.status, page: C.page, limit: 20 }));
      C.err = '';
      S.openConflicts = C.data.open;
    } catch (e) { if (e === STALE) return; C.err = e.message; }
    render();
  }

  async function loadHistory() {
    const H = A.hist;
    const one = !!H.studentId;
    try {
      H.data = await latest('hist', '/api/admin/score-history?' + qs({
        studentId: H.studentId, q: one ? '' : H.q, group: one ? '' : H.group, subject: H.subject, source: H.source, from: H.from, to: H.to, page: H.page, limit: 25,
      }));
      H.err = '';
    } catch (e) { if (e === STALE) return; H.err = e.message; }
    render();
  }

  async function loadAudit() {
    const U = A.aud;
    try {
      U.data = await latest('aud', '/api/admin/audit?' + qs({ q: U.q, action: U.action, role: U.role, from: U.from, to: U.to, page: U.page, limit: 25 }));
      U.err = '';
    } catch (e) { if (e === STALE) return; U.err = e.message; }
    render();
  }

  const RELOAD = {
    'admin/overview': loadDash, 'admin/analytics': loadAnalytics, 'admin/students': loadStudents, 'admin/student': loadStudent,
    'admin/sync': loadSync, 'admin/conflicts': loadConflicts, 'admin/history': loadHistory, 'admin/audit': loadAudit,
    'admin/groups': loadGroupsPage,
  };

  // ───────────── спільні блоки ─────────────

  function activityBars(list, labelOf, tipOf, height = 220) {
    return Charts.bars({
      labels: list.map(labelOf), tipLabels: list.map(tipOf), stacked: true, integer: true, height,
      series: SRC_SERIES.map(([k, name, color]) => ({ name, color, values: list.map((d) => d[k] || 0) })),
      empty: 'Змін балів за цей період не було', label: 'Зміни балів за джерелами',
    });
  }

  function distributionChart(dist) {
    return Charts.bars({
      labels: dist.map((b) => `${b.from}–${b.to}`), tipLabels: dist.map((b) => `Середній бал ${b.from}–${b.to}% від максимуму`),
      series: [{ name: 'Студентів', color: 'var(--c1)', values: dist.map((b) => b.count) }], integer: true, height: 220,
      empty: 'Балів ще немає', label: 'Розподіл студентів за середнім балом',
    });
  }

  function subjectBars(list) {
    const rows = (list || []).filter((s) => s.count);
    if (!rows.length) return '<div class="muted small">Балів ще немає.</div>';
    return `<div class="hbars">${rows.map((s) => `<div class="hbar"><span class="hb-l" title="${esc(s.title)}">${esc(s.key)}</span>${ui.progress(s.avg, s.max)}<span class="hb-v">${num(s.avg)}<small class="muted"> / ${num(s.max)}</small></span></div>`).join('')}</div>`;
  }

  function groupTable(list) {
    if (!list || !list.length) return '<div class="muted small">Груп ще немає.</div>';
    return `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr><th>Група</th><th class="r">Студентів</th><th class="r">Сер. загальний</th><th class="r">Сер. за предмет</th></tr></thead><tbody>
      ${list.map((g) => `<tr><td class="head name">${esc(g.group)}</td><td class="r" data-label="Студентів">${g.students}</td><td class="r" data-label="Сер. загальний">${num(g.avgTotal)}</td><td class="r" data-label="Сер. за предмет">${num(g.avgScore)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function moverList(list, empty) {
    if (!list || !list.length) return `<div class="muted small">${esc(empty)}</div>`;
    return `<div class="feed">${list.map((m) => `<div class="feed-item"><div class="feed-body"><span class="t">${who(m.studentId, m.name)}</span>
        <span class="d">${esc(m.group || '')} · ${num(m.from)} → ${num(m.to)}</span></div>
      <div class="feed-side">${ui.delta(m.delta)}${m.pct != null ? `<span class="xs muted">${esc(fmt.signed(m.pct, '%'))}</span>` : ''}</div></div>`).join('')}</div>`;
  }

  // Хто змінив бал: для студента — без повтору імені (запис і так його), для інших джерел — назва джерела.
  function changedBy(x) {
    const src = esc(SRC[x.source] || 'Інше');
    return (x.source === 'admin' || x.source === 'import') && x.actorName ? `${src} · ${esc(x.actorName)}` : src;
  }
  const actorOf = (x) => (x.source === 'sheet' ? 'Синхронізація з таблицею' : x.source === 'seed' || x.source === 'migration' ? 'Система' : x.actorName || '—');

  function histItem(x, { student = false } = {}) {
    return ui.scoreChange(x, {
      who: student ? `${who(x.studentId, x.studentName)}${x.group ? ` <span class="muted">· ${esc(x.group)}</span>` : ''}` : '',
      source: changedBy(x),
    });
  }

  function recentItem(r) {
    if (r.kind === 'score') return histItem(r, { student: true });
    const t = r.target && r.target.name ? ` → ${r.target.type === 'student' ? who(r.target.id, r.target.name) : esc(r.target.name)}` : '';
    return `<div class="feed-item"><span class="feed-ic">${ic('list', 17)}</span><div class="feed-body"><span class="t">${esc(actionTitle(r.action))}</span>
      <span class="d">${esc(r.actorName || 'Система')}${t} · ${when(r.at)}</span></div></div>`;
  }

  function syncHealth(st) {
    if (!st || !st.configured) return { cls: 'gray', text: 'Не налаштовано' };
    if (st.running) return { cls: 'sky', text: 'Виконується' };
    const s = st.state || {};
    if (s.lastRunStatus === 'error' || s.lastRunStatus === 'aborted' || s.status === 'error') return { cls: 'red', text: s.lastRunStatus === 'aborted' ? 'Зупинено' : 'Помилка' };
    if (s.lastSuccessAt) return { cls: '', text: 'Працює' };
    return { cls: 'gray', text: 'Ще не запускалася' };
  }

  function runSummary(run) {
    if (!run) return 'Синхронізацію виконано';
    if (run.status === 'error' || run.status === 'aborted') return 'Синхронізація не вдалася: ' + (run.error || 'невідома помилка');
    if (run.status === 'unchanged') return 'Таблиця не змінилася з минулої перевірки';
    const s = run.stats || {};
    return `Готово: змінено балів — ${s.changedScores || 0}, нових студентів — ${s.newStudents || 0}${s.conflicts ? `, конфліктів — ${s.conflicts}` : ''}`;
  }

  const notConfigured = () => ui.notice('warn', 'Синхронізацію не налаштовано: на сервері не вказано таблицю. Додайте змінну середовища <b>GOOGLE_SHEET_ID</b> (ідентифікатор із посилання на таблицю) і за потреби <b>GOOGLE_SHEET_GID</b> — номер аркуша. Таблиця має бути відкрита для перегляду за посиланням.');

  /** Короткий рядок стану синхронізації для огляду. */
  function syncStrip(st) {
    const hl = syncHealth(st);
    if (!st || !st.configured) return notConfigured();
    const s = st.state || {};
    const bits = [];
    if (s.lastSuccessAt) bits.push(`остання успішна перевірка ${esc(fmt.rel(s.lastSuccessAt))}`);
    if (s.nextRunAt && !st.running) bits.push(`наступна ${esc(until(s.nextRunAt))}`);
    const busy = A.sync.busy || st.running;
    return `<div class="card row a-strip"><span class="tile-ic">${ic('sheet', 20)}</span>
      <div class="grow"><div class="hstack wrap" style="gap:8px"><b>Google-таблиця</b>${badge(hl.text, hl.cls)}</div>
        <div class="muted small">${bits.join(' · ') || 'Даних про перевірки ще немає'}${hl.cls === 'red' && s.lastError ? `<div class="err">${esc(s.lastError)}</div>` : ''}</div></div>
      <div class="btn-row"><button class="btn small soft auto" data-act="aSyncRun" ${busy ? 'disabled' : ''}>${ic('refresh', 16)} ${busy ? 'Синхронізація…' : 'Синхронізувати'}</button>
        <button class="btn small ghost auto" data-act="go" data-tab="admin" data-sub="sync">Деталі</button></div></div>`;
  }

  // ───────────── огляд ─────────────

  function viewOverview() {
    if (A.dashErr && !A.dash) return ui.error(A.dashErr, 'aReloadDash');
    const d = A.dash;
    if (!d) return `<div class="grid k4">${ui.skeleton(8, 104)}</div>${ui.skeleton(2, 240)}`;
    const k = d.kpis;
    const imp = k.improvement7d || {};
    let h = '';
    if (k.openConflicts) {
      h += ui.notice('warn', `Відкритих конфліктів із Google-таблицею: <b>${k.openConflicts}</b>. Таблиця пропонує нижчі бали, ніж зараз у журналі, — потрібне ваше рішення. <button class="link" data-act="go" data-tab="admin" data-sub="conflicts">Переглянути</button>`);
    }
    h += syncStrip(d.sync);
    const top = k.highestTotal;
    const low = k.lowestTotal;
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Студентів у рейтингу', value: String(k.students), icon: 'users', act: 'go', attrs: 'data-tab="admin" data-sub="students"', sub: `груп: ${k.groups}${k.archived ? ` · в архіві: ${k.archived}` : ''}` })}
      ${ui.kpi({ label: 'Облікові записи', value: String(k.accounts), icon: 'user', tone: 'sky', sub: `прив’язано: ${k.linked} · активні за 30 днів: ${k.activeAccounts}` })}
      ${ui.kpi({ label: 'Середній загальний бал', value: num(k.avgTotal), icon: 'target', tone: 'green', sub: `за предмет: ${num(k.avgScore)} · оцінок: ${k.scores}` })}
      ${ui.kpi({ label: 'Зміна за 7 днів', value: imp.available ? esc(fmt.signed(imp.avg)) : '—', icon: 'chart', tone: imp.available && imp.avg < 0 ? 'red' : 'green', act: 'go', attrs: 'data-tab="admin" data-sub="analytics"',
        sub: imp.available ? `у середньому на студента · порівняно: ${imp.students}` : 'З’явиться після тижня спостережень' })}
      ${ui.kpi({ label: 'Найвищий загальний бал', value: top ? num(top.value) : '—', icon: 'trophy', tone: 'warn', sub: top ? esc(top.name) : 'Немає даних', ...(top ? { act: 'aStudent', attrs: `data-id="${esc(top.studentId)}"` } : {}) })}
      ${ui.kpi({ label: 'Найнижчий загальний бал', value: low ? num(low.value) : '—', icon: 'down', tone: 'red', sub: low ? esc(low.name) : 'Немає даних', ...(low ? { act: 'aStudent', attrs: `data-id="${esc(low.studentId)}"` } : {}) })}
      ${ui.kpi({ label: 'Предметів', value: String(k.subjects), icon: 'book', tone: 'sky', act: 'catalogOpen', sub: k.highest ? `найвищий бал: ${num(k.highest.value)} (${esc(k.highest.subject)})` : 'Балів ще немає' })}
      ${ui.kpi({ label: 'Відкриті конфлікти', value: String(k.openConflicts), icon: 'alert', tone: k.openConflicts ? 'red' : 'green', act: 'go', attrs: 'data-tab="admin" data-sub="conflicts"', sub: k.openConflicts ? 'потрібне рішення' : 'дані узгоджені з таблицею' })}
    </div>`;
    const act = d.activity || [];
    h += `<div class="grid c2">
      ${box('Активність за 14 днів', 'Кількість змін балів за джерелами', activityBars(act, (a) => fmt.shortDay(a.date), (a) => fmt.longDay(a.date)) + legend(SRC_SERIES))}
      ${box('Розподіл студентів', `За середнім балом у відсотках від максимуму предмета${d.unscored ? ` · без балів: ${d.unscored}` : ''}`, distributionChart(d.distribution || []))}
    </div>
    <div class="grid c2">
      ${box('Предмети', 'Середній бал серед студентів', subjectBars(d.bySubject), '<button class="link" data-act="catalogOpen">Налаштувати</button>')}
      ${box('Групи', 'Середні показники активних студентів', groupTable(d.byGroup))}
    </div>
    <div class="grid c2">
      ${box('Найбільше зростання', 'Загальний бал за 7 днів', moverList(d.improvers, 'За тиждень зростання ще не було.'))}
      ${box('Найбільше зниження', 'Загальний бал за 7 днів', moverList(d.decliners, 'За тиждень зниження не було.'))}
    </div>`;
    h += box('Остання активність', 'Зміни балів і дії в системі', d.recent && d.recent.length ? `<div class="feed">${d.recent.map(recentItem).join('')}</div>` : '<div class="muted small">Подій ще немає.</div>',
      '<div class="hstack"><button class="link" data-act="go" data-tab="admin" data-sub="history">Історія балів</button><button class="link" data-act="go" data-tab="admin" data-sub="audit">Журнал дій</button></div>');
    return h;
  }

  // ───────────── аналітика ─────────────

  const RANGES = [['today', 'Сьогодні'], ['7d', '7 днів'], ['30d', '30 днів'], ['90d', '3 місяці'], ['custom', 'Період']];

  function viewAnalytics() {
    const groups = A.groups || [];
    let h = `<div class="toolbar">${ui.seg(RANGES, A.anRange, 'aRange')}
      <select class="field" id="aAnGroup" data-chg="aAnGroup" aria-label="Група"><option value="">Усі групи</option>${groups.map((g) => opt(g.name, `${g.name} · ${g.students}`, A.anGroup)).join('')}</select>
      ${A.anLoading ? '<span class="spin"></span>' : ''}</div>`;
    if (A.anRange === 'custom') {
      h += `<div class="toolbar"><input class="field" type="date" id="aAnFrom" value="${esc(A.anFrom)}" max="${daysAgo(0)}" aria-label="Початок періоду">
        <input class="field" type="date" id="aAnTo" value="${esc(A.anTo)}" max="${daysAgo(0)}" aria-label="Кінець періоду">
        <button class="btn small auto" data-act="aRangeApply">Показати</button></div>`;
    }
    if (A.anErr) return h + ui.error(A.anErr, 'aReloadAn');
    const a = A.an;
    if (!a) return h + `<div class="grid k4">${ui.skeleton(4, 104)}</div>${ui.skeleton(2, 240)}`;

    const days = a.activity.day || [];
    const sum = (k) => days.reduce((s, d) => s + (d[k] || 0), 0);
    const students = a.byGroup.reduce((s, g) => s + g.students, 0);
    const wavg = (f) => { let n = 0; let t = 0; for (const g of a.byGroup) if (g[f] != null) { n += g.students; t += g[f] * g.students; } return n ? round2(t / n) : null; };
    const tr = a.trend.filter((t) => t.avgTotal != null);
    const trDelta = tr.length > 1 ? round2(tr[tr.length - 1].avgTotal - tr[0].avgTotal) : null;
    const rangeName = a.range.range === 'custom' ? `${fmt.longDay(a.range.from)} – ${fmt.longDay(a.range.to)}` : (RANGES.find((r) => r[0] === a.range.range) || [])[1];
    h += `<div class="muted small">Період: ${esc(rangeName || '')}${a.group ? ` · група ${esc(a.group)}` : ' · усі групи'}</div>`;
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Студентів', value: String(students), icon: 'users', sub: `груп: ${a.byGroup.length}` })}
      ${ui.kpi({ label: 'Середній загальний бал', value: num(wavg('avgTotal')), icon: 'target', tone: 'green', sub: trDelta != null ? `${ui.delta(trDelta)} за період` : 'Динаміка з’явиться згодом' })}
      ${ui.kpi({ label: 'Змін балів', value: String(sum('total')), icon: 'refresh', tone: 'sky', sub: `студентами: ${sum('student')} · з таблиці: ${sum('sheet')} · адміністратором: ${sum('admin')}` })}
      ${ui.kpi({ label: 'Середній бал за предмет', value: num(wavg('avgScore')), icon: 'bars', tone: 'warn', sub: a.compared ? `порівняно студентів: ${a.compared}` : 'Немає даних на початок періоду' })}
    </div>`;

    const multi = !a.group && a.trendGroups.length > 1;
    const series = [{ name: multi ? 'Усі групи' : 'Середній загальний бал', color: 'var(--c1)', values: a.trend.map((t) => t.avgTotal) }];
    if (multi) a.trendGroups.slice(0, 5).forEach((g, i) => series.push({ name: g, color: `var(--c${i + 2})`, values: a.trend.map((t) => (t.groups[g] ? t.groups[g].avgTotal : null)) }));
    const trend = Charts.line({
      labels: a.trend.map((t) => fmt.shortDay(t.date)), tipLabels: a.trend.map((t) => fmt.longDay(t.date)), series, area: !multi, height: 240,
      empty: 'За цей період ще немає щоденних знімків — вони з’являються після кожної доби роботи', label: 'Середній загальний бал',
    });
    const per = a.activity[A.anPeriod] || [];
    const lab = (b) => (A.anPeriod === 'day' ? fmt.shortDay(b.date) : A.anPeriod === 'week' ? 'тиж. ' + fmt.shortDay(b.label) : fmt.month(b.label));
    const tip = (b) => (A.anPeriod === 'day' ? fmt.longDay(b.date) : A.anPeriod === 'week' ? 'Тиждень з ' + fmt.longDay(b.label) : fmt.month(b.label));
    h += `<div class="grid c2">
      ${box('Динаміка середнього загального балу', multi ? 'Усі групи разом і кожна окремо' : 'Значення на кінець кожного дня', trend + (multi ? legend(series.map((x) => ['', x.name, x.color])) : ''))}
      ${box('Активність', 'Кількість змін балів за джерелами', activityBars(per, lab, tip) + legend(SRC_SERIES), ui.seg([['day', 'Дні'], ['week', 'Тижні'], ['month', 'Місяці']], A.anPeriod, 'aPeriod'))}
    </div>`;

    const si = a.subjectImprovement.filter((x) => x.students);
    const siChart = Charts.bars({
      labels: si.map((x) => x.key), tipLabels: si.map((x) => subjLabel(x)), series: [{ name: 'Середня зміна', values: si.map((x) => x.avgDelta) }],
      signed: true, height: 220, empty: 'Немає даних для порівняння за цей період', label: 'Зміна середнього балу за предметами',
    });
    const siTable = si.length ? `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr><th>Предмет</th><th class="r">Порівняно</th><th class="r">Сер. зміна</th><th class="r">Зросли</th><th class="r">Знизились</th></tr></thead><tbody>
      ${si.map((x) => `<tr><td class="head"><span class="name">${esc(x.key)}</span>${x.title !== x.key ? `<span class="sub">${esc(x.title)}</span>` : ''}</td><td class="r" data-label="Порівняно">${x.students}</td><td class="r" data-label="Сер. зміна">${ui.delta(x.avgDelta)}</td><td class="r" data-label="Зросли">${x.improved}</td><td class="r" data-label="Знизились">${x.declined}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    h += `<div class="grid c2">${box('Прогрес за предметами', 'Середня зміна балу студента за період', siChart)}${box('Деталі за предметами', 'Скільки студентів покращили чи погіршили результат', siTable || '<div class="muted small">Немає даних для порівняння.</div>')}</div>`;

    const moves = a.rankMoves.length ? `<div class="feed">${a.rankMoves.map((m) => `<div class="feed-item"><div class="feed-body"><span class="t">${who(m.studentId, m.name)}</span><span class="d">${esc(m.group)} · місце ${m.from} → ${m.to}</span></div>
      <div class="feed-side">${ui.delta(m.change, { text: `${Math.abs(m.change)} поз.` })}</div></div>`).join('')}</div>` : '<div class="muted small">Місця в рейтингу за період не змінилися.</div>';
    h += `<div class="grid c3">
      ${box('Найбільше зростання', 'Загальний бал за період', moverList(a.improvers, 'Зростання за період не було.'))}
      ${box('Найбільше зниження', 'Загальний бал за період', moverList(a.decliners, 'Зниження за період не було.'))}
      ${box('Зміни місць у рейтингу', 'Найбільші переміщення', moves)}
    </div>`;
    h += `<div class="grid c2">
      ${box('Середній бал за предметами', 'На кінець періоду', subjectBars(a.bySubject))}
      ${box('Розподіл студентів', 'За середнім балом у відсотках від максимуму', distributionChart(a.distribution || []))}
    </div>`;
    h += box('Групи', 'Середні показники на кінець періоду', groupTable(a.byGroup));
    return h;
  }

  // ───────────── студенти ─────────────

  function th(k, title, cls = '') {
    const d = A.st.data;
    const on = d && d.sort === k;
    const dir = on ? (d.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="sortable ${on ? 'sorted' : ''} ${cls}" data-act="aStSort" data-k="${k}" aria-sort="${dir}">${esc(title)}${on ? (d.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`;
  }

  function viewStudents() {
    const F = A.st;
    const d = F.data;
    const groups = d ? d.groups : [];
    const subjects = d ? d.subjects : [];
    let h = `<div class="toolbar">
      <input class="field search" id="aStQ" type="search" placeholder="Пошук за ПІБ" value="${esc(F.q)}" data-inp="aStQ" autocomplete="off" aria-label="Пошук за ПІБ">
      <select class="field" id="aStStatus" data-chg="aStFilter" data-k="status" aria-label="Стан">${opt('active', 'Активні', F.status)}${opt('archived', 'Архів', F.status)}${opt('all', 'Усі', F.status)}</select>
      <select class="field" id="aStGroup" data-chg="aStFilter" data-k="group" aria-label="Група"><option value="">Усі групи</option>${groups.map((g) => opt(g, g, F.group)).join('')}</select>
      <select class="field" id="aStSubject" data-chg="aStFilter" data-k="subject" aria-label="Предмет"><option value="">Загальний бал</option>${subjects.map((x) => opt(x.key, subjLabel(x), F.subject)).join('')}</select>
    </div>`;
    if (F.err) return h + ui.error(F.err, 'aReloadSt');
    if (!d) return h + ui.skeleton(6, 56);
    const filtered = F.q || F.group || F.status !== 'active';
    if (!d.items.length) {
      return h + ui.empty('users', filtered ? 'Нікого не знайдено' : 'Студентів ще немає',
        filtered ? 'Змініть умови пошуку або фільтри.' : 'Студенти з’являться після синхронізації з Google-таблицею або імпорту файлу.');
    }
    const subj = d.subject;
    h += `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr>${th('rank', 'Місце', 'c')}${th('name', 'Студент')}${th('total', 'Разом', 'r')}${th('avg', 'Середній', 'r')}<th class="r">Предметів</th>${th('delta', 'За 7 днів', 'r')}${subj ? th('subject', subj, 'r') : ''}${th('updated', 'Оновлено', 'r')}</tr></thead><tbody>
      ${d.items.map((r) => `<tr class="click" data-act="aStudent" data-id="${esc(r.id)}">
        <td class="c" data-label="Місце">${r.rank != null ? `<span><b>${r.rank}</b><span class="xs muted"> з ${r.of}</span></span>` : '—'}</td>
        <td class="head"><span>${who(r.id, r.fullName)}${!r.active ? ' ' + badge('Архів', 'gray') : ''}<span class="sub">${esc(r.group)} · ${r.accounts.length ? esc(plural(r.accounts.length, 'обліковий запис', 'облікові записи', 'облікових записів')) : 'без облікового запису'}</span></span></td>
        <td class="r" data-label="Разом"><b>${num(r.total)}</b></td>
        <td class="r" data-label="Середній">${num(r.avg)}</td>
        <td class="r" data-label="Предметів">${r.count}</td>
        <td class="r" data-label="За 7 днів">${r.delta7 == null ? '<span class="faint">—</span>' : ui.delta(r.delta7)}</td>
        ${subj ? `<td class="r" data-label="${esc(subj)}"><span>${num(r.subjectValue)}${r.subjectRank ? `<span class="xs muted"> · ${r.subjectRank} місце</span>` : ''}</span></td>` : ''}
        <td class="r nowrap" data-label="Оновлено">${when(r.updatedAt)}</td></tr>`).join('')}
    </tbody></table></div>${ui.pager(d, 'aStPage')}`;
    return h;
  }

  // ───────────── картка студента ─────────────

  function conflictCard(c, { inStudent = false } = {}) {
    const open = c.status === 'open';
    const cur = c.currentValue !== undefined && (c.currentValue !== null || c.currentSource) ? c.currentValue : c.effectiveValue;
    const curSrc = open ? (c.currentSource || c.effectiveSource) : c.effectiveSource;
    const before = open ? cur : (c.effectiveAtResolution != null ? c.effectiveAtResolution : c.effectiveValue);
    const seen = (c.sheetValues || []).length > 1 ? `<div class="xs muted">Значення в таблиці змінювалися: ${c.sheetValues.map((v) => `${num(v.value)} (${esc(fmt.dateTime(v.at))})`).join(', ')}</div>` : '';
    const id = esc(c.id);
    return `<div class="card a-conf ${open ? 'open' : ''}">
      <div class="card-head"><div>${inStudent ? `<div class="card-title">${esc(c.subject)}</div>` : `<div class="card-title">${who(c.studentId, c.studentName)}</div>`}
          <div class="card-sub">${inStudent ? '' : `${esc(c.group)} · предмет <b>${esc(c.subject)}</b> · `}виявлено ${esc(fmt.dateTime(c.detectedAt))}</div></div>
        ${open ? badge('Відкритий', 'warn') : badge(RESOLUTION[c.resolution] || 'Розв’язано', 'gray')}</div>
      <div class="cmp">
        <div><span class="label">У таблиці</span><b>${c.sheetPrev != null && c.sheetPrev !== c.sheetValue ? `<s>${num(c.sheetPrev)}</s> → ` : ''}${num(c.sheetValue)}</b></div>
        <div><span class="label">${open ? 'Зараз у журналі' : 'Було в журналі'}</span><b>${num(before)}</b>${curSrc ? `<span>${ui.src(curSrc)}</span>` : ''}</div>
        ${open ? '' : `<div><span class="label">Рішення</span><b>${num(c.resolvedValue)}</b><span class="xs muted">${esc(c.resolvedByName || '')}${c.resolvedAt ? ' · ' + esc(fmt.dateTime(c.resolvedAt)) : ''}</span></div>`}
      </div>${seen}
      ${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ''}
      ${open ? `<div class="btn-row">
        <button class="btn small" data-act="aResolve" data-id="${id}" data-r="accept_sheet">Прийняти ${num(c.sheetValue)}</button>
        <button class="btn small ghost" data-act="aResolve" data-id="${id}" data-r="keep_current">Залишити ${num(cur)}</button>
        <button class="btn small ghost" data-act="aResolve" data-id="${id}" data-r="custom">Інше значення…</button></div>` : ''}
    </div>`;
  }

  function viewStudent() {
    const T = A.stu;
    if (!T.id) return ui.empty('users', 'Студента не обрано', 'Оберіть студента у списку.', '<button class="btn auto" data-act="go" data-tab="admin" data-sub="students">До списку студентів</button>');
    if (T.err && !T.data) return ui.error(T.err, 'aReloadStu');
    const p = T.data;
    if (!p) return ui.skeleton(4, 120);
    const s = p.student;
    const st = p.stats;
    const c = st.current;
    const w = st.weekly || {};
    const m = st.monthly || {};
    const openC = p.conflicts.filter((x) => x.status === 'open');
    let h = `<div class="card"><div class="a-head"><span class="ava lg">${esc(D.initialsOf(s.fullName))}</span><div class="grow">
        <div class="h2">${esc(s.fullName)}</div>
        <div class="muted small">${esc(s.group)}${s.sheetRow != null ? ` · рядок у таблиці: №${esc(s.sheetRow)}` : ''}${s.note ? ' · ' + esc(s.note) : ''}</div>
        <div class="pills a-badges">${s.active ? badge('Активний') : badge('Архів', 'gray')}${s.fromSheet ? badge('З Google-таблиці', 'sky') : ''}${openC.length ? badge(`Конфлікти: ${openC.length}`, 'warn') : ''}</div></div></div>
      ${!s.active ? ui.notice('warn', `Запис архівовано ${esc(fmt.dateTime(s.archivedAt))}${s.archivedReason ? ': ' + esc(s.archivedReason) : ''}. Студент не бере участі в рейтингу й не може змінювати бали.`) : ''}
      ${s.sheetRemark ? `<div class="small muted">Примітка з таблиці: ${esc(s.sheetRemark)}</div>` : ''}
      <div class="btn-row">
        <button class="btn small soft" data-act="aFix">${ic('edit', 16)} Виправити бал</button>
        <button class="btn small ghost" data-act="aEdit">${ic('user', 16)} Дані студента</button>
        <button class="btn small ghost" data-act="aStuHistory">${ic('clock', 16)} Уся історія</button>
        <button class="btn small ghost" data-act="aArchive">${ic('archive', 16)} ${s.active ? 'Архівувати' : 'Відновити'}</button>
      </div></div>`;
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Загальний бал', value: num(c.total), icon: 'target', sub: w.available ? `${ui.delta(w.delta)} за тиждень` : 'Динаміка з’явиться згодом' })}
      ${ui.kpi({ label: 'Місце в групі', value: c.rank != null ? String(c.rank) : '—', unit: c.rank != null ? `з ${c.of}` : '', icon: 'trophy', tone: 'warn',
        sub: w.available && w.rankChange ? `${ui.delta(w.rankChange, { text: `${Math.abs(w.rankChange)} поз.` })} за тиждень` : w.available ? 'Без змін за тиждень' : '&nbsp;' })}
      ${ui.kpi({ label: 'Середній бал', value: num(c.avg), icon: 'bars', tone: 'sky', sub: m.available ? `${ui.delta(m.avgDelta)} за 30 днів` : '&nbsp;' })}
      ${ui.kpi({ label: 'Предметів з балами', value: String(c.count), unit: `з ${c.subjects}`, icon: 'book', tone: 'green',
        sub: p.accounts.length ? esc(plural(p.accounts.length, 'обліковий запис', 'облікові записи', 'облікових записів')) : 'Обліковий запис не прив’язано' })}
    </div>`;

    const series = st.series || [];
    const lineTotal = Charts.line({ labels: series.map((x) => fmt.shortDay(x.date)), tipLabels: series.map((x) => fmt.longDay(x.date)), series: [{ name: 'Загальний бал', color: 'var(--c1)', values: series.map((x) => x.total) }], area: true, height: 200, label: 'Загальний бал за 30 днів' });
    const lineRank = Charts.line({ labels: series.map((x) => fmt.shortDay(x.date)), tipLabels: series.map((x) => fmt.longDay(x.date)), series: [{ name: 'Місце', color: 'var(--c4)', values: series.map((x) => x.rank) }], invert: true, integer: true, min: 1, height: 200, format: (v) => (v == null ? '—' : `${Math.round(v)}`), label: 'Місце в групі' });
    h += `<div class="grid c2">${box('Загальний бал', 'Останні 30 днів', lineTotal)}${box('Місце в групі', 'Чим вище лінія, тим краще місце', lineRank)}</div>`;

    h += box('Бали за предметами', 'Поточне значення, джерело останньої зміни й значення в Google-таблиці', `<div class="tbl-wrap stack"><table class="tbl stack">
      <thead><tr><th>Предмет</th><th class="r">Бал</th><th>Джерело</th><th class="r">У таблиці</th><th class="r">Місце</th><th class="r">Оновлено</th><th></th></tr></thead><tbody>
      ${st.subjects.map((x) => `<tr>
        <td class="head"><span><span class="name">${esc(x.key)}</span>${x.underReview ? ' ' + badge('Конфлікт', 'warn') : ''}${x.active ? '' : ' ' + badge('Неактивний', 'gray')}${x.title !== x.key ? `<span class="sub">${esc(x.title)}</span>` : ''}</span></td>
        <td class="r" data-label="Бал"><span><b>${num(x.value)}</b><span class="xs muted"> / ${num(x.max)}</span></span></td>
        <td data-label="Джерело"><span>${x.source ? ui.src(x.source) : '<span class="faint">—</span>'}${x.studentIncrease > 0 ? `<span class="sub">студент підвищив на ${num(x.studentIncrease)}</span>` : ''}</span></td>
        <td class="r" data-label="У таблиці">${x.sheet == null ? '<span class="faint">—</span>' : num(x.sheet)}</td>
        <td class="r" data-label="Місце">${x.rank != null ? `<span>${x.rank} <span class="xs muted">з ${x.of}</span></span>` : '—'}</td>
        <td class="r nowrap" data-label="Оновлено">${when(x.updatedAt)}</td>
        <td class="r"><button class="btn small ghost auto" data-act="aFix" data-key="${esc(x.key)}">${ic('edit', 15)} Виправити</button></td></tr>`).join('')}
      </tbody></table></div>`);

    if (p.conflicts.length) {
      h += `<div class="section"><div class="sec-head"><h2>Конфлікти з таблицею</h2></div><div class="grid c2">${p.conflicts.map((x) => conflictCard(x, { inStudent: true })).join('')}</div></div>`;
    }

    const acc = p.accounts.length
      ? `<div class="feed">${p.accounts.map((a) => `<div class="feed-item"><span class="feed-ic">${ic('user', 17)}</span><div class="feed-body"><span class="t">${esc(a.fullName)}</span>
          <span class="d">${a.role ? esc(ROLE[a.role] || a.role) + ' · ' : ''}пристроїв: ${a.devices} · востаннє в застосунку: ${a.lastSeenAt ? esc(fmt.rel(a.lastSeenAt)) : 'невідомо'}</span></div></div>`).join('')}</div>`
      : '<div class="muted small">Жоден обліковий запис не прив’язано. Прив’язати можна в розділі «Керування → Учасники та пристрої».</div>';
    h += `<div class="grid c2">
      ${box('Останні зміни балів', '', p.recent.length ? `<div class="feed">${p.recent.map((x) => histItem(x)).join('')}</div>` : '<div class="muted small">Змін ще не було.</div>', '<button class="link" data-act="aStuHistory">Уся історія</button>')}
      ${box('Облікові записи', 'Хто бачить ці бали в застосунку', acc)}
    </div>`;

    const act = T.activity;
    if (act) {
      const notes = act.notifications.length
        ? `<div class="feed">${act.notifications.map((n) => `<div class="feed-item"><span class="feed-ic">${ic('bell', 17)}</span><div class="feed-body"><span class="t">${esc(n.title)}</span><span class="d">${esc(n.body)}</span><span class="d">${when(n.createdAt)} · ${n.read ? 'прочитано' : 'не прочитано'}</span></div></div>`).join('')}</div>`
        : '<div class="muted small">Сповіщень студенту ще не надсилали.</div>';
      const aud = act.audit.length
        ? `<div class="feed">${act.audit.map((a) => `<div class="feed-item"><span class="feed-ic">${ic('list', 17)}</span><div class="feed-body"><span class="t">${esc(actionTitle(a.action))}</span><span class="d">${esc(a.actorName)} · ${when(a.at)}</span>${auditDetails(a) ? `<span class="d">${auditDetails(a)}</span>` : ''}</div></div>`).join('')}</div>`
        : '<div class="muted small">Дій щодо студента ще не було.</div>';
      h += `<div class="grid c2">${box('Сповіщення студенту', 'Останні 20', notes)}${box('Журнал дій', 'Останні 20 дій щодо студента', aud)}</div>`;
    }
    return h;
  }

  // ───────────── шторки картки студента ─────────────

  function openFix(key) {
    const p = A.stu.data;
    if (!p) return;
    const subjects = p.stats.subjects;
    const s = {
      title: 'Виправлення балу', auto: false, key: key || (subjects[0] && subjects[0].key),
      render: () => {
        const x = subjects.find((v) => v.key === s.key) || subjects[0];
        if (!x) return ui.notice('info', 'Предметів ще немає.');
        return `<div class="form">
          <div class="muted small">${esc(p.student.fullName)} · ${esc(p.student.group)}</div>
          <label><span class="label">Предмет</span><select class="field" name="subject" data-chg="aFixSubject">${subjects.map((v) => opt(v.key, subjLabel(v), x.key)).join('')}</select></label>
          <dl class="dl"><dt>Поточний бал</dt><dd>${num(x.value)} з ${num(x.max)}</dd>${x.source ? `<dt>Джерело</dt><dd>${ui.src(x.source)}</dd>` : ''}${x.sheet != null ? `<dt>У таблиці</dt><dd>${num(x.sheet)}</dd>` : ''}</dl>
          <label><span class="label">Новий бал (від 0 до ${num(x.max)})</span><input class="field" name="value" type="text" inputmode="decimal" autocomplete="off" placeholder="Порожнє поле — прибрати бал"></label>
          <label><span class="label">Причина виправлення</span><textarea class="field" name="reason" maxlength="300" placeholder="Наприклад: помилка під час внесення, перескладання"></textarea></label>
          <div class="muted small">Адміністратор може як підвищити, так і знизити бал. Зміну буде записано в історію з вашим ім’ям і причиною, а студент отримає сповіщення.</div>
          <div data-role="msg" class="small" hidden></div>
          <button class="btn" data-act="aFixSave">Зберегти</button></div>`;
      },
    };
    D.openSheet(s);
  }

  function openEdit() {
    const p = A.stu.data;
    if (!p) return;
    if (!A.groups) loadGroups();
    const s = {
      title: 'Дані студента', auto: true,
      render: () => {
        const g = p.student.group;
        const groups = (A.groups || []).map((x) => x.name);
        if (!groups.includes(g)) groups.unshift(g);
        return `<div class="form">
          <label><span class="label">Прізвище, ім’я та по батькові</span><input class="field" name="fullName" value="${esc(p.student.fullName)}" maxlength="100" autocomplete="off"></label>
          <label><span class="label">Група</span><select class="field" name="group">${groups.map((x) => opt(x, x, g)).join('')}</select></label>
          <label><span class="label">Примітка</span><input class="field" name="note" value="${esc(p.student.note)}" maxlength="60" placeholder="Необов’язково" autocomplete="off"></label>
          ${p.student.fromSheet ? ui.notice('info', 'Студент синхронізується з Google-таблицею за ПІБ. Якщо змінити ПІБ лише тут, під час наступної синхронізації таблиця може створити окремий запис, — виправте ПІБ і в таблиці.') : ''}
          <div data-role="msg" class="small" hidden></div>
          <button class="btn" data-act="aEditSave">Зберегти</button></div>`;
      },
    };
    D.openSheet(s);
  }

  /** Підтвердження з необов’язковим текстовим полем (замість системного prompt). */
  function askSheet(o) {
    const s = {
      title: o.title, auto: false, onOk: o.onOk,
      render: () => `<div class="form"><div>${esc(o.text)}</div>
        ${o.field ? `<label><span class="label">${esc(o.field)}</span><input class="field" name="askValue" maxlength="200" placeholder="${esc(o.placeholder || '')}" autocomplete="off"></label>` : ''}
        <div data-role="msg" class="small" hidden></div>
        <button class="btn ${o.danger ? 'red' : ''}" data-act="aAskOk">${esc(o.confirm || 'Підтвердити')}</button></div>`,
    };
    D.openSheet(s);
  }

  async function setArchived(archived, reason) {
    const id = A.stu.id;
    await api('POST', `/api/admin/students/${enc(id)}/archive`, { archived, reason });
    toast(archived ? 'Студента архівовано' : 'Студента відновлено');
    A.st.data = null;
    loadStudent();
  }

  // ───────────── групи ─────────────

  async function loadGroupsPage() {
    try {
      const list = await latest('grp', '/api/admin/groups');
      Object.assign(A.grp, { data: list, err: '' });
      A.groups = list;
    } catch (e) { if (e === STALE) return; A.grp.err = e.message; }
    render();
  }

  const grpMsg = (text, cls = 'err') => { Object.assign(A.grp, { msg: text, msgCls: cls }); render(); };

  /** Після зміни груп: свіжий список і перезавантаження сторінок, що від груп залежать. */
  async function afterGroupChange() {
    Object.assign(A, { dash: null, an: null });
    A.st.data = null;
    A.hist.data = null;
    await loadGroupsPage();
    const names = new Set((A.grp.data || []).map((g) => g.name));
    if (A.st.group && !names.has(A.st.group)) A.st.group = '';
    if (A.anGroup && !names.has(A.anGroup)) A.anGroup = '';
    if (A.hist.group && !names.has(A.hist.group)) A.hist.group = '';
    D.loadRating(S.rating.group && names.has(S.rating.group) ? S.rating.group : '', true);
  }

  function groupCard(g) {
    const editing = A.grp.edit === g.name;
    const name = esc(g.name);
    return `<div class="card a-group">
      <div class="a-group-head"><div class="grow"><div class="card-title a-group-name">${name}</div>
          <div class="card-sub">Студентів: <b>${g.students}</b>${g.archived ? ` · в архіві: <b>${g.archived}</b>` : ''} · облікових записів: <b>${g.accounts}</b></div></div>
        ${g.synced ? badge('Google-таблиця', 'sky') : ''}</div>
      ${editing ? `<div class="a-inline-form">
          <input class="field" id="aGrpRename" data-inp="aGrpRenameInp" maxlength="40" value="${esc(A.grp.renameDraft)}" autocomplete="off" aria-label="Нова назва групи «${name}»">
          <div class="btn-row"><button class="btn small auto" data-act="aGrpRenameSave" data-name="${name}">Зберегти</button>
            <button class="btn small ghost auto" data-act="aGrpRenameCancel">Скасувати</button></div></div>
        ${A.grp.editMsg ? `<div class="err small" role="alert">${esc(A.grp.editMsg)}</div>` : ''}
        ${g.synced ? '<div class="muted small">Після перейменування синхронізація з Google-таблицею й далі оновлюватиме цю групу під новою назвою.</div>' : ''}` : ''}
      <div class="btn-row a-group-actions">
        <button class="btn small ghost auto" data-act="aGrpStudents" data-name="${name}">${ic('users', 16)} Студенти</button>
        ${editing ? '' : `<button class="btn small ghost auto" data-act="aGrpEdit" data-name="${name}">${ic('edit', 16)} Перейменувати</button>`}
        ${g.synced ? '' : `<button class="btn small ghost auto a-danger" data-act="aGrpDel" data-name="${name}">${ic('trash', 16)} Видалити</button>`}
      </div>
      ${g.synced ? '<div class="muted xs">Цю групу заповнює Google-таблиця, тому видалити її не можна.</div>' : ''}
    </div>`;
  }

  function viewGroups() {
    const G = A.grp;
    let h = `<div class="card"><div class="card-title">Нова група</div>
      <div class="a-inline-form"><input class="field" id="aGrpNew" data-inp="aGrpNewInp" maxlength="40" value="${esc(G.draft)}" placeholder="Наприклад: 102 СПД" autocomplete="off" aria-label="Назва нової групи">
        <button class="btn auto" data-act="aGrpAdd">${ic('plus', 18)} Додати групу</button></div>
      <div class="muted small">Від 2 до 40 символів: літери, цифри, пробіли та знаки - . / ( ) ’ №. Дві групи з однаковою назвою (незалежно від великих і малих літер) створити не можна.</div>
      ${G.msg ? `<div class="${G.msgCls} small" role="alert">${esc(G.msg)}</div>` : ''}</div>`;
    if (G.err && !G.data) return h + ui.error(G.err, 'aReloadGrp');
    if (!G.data) return h + ui.skeleton(3, 96);
    if (!G.data.length) return h + ui.empty('layers', 'Груп ще немає', 'Створіть першу групу або запустіть синхронізацію з Google-таблицею.');
    return `${h}<div class="sec-head"><h2>Усі групи</h2><span class="muted small">${esc(plural(G.data.length, 'група', 'групи', 'груп'))}</span></div>
      <div class="grid c2">${G.data.map(groupCard).join('')}</div>
      <div class="foot">Видалення групи ніколи не видаляє студентів: якщо в групі є студенти чи облікові записи, їх буде перенесено до іншої групи разом із балами, історією й статистикою.</div>`;
  }

  function openGroupDelete(name) {
    const g = (A.grp.data || []).find((x) => x.name === name);
    if (!g) return;
    const others = (A.grp.data || []).filter((x) => x.name !== name);
    const people = g.students + g.archived;
    D.openSheet({
      title: 'Видалення групи', auto: false, g,
      render: () => {
        if (!people && !g.accounts) {
          return `<div class="form"><div>Видалити групу <b>«${esc(g.name)}»</b>? Студентів і облікових записів у ній немає.</div>
            <div data-role="msg" class="small" hidden></div>
            <button class="btn red" data-act="aGrpDelOk">${ic('trash', 18)} Видалити групу</button></div>`;
        }
        if (!others.length) {
          return ui.notice('warn', `У групі «${esc(g.name)}» є студенти або облікові записи, а іншої групи, до якої їх можна перенести, немає. Спершу створіть таку групу.`);
        }
        return `<div class="form">
          ${ui.notice('warn', `У групі <b>«${esc(g.name)}»</b>: ${esc(plural(people, 'студент', 'студенти', 'студентів'))}${g.archived ? ` (з них в архіві: ${g.archived})` : ''} і ${esc(plural(g.accounts, 'обліковий запис', 'облікові записи', 'облікових записів'))}.`)}
          <div>Студентів і облікові записи <b>не буде видалено</b>: перед видаленням групи їх перенесуть до обраної групи разом із балами, історією змін, статистикою й прив’язками облікових записів.</div>
          <label><span class="label">Перенести до групи</span><select class="field" name="moveTo">${others.map((x) => opt(x.name, `${x.name} · ${plural(x.students, 'студент', 'студенти', 'студентів')}`, '')).join('')}</select></label>
          <div data-role="msg" class="small" hidden></div>
          <button class="btn red" data-act="aGrpDelOk">${ic('trash', 18)} Перенести студентів і видалити групу</button></div>`;
      },
    });
  }

  // ───────────── Google Sheets ─────────────

  function viewSync() {
    const Y = A.sync;
    const d = Y.data;
    if (Y.err && !d) return ui.error(Y.err, 'aReloadSync');
    if (!d) return ui.skeleton(3, 160);
    const s = d.state || {};
    const cfg = d.settings || {};
    const hl = syncHealth(d);
    const busy = Y.busy || d.running;
    let h = d.configured ? '' : notConfigured();
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    h += `<div class="card"><div class="card-head"><div><div class="hstack wrap" style="gap:8px"><span class="card-title">Google-таблиця</span>${badge(hl.text, hl.cls)}</div>
        <div class="card-sub">${esc(s.title || 'Назва ще невідома')}${s.sheetTitle ? ` · аркуш «${esc(s.sheetTitle)}»` : ''}</div></div>
      <div class="btn-row">
        <button class="btn small auto" data-act="aSyncRun" ${busy || !d.configured ? 'disabled' : ''}>${ic('refresh', 16)} ${busy ? 'Синхронізація…' : 'Синхронізувати зараз'}</button>
        <button class="btn small ghost auto" data-act="aSyncDiag" ${!d.configured ? 'disabled' : ''}>${ic('search', 16)} Перевірити доступ</button>
        ${cfg.url ? `<a class="btn small ghost auto" href="${esc(cfg.url)}" target="_blank" rel="noopener">${ic('external', 16)} Відкрити таблицю</a>` : ''}
      </div></div>
      ${hl.cls === 'red' && s.lastError ? ui.notice('err', esc(s.lastError)) : ''}
      <dl class="dl">
        <dt>Група в журналі</dt><dd>${esc(cfg.group || '—')}${cfg.configuredGroup && cfg.configuredGroup !== cfg.group ? ` <span class="muted small">(перейменовано; у налаштуваннях сервера — «${esc(cfg.configuredGroup)}»)</span>` : ''}</dd>
        <dt>Аркуш</dt><dd>${s.gid || cfg.gid ? `gid ${esc(s.gid || cfg.gid)}` : 'перший аркуш таблиці'}</dd>
        <dt>Спосіб читання</dt><dd>${esc(s.methodTitle || '—')}${cfg.serviceAccount ? ' · сервісний акаунт налаштовано' : ''}</dd>
        <dt>Остання успішна</dt><dd>${s.lastSuccessAt ? esc(fmt.dateTime(s.lastSuccessAt)) : 'ще не було'}</dd>
        <dt>Остання спроба</dt><dd>${s.lastAttemptAt ? `${esc(fmt.dateTime(s.lastAttemptAt))} ${runBadge(s.lastRunStatus)}` : '—'}</dd>
        <dt>Наступна перевірка</dt><dd>${d.configured && s.nextRunAt && !d.running ? esc(until(s.nextRunAt)) : '—'}${cfg.intervalMinutes ? ` · кожні ${cfg.intervalMinutes} хв` : ''}</dd>
        ${s.consecutiveErrors ? `<dt>Помилок поспіль</dt><dd class="err">${s.consecutiveErrors}</dd>` : ''}
      </dl>
      ${warnings.length ? `<div><div class="label" style="margin-bottom:6px">Попередження останньої синхронізації</div><ul class="warn-list">${warnings.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${warnings.length > 8 ? `<div class="xs muted">і ще ${warnings.length - 8}</div>` : ''}</div>` : ''}
      <div class="muted small">Таблиця — основне джерело балів: нові та вищі значення з неї застосовуються автоматично. Якщо таблиця пропонує нижчий бал для предмета, який востаннє змінив студент або адміністратор, бал не перезаписується — створюється конфлікт для вашого рішення. Студентів, яких більше немає в таблиці, буде архівовано, а не видалено.</div>
      ${d.configured ? `<div><button class="link" style="padding-left:0" data-act="aSyncRun" data-force="1" ${busy ? 'disabled' : ''}>Примусово обробити всю таблицю ще раз</button></div>` : ''}
    </div>`;

    const t = d.totals30 || {};
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Запусків за 30 днів', value: String(t.runs || 0), icon: 'refresh', sub: t.errors ? `<span class="err">з помилкою: ${t.errors}</span>` : 'без помилок' })}
      ${ui.kpi({ label: 'Змінено балів', value: String(t.changedScores || 0), icon: 'target', tone: 'green', sub: `оновлено студентів: ${t.updatedStudents || 0}` })}
      ${ui.kpi({ label: 'Нових студентів', value: String(t.newStudents || 0), icon: 'users', tone: 'sky', sub: `архівовано: ${t.archived || 0}` })}
      ${ui.kpi({ label: 'Виявлено конфліктів', value: String(t.conflicts || 0), icon: 'alert', tone: d.openConflicts ? 'red' : 'warn', act: 'go', attrs: 'data-tab="admin" data-sub="conflicts"', sub: `відкритих зараз: ${d.openConflicts}` })}
    </div>`;

    const dg = Y.diag || s.lastDiagnostics;
    if (dg && Array.isArray(dg.checks)) {
      const row = (c) => `<div class="check-row"><span class="ck ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}">${ic(c.ok === true ? 'check' : c.ok === false ? 'xc' : 'info', 16)}</span>
        <div class="grow"><b class="small">${esc(c.label)}</b><div class="xs muted">${esc(c.detail || '')}</div></div>${c.ms ? `<span class="xs muted nowrap">${c.ms} мс</span>` : ''}</div>`;
      h += box('Перевірка доступу', `${dg.accessible ? 'Таблиця доступна' : 'Таблиця недоступна'}${dg.methodTitle ? ' · ' + esc(dg.methodTitle) : ''} · ${esc(fmt.dateTime(dg.checkedAt))}`,
        `<div class="checks">${dg.checks.map(row).join('')}</div>${dg.sheets && dg.sheets.length ? `<div class="xs muted">Аркуші таблиці: ${dg.sheets.map((x) => `${esc(x.name)} (gid ${esc(x.gid)})`).join(', ')}</div>` : ''}`);
    }

    const r = Y.runs || d.runs;
    h += `<div class="section"><div class="sec-head"><h2>Журнал синхронізацій</h2></div>
      <div class="toolbar">${ui.seg([['', 'Усі'], ['success', 'Зі змінами'], ['unchanged', 'Без змін'], ['error', 'Помилки']], Y.runsStatus, 'aRunsFilter')}</div>`;
    if (!r || !r.items.length) {
      h += ui.empty('sheet', 'Запусків ще не було', Y.runsStatus ? 'Немає запусків із таким результатом.' : 'Перша синхронізація відбудеться автоматично після запуску сервера.');
    } else {
      h += `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr><th>Час</th><th>Запуск</th><th>Результат</th><th class="r">Рядків</th><th class="r">Змінено балів</th><th class="r">Нових</th><th class="r">Конфлікти</th><th class="r">Архів</th><th class="r">Тривалість</th></tr></thead><tbody>
        ${r.items.map((x) => {
          const st = x.stats || {};
          return `<tr class="click" data-act="aRun" data-id="${esc(x.id)}">
            <td class="head nowrap"><span>${esc(fmt.dateTime(x.startedAt))}${x.repeats ? `<span class="sub">і ще ${esc(plural(x.repeats, 'перевірка', 'перевірки', 'перевірок'))} без змін, остання ${esc(fmt.rel(x.lastRepeatAt))}</span>` : ''}</span></td>
            <td data-label="Запуск"><span>${esc(RUN_KIND[x.kind] || x.kind)}${x.forced ? ' · примусово' : ''}${x.kind === 'manual' && x.actorName ? `<span class="sub">${esc(x.actorName)}</span>` : ''}</span></td>
            <td data-label="Результат"><span>${runBadge(x.status)}${x.warnings.length ? ` <span class="xs muted" title="Попередження">${ic('alert', 12)} ${x.warnings.length}</span>` : ''}</span></td>
            <td class="r" data-label="Рядків">${st.rows || 0}</td><td class="r" data-label="Змінено балів">${st.changedScores || 0}</td>
            <td class="r" data-label="Нових">${st.newStudents || 0}</td><td class="r" data-label="Конфлікти">${st.conflicts || 0}</td>
            <td class="r" data-label="Архів">${st.archived || 0}</td><td class="r nowrap" data-label="Тривалість">${esc(fmt.num(round2((x.durationMs || 0) / 1000)))} с</td></tr>`;
        }).join('')}
      </tbody></table></div>${ui.pager(r, 'aRunsPage')}`;
    }
    return h + '</div>';
  }

  function openRun(id) {
    const list = ((A.sync.runs || (A.sync.data && A.sync.data.runs)) || { items: [] }).items;
    const x = list.find((r) => r.id === id);
    if (!x) return;
    const st = x.stats || {};
    const rows = [['Рядків у таблиці', st.rows], ['Нових студентів', st.newStudents], ['Оновлено студентів', st.updatedStudents], ['Без змін', st.unchangedStudents],
      ['Повернуто з архіву', st.reactivated], ['Архівовано', st.archived], ['Змінено балів', st.changedScores], ['Конфліктів', st.conflicts],
      ['Некоректних клітинок', st.invalidCells], ['Нових предметів', st.newSubjects], ['Виправлено ПІБ', st.renamed]];
    D.openSheet({
      title: 'Синхронізація', auto: false,
      render: () => `<div class="form">
        <div class="hstack wrap" style="gap:8px">${runBadge(x.status)}<span class="muted small">${esc(fmt.dateTime(x.startedAt))} · ${esc(RUN_KIND[x.kind] || x.kind)}${x.forced ? ' · примусово' : ''}${x.kind === 'manual' && x.actorName ? ' · ' + esc(x.actorName) : ''}</span></div>
        ${x.error ? ui.notice('err', esc(x.error)) : ''}
        <dl class="dl">${rows.map(([t, v]) => `<dt>${t}</dt><dd>${v || 0}</dd>`).join('')}
          <dt>Тривалість</dt><dd>${esc(fmt.num(round2((x.durationMs || 0) / 1000)))} с</dd>
          ${x.sheetTitle ? `<dt>Аркуш</dt><dd>${esc(x.sheetTitle)}${x.gid ? ` (gid ${esc(x.gid)})` : ''}</dd>` : ''}
          ${x.repeats ? `<dt>Повторних перевірок без змін</dt><dd>${x.repeats}${x.lastRepeatAt ? ` · остання ${esc(fmt.dateTime(x.lastRepeatAt))}` : ''}</dd>` : ''}</dl>
        ${x.warnings.length ? `<div><div class="label" style="margin-bottom:6px">Попередження</div><ul class="warn-list">${x.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '<div class="muted small">Попереджень немає.</div>'}
        ${st.conflicts ? '<button class="btn soft" data-act="go" data-tab="admin" data-sub="conflicts">Переглянути конфлікти</button>' : ''}</div>`,
    });
  }

  // ───────────── конфлікти ─────────────

  function viewConflicts() {
    const C = A.cf;
    const d = C.data;
    let h = ui.notice('info', 'Конфлікт виникає, коли Google-таблиця пропонує <b>нижчий</b> бал (або порожню клітинку) для предмета, який востаннє змінив студент чи адміністратор. Такий бал автоматично не перезаписується — оберіть правильне значення. Якщо в таблиці з’явиться значення, не нижче за поточне, конфлікт закриється сам.');
    h += `<div class="toolbar">${ui.seg([['open', `Відкриті${S.openConflicts ? ' · ' + S.openConflicts : ''}`], ['resolved', 'Розв’язані'], ['all', 'Усі']], C.status, 'aCfStatus')}</div>`;
    if (C.err && !d) return h + ui.error(C.err, 'aReloadCf');
    if (!d) return h + ui.skeleton(3, 150);
    if (!d.items.length) {
      return h + ui.empty('check', C.status === 'open' ? 'Відкритих конфліктів немає' : 'Конфліктів не знайдено', C.status === 'open' ? 'Дані журналу узгоджені з Google-таблицею.' : '');
    }
    return `${h}<div class="grid c2">${d.items.map((c) => conflictCard(c)).join('')}</div>${ui.pager(d, 'aCfPage')}`;
  }

  function findConflict(id) {
    const all = ((A.cf.data && A.cf.data.items) || []).concat((A.stu.data && A.stu.data.conflicts) || []);
    return all.find((c) => c.id === id);
  }

  function openResolve(id, resolution) {
    const c = findConflict(id);
    if (!c) return;
    const cur = c.currentValue !== undefined && (c.currentValue !== null || c.currentSource) ? c.currentValue : c.effectiveValue;
    const s = {
      title: 'Розв’язання конфлікту', auto: false, c, r: resolution || 'accept_sheet',
      render: () => {
        const item = (k, t, sub) => `<button class="a-opt ${s.r === k ? 'on' : ''}" data-act="aResolveOpt" data-r="${k}" aria-pressed="${s.r === k}"><b>${t}</b><span>${sub}</span></button>`;
        return `<div class="form">
          <div class="muted small">${esc(c.studentName)} · ${esc(c.group)} · предмет <b>${esc(c.subject)}</b></div>
          <div class="a-opts">
            ${item('accept_sheet', `Прийняти значення з таблиці: ${num(c.sheetValue)}`, c.sheetValue == null ? 'Бал з цього предмета буде прибрано, як у таблиці.' : 'Бал у журналі стане таким, як у таблиці.')}
            ${item('keep_current', `Залишити поточне: ${num(cur)}`, 'Бал у журналі не зміниться. Новий конфлікт з’явиться, лише якщо значення в таблиці зміниться знову.')}
            ${item('custom', 'Встановити інше значення', 'Якщо правильне значення відрізняється від обох.')}
          </div>
          ${s.r === 'custom' ? '<label><span class="label">Значення</span><input class="field" name="value" type="text" inputmode="decimal" autocomplete="off"></label>' : ''}
          <label><span class="label">Коментар</span><input class="field" name="note" maxlength="300" placeholder="Необов’язково" autocomplete="off"></label>
          <div class="muted small">Рішення буде записано в історію балів і журнал дій; якщо бал зміниться, студент отримає сповіщення.</div>
          <div data-role="msg" class="small" hidden></div>
          <button class="btn" data-act="aResolveSave">Підтвердити рішення</button></div>`;
      },
    };
    D.openSheet(s);
  }

  // ───────────── історія балів ─────────────

  function viewHistory() {
    const H = A.hist;
    const d = H.data;
    const subjects = (A.catalog && A.catalog.items) || [];
    const groups = A.groups || [];
    let h = '';
    if (H.studentId) {
      h += `<div class="notice info">${ic('user', 18)}<div class="grow">Показано зміни лише для студента <b>${esc(H.studentName)}</b>.</div><button class="link" style="padding:0" data-act="aHistAll">Показати всіх</button></div>`;
    }
    h += `<div class="toolbar">
      ${H.studentId ? '' : `<input class="field search" id="aHistQ" type="search" placeholder="Пошук за ПІБ студента" value="${esc(H.q)}" data-inp="aHistQ" autocomplete="off" aria-label="Пошук за ПІБ студента">`}
      <select class="field" id="aHistSubject" data-chg="aHistF" data-k="subject" aria-label="Предмет"><option value="">Усі предмети</option>${subjects.map((x) => opt(x.key, subjLabel(x), H.subject)).join('')}</select>
      <select class="field" id="aHistSource" data-chg="aHistF" data-k="source" aria-label="Джерело"><option value="">Усі джерела</option>${['student', 'sheet', 'admin', 'import', 'migration'].map((k) => opt(k, SRC[k], H.source)).join('')}</select>
      ${H.studentId ? '' : `<select class="field" id="aHistGroup" data-chg="aHistF" data-k="group" aria-label="Група"><option value="">Усі групи</option>${groups.map((g) => opt(g.name, g.name, H.group)).join('')}</select>`}
      <input class="field" type="date" id="aHistFrom" data-chg="aHistF" data-k="from" value="${esc(H.from)}" max="${daysAgo(0)}" aria-label="З дати">
      <input class="field" type="date" id="aHistTo" data-chg="aHistF" data-k="to" value="${esc(H.to)}" max="${daysAgo(0)}" aria-label="По дату">
    </div>`;
    if (H.err && !d) return h + ui.error(H.err, 'aReloadHist');
    if (!d) return h + ui.skeleton(6, 56);
    if (!d.items.length) return h + ui.empty('clock', 'Змін не знайдено', 'Спробуйте змінити фільтри.');
    h += `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr><th>Час</th><th>Студент</th><th>Предмет</th><th class="r">Зміна</th><th>Джерело</th><th>Хто й чому</th></tr></thead><tbody>
      ${d.items.map((x) => `<tr>
        <td class="nowrap" data-label="Час">${esc(fmt.dateTime(x.at))}</td>
        <td class="head"><span>${who(x.studentId, x.studentName)}<span class="sub">${esc(x.group || '')}</span></span></td>
        <td data-label="Предмет"><span><b>${esc(x.subjectTitle || x.subject)}</b>${x.subjectTitle && x.subjectTitle !== x.subject ? `<span class="sub">${esc(x.subject)}</span>` : ''}</span></td>
        <td class="r" data-label="Зміна"><span class="sc-cell">${ui.scoreValues(x.oldValue, x.newValue)}${ui.scoreDelta(x.oldValue, x.newValue)}</span></td>
        <td data-label="Джерело">${ui.src(x.source)}</td>
        <td data-label="Хто"><span>${esc(actorOf(x))}${x.reason ? `<span class="sub">${esc(x.reason)}</span>` : ''}</span></td></tr>`).join('')}
    </tbody></table></div>${ui.pager(d, 'aHistPage')}`;
    return h;
  }

  // ───────────── журнал дій ─────────────

  function auditDetails(a) {
    const d = a.details || {};
    const out = [];
    if (d.subject && ('from' in d || 'to' in d)) out.push(`${esc(d.subject)}: ${num(d.from)} → ${num(d.to)}`);
    else if (d.subject) out.push(esc(d.subject));
    if (a.action === 'system.migrate' && ('from' in d || 'to' in d)) out.push(`версія структури даних: ${num(d.from)} → ${num(d.to)}`);
    if (a.action === 'group.rename' && d.from) out.push(`«${esc(d.from)}» → «${esc(d.to)}»${d.synced ? ' (група Google-таблиці)' : ''}`);
    if (a.action === 'group.delete' && 'movedTo' in d) {
      out.push(d.movedTo ? `студентів (${num((d.students || 0) + (d.archived || 0))}) і облікові записи (${num(d.accounts || 0)}) перенесено до «${esc(d.movedTo)}»` : 'порожня група');
    }
    if (d.resolution) out.push(esc(RESOLUTION[d.resolution] || d.resolution) + (d.value != null ? ` (${num(d.value)})` : ''));
    if (d.reason) out.push('причина: ' + esc(d.reason));
    if (d.note) out.push('коментар: ' + esc(d.note));
    if (d.student) out.push('студент: ' + esc(d.student));
    if (d.status && /^sync\./.test(a.action)) out.push('результат: ' + esc((RUN_STATUS[d.status] || [d.status])[0]).toLowerCase());
    if (d.stats && typeof d.stats === 'object') out.push(`змінено балів: ${d.stats.changedScores || 0}, нових студентів: ${d.stats.newStudents || 0}, конфліктів: ${d.stats.conflicts || 0}`);
    if (typeof d.accessible === 'boolean') out.push(d.accessible ? 'таблиця доступна' : 'таблиця недоступна');
    if (a.action === 'catalog.update') {
      if ('maxScore' in d) out.push('максимум: ' + num(d.maxScore));
      if ('title' in d) out.push(`назва: «${esc(d.title)}»`);
      if ('active' in d) out.push(d.active ? 'активний' : 'вимкнено');
    }
    if (!out.length) {
      for (const [k, v] of Object.entries(d)) {
        if (!DETAIL_KEYS[k] || v == null || typeof v === 'object') continue;
        const val = k === 'role' ? ROLE[v] || (v ? v : 'студент') : typeof v === 'boolean' ? (v ? 'так' : 'ні') : v;
        out.push(`${DETAIL_KEYS[k]}: ${esc(val)}`);
        if (out.length >= 4) break;
      }
    }
    return out.join(' · ');
  }

  function viewAudit() {
    const U = A.aud;
    const d = U.data;
    let h = `<div class="toolbar">
      <input class="field search" id="aAudQ" type="search" placeholder="Пошук за ім’ям виконавця або об’єкта" value="${esc(U.q)}" data-inp="aAudQ" autocomplete="off" aria-label="Пошук">
      <select class="field" id="aAudAction" data-chg="aAudF" data-k="action" aria-label="Дія">${ACTION_GROUPS.map(([v, t]) => opt(v, t, U.action)).join('')}</select>
      <select class="field" id="aAudRole" data-chg="aAudF" data-k="role" aria-label="Роль"><option value="">Усі ролі</option>${Object.entries(ROLE).map(([k, t]) => opt(k, t, U.role)).join('')}</select>
      <input class="field" type="date" id="aAudFrom" data-chg="aAudF" data-k="from" value="${esc(U.from)}" max="${daysAgo(0)}" aria-label="З дати">
      <input class="field" type="date" id="aAudTo" data-chg="aAudF" data-k="to" value="${esc(U.to)}" max="${daysAgo(0)}" aria-label="По дату">
    </div>`;
    if (U.err && !d) return h + ui.error(U.err, 'aReloadAud');
    if (!d) return h + ui.skeleton(6, 56);
    if (!d.items.length) return h + ui.empty('list', 'Записів не знайдено', 'Спробуйте змінити фільтри.');
    h += `<div class="tbl-wrap stack"><table class="tbl stack"><thead><tr><th>Час</th><th>Дія</th><th>Виконавець</th><th>Об’єкт</th><th>Деталі</th></tr></thead><tbody>
      ${d.items.map((a) => {
        const t = a.target;
        const target = !t ? '<span class="faint">—</span>' : t.type === 'student' ? who(t.id, t.name) : `${esc(t.name || '—')}${TARGET[t.type] ? `<span class="sub">${TARGET[t.type]}</span>` : ''}`;
        const det = auditDetails(a);
        return `<tr>
          <td class="nowrap" data-label="Час">${esc(fmt.dateTime(a.at))}</td>
          <td class="head"><span class="name">${esc(actionTitle(a.action))}</span></td>
          <td data-label="Виконавець"><span>${esc(a.actorName || 'Система')}<span class="sub">${esc(ROLE[a.actorRole] || '')}</span></span></td>
          <td data-label="Об’єкт"><span>${target}</span></td>
          <td data-label="Деталі"><span class="small">${det || '<span class="faint">—</span>'}${a.ip ? `<span class="sub">IP ${esc(a.ip)}</span>` : ''}</span></td></tr>`;
      }).join('')}
    </tbody></table></div>${ui.pager(d, 'aAudPage')}`;
    return h;
  }

  // ───────────── предмети й імпорт (з «Керування») ─────────────

  function openCatalog() {
    const s = {
      title: 'Предмети рейтингу', auto: false, data: null, err: '',
      render: () => {
        if (s.err) return ui.notice('err', esc(s.err));
        if (!s.data) return ui.loading();
        const d = s.data;
        if (!d.items.length) return ui.empty('book', 'Предметів ще немає', 'Вони з’являться після синхронізації з Google-таблицею або імпорту файлу.');
        return `<div class="muted small">Максимальний бал обмежує підвищення студентами й використовується в аналітиці (за замовчуванням — ${num(d.defaultMax)}). Неактивні предмети не показуються студентам і не враховуються в статистиці.</div>
          ${d.items.map((x) => `<div class="card tight a-cat" data-key="${esc(x.key)}">
            <div class="spread"><b>${esc(x.key)}</b><span class="xs muted">оцінок: ${x.scores}${x.highest != null ? ` · найвищий: ${num(x.highest)}` : ''}${x.inSheet ? '' : ' · немає в таблиці'}</span></div>
            <div class="a-cat-f">
              <label><span class="label">Повна назва</span><input class="field" data-f="title" value="${esc(x.title)}" maxlength="80" placeholder="${esc(x.key)}" autocomplete="off"></label>
              <label><span class="label">Максимум</span><input class="field" data-f="max" value="${esc(x.maxScore)}" inputmode="decimal" autocomplete="off"></label>
            </div>
            <div class="spread"><label class="hstack small" style="gap:10px"><span class="toggle"><input type="checkbox" data-f="active" ${x.active ? 'checked' : ''}><span></span></span>Показувати студентам</label>
              <button class="btn small soft auto" data-act="aCatSave">Зберегти</button></div></div>`).join('')}`;
      },
    };
    D.openSheet(s);
    api('GET', '/api/admin/catalog').then((d) => { s.data = d; A.catalog = d; }).catch((e) => { s.err = e.message; }).then(() => { if (s.el && s.el.isConnected) D.rerender(s); });
  }

  function openImport() {
    D.openSheet({
      title: 'Імпорт таблиці з файлу',
      render: () => ui.notice('info', 'Основне джерело балів — Google-таблиця, яка синхронізується автоматично. Імпорт файлу потрібен, лише коли таблиця недоступна.') + D.ratingUploadBlock(),
    });
    D.loadRating(undefined, true);
  }

  // ───────────── головна (для адміністратора) ─────────────

  function homeTop() {
    if (!D.isAdmin() || !S.openConflicts) return '';
    return ui.notice('warn', `Відкритих конфліктів із Google-таблицею: <b>${S.openConflicts}</b>. <button class="link" style="padding:0" data-act="go" data-tab="admin" data-sub="conflicts">Розв’язати</button>`);
  }

  let qTimer = null;
  const debounce = (fn) => { clearTimeout(qTimer); qTimer = setTimeout(fn, 350); };
  const pageTo = (F, el, load) => { F.page = Math.max(1, parseInt(el.dataset.page, 10) || 1); toTop(); load(); };

  // ───────────── реєстрація ─────────────

  D.register({
    pages: {
      'admin/overview': { render: viewOverview, enter: () => loadDash() },
      'admin/analytics': { render: viewAnalytics, enter: () => { if (!A.groups) loadGroups(); loadAnalytics(); } },
      'admin/students': { render: viewStudents, enter: () => loadStudents() },
      'admin/student': { render: viewStudent, enter: () => loadStudent(), title: () => (A.stu.data ? A.stu.data.student.fullName : 'Студент') },
      'admin/sync': { render: viewSync, enter: () => loadSync() },
      'admin/conflicts': { render: viewConflicts, enter: () => loadConflicts() },
      'admin/groups': { render: viewGroups, enter: () => { Object.assign(A.grp, { msg: '', editMsg: '' }); return loadGroupsPage(); } },
      'admin/history': { render: viewHistory, enter: () => { ensureMeta(); loadHistory(); } },
      'admin/audit': { render: viewAudit, enter: () => loadAudit() },
    },
    hooks: {
      homeTop,
      // Кнопка «Оновити» й фонова синхронізація оновлюють і відкриту сторінку адміністрування.
      sync: () => { if (!D.isAdmin()) return; const fn = RELOAD[pageKey()]; if (fn) fn(); },
      reset: () => { Object.assign(A, blank()); },
    },
    actions: {
      aReloadDash: loadDash, aReloadAn: loadAnalytics, aReloadSt: loadStudents, aReloadStu: loadStudent,
      aReloadSync: loadSync, aReloadCf: loadConflicts, aReloadHist: loadHistory, aReloadAud: loadAudit, aReloadGrp: loadGroupsPage,

      async aGrpAdd(el) {
        const inp = $('#aGrpNew');
        const name = inp ? inp.value.trim() : '';
        if (!name) { grpMsg('Введіть назву групи.'); return; }
        await D.withBusy(el, async () => {
          try {
            const r = await api('POST', '/api/admin/groups', { name });
            Object.assign(A.grp, { msg: '', draft: '' });
            toast(`Групу «${r.name}» створено`);
            await afterGroupChange();
          } catch (e) { grpMsg(e.message); }
        });
      },
      aGrpEdit(el) {
        Object.assign(A.grp, { edit: el.dataset.name, renameDraft: el.dataset.name, msg: '', editMsg: '' });
        render();
        const i = $('#aGrpRename');
        if (i) { i.focus(); i.select(); }
      },
      aGrpRenameCancel() { Object.assign(A.grp, { edit: '', renameDraft: '', editMsg: '' }); render(); },
      async aGrpRenameSave(el) {
        const from = el.dataset.name;
        const to = (($('#aGrpRename') || {}).value || '').trim();
        if (!to) { A.grp.editMsg = 'Введіть нову назву групи.'; render(); return; }
        if (to === from) { Object.assign(A.grp, { edit: '', renameDraft: '', editMsg: '' }); render(); return; }
        await D.withBusy(el, async () => {
          try {
            const r = await api('PATCH', '/api/admin/groups', { from, to });
            Object.assign(A.grp, { edit: '', renameDraft: '', msg: '', editMsg: '' });
            toast(r.synced ? `Групу перейменовано на «${r.name}». Google-таблиця й далі оновлює цю групу.` : `Групу перейменовано на «${r.name}»`);
            if (S.rating.group === from) S.rating.group = r.name;
            if (A.st.group === from) A.st.group = r.name;
            await afterGroupChange();
          } catch (e) { A.grp.editMsg = e.message; render(); }
        });
      },
      aGrpDel(el) { openGroupDelete(el.dataset.name); },
      async aGrpDelOk(el) {
        const s = D.sheetOf(el);
        const g = s.g;
        const moveTo = field(s, 'moveTo');
        if ((g.students || g.archived || g.accounts) && !moveTo) { say(s, 'Оберіть групу, до якої перенести студентів.'); return; }
        await D.withBusy(el, async () => {
          try {
            const r = await api('DELETE', `/api/admin/groups/${enc(g.name)}${moveTo ? `?moveTo=${enc(moveTo)}` : ''}`);
            D.closeSheet();
            A.grp.msg = '';
            toast(r.movedTo ? `Групу «${g.name}» видалено, студентів перенесено до «${r.movedTo}»` : `Групу «${g.name}» видалено`);
            if (S.rating.group === g.name) S.rating.group = r.movedTo || '';
            await afterGroupChange();
          } catch (e) { say(s, e.message); }
        });
      },
      aGrpStudents(el) {
        Object.assign(A.st, { group: el.dataset.name, status: 'all', q: '', page: 1, data: null });
        D.go('admin', 'students');
      },
      aStudent(el) { openStudent(el.dataset.id); },

      aRange(el) {
        A.anRange = el.dataset.v;
        D.LS.set('adminRange', A.anRange);
        loadAnalytics();
        render();
      },
      aRangeApply() {
        const f = ($('#aAnFrom') || {}).value;
        const t = ($('#aAnTo') || {}).value;
        if (!f || !t) { toast('Вкажіть обидві дати'); return; }
        if (f > t) { toast('Початок періоду має бути не пізніше за кінець'); return; }
        A.anFrom = f;
        A.anTo = t;
        loadAnalytics();
        render();
      },
      aPeriod(el) { A.anPeriod = el.dataset.v; render(); },

      aStSort(el) {
        const F = A.st;
        const k = el.dataset.k;
        F.dir = F.data && F.data.sort === k ? (F.data.dir === 'asc' ? 'desc' : 'asc') : '';
        F.sort = k;
        F.page = 1;
        loadStudents();
      },
      aStPage(el) { pageTo(A.st, el, loadStudents); },

      aFix(el) { openFix(el.dataset.key); },
      async aFixSave(el) {
        const s = D.sheetOf(el);
        const p = A.stu.data;
        const subject = field(s, 'subject');
        const value = parseNum(field(s, 'value'));
        const reason = field(s, 'reason');
        const x = p.stats.subjects.find((v) => v.key === subject);
        if (Number.isNaN(value) || (value != null && value < 0)) { say(s, 'Введіть невід’ємне число.'); return; }
        if (value != null && x && value > x.max) { say(s, `Бал не може перевищувати максимум (${fmt.num(x.max)}).`); return; }
        if (reason.length < 3) { say(s, 'Вкажіть причину виправлення (щонайменше 3 символи).'); return; }
        if (value == null && !confirm(`Прибрати бал з предмета «${subject}»?`)) return;
        await D.withBusy(el, async () => {
          try {
            await api('PUT', `/api/admin/students/${enc(p.student.id)}/scores`, { subject, value, reason });
            toast('Бал виправлено');
            D.closeSheet();
            loadStudent();
          } catch (e) { say(s, e.message); }
        });
      },
      aEdit() { openEdit(); },
      async aEditSave(el) {
        const s = D.sheetOf(el);
        const p = A.stu.data;
        const body = { fullName: field(s, 'fullName'), group: field(s, 'group'), note: field(s, 'note') };
        await D.withBusy(el, async () => {
          try {
            await api('PATCH', `/api/admin/rating/${enc(p.student.id)}`, body);
            toast('Дані студента збережено');
            D.closeSheet();
            A.st.data = null;
            loadStudent();
          } catch (e) { say(s, e.message); }
        });
      },
      async aArchive() {
        const p = A.stu.data;
        if (!p) return;
        const s = p.student;
        if (!s.active) {
          if (!confirm(`Відновити «${s.fullName}» у рейтингу групи?`)) return;
          try { await setArchived(false, ''); } catch (e) { toast(e.message); }
          return;
        }
        askSheet({
          title: 'Архівування студента', field: 'Причина', placeholder: 'Наприклад: відрахування, переведення', confirm: 'Архівувати', danger: true,
          text: `«${s.fullName}» зникне з рейтингу групи й не зможе змінювати бали. Історію змін буде збережено, запис можна відновити.`,
          onOk: (reason) => setArchived(true, reason),
        });
      },
      async aAskOk(el) {
        const s = D.sheetOf(el);
        const inp = s.el.querySelector('[name="askValue"]');
        await D.withBusy(el, async () => {
          try { await s.onOk(inp ? inp.value.trim() : ''); D.closeSheet(); } catch (e) { say(s, e.message); }
        });
      },
      aStuHistory() {
        const p = A.stu.data;
        if (!p) return;
        Object.assign(A.hist, { studentId: p.student.id, studentName: p.student.fullName, q: '', group: '', page: 1, data: null });
        D.go('admin', 'history');
      },

      async aSyncRun(el) {
        const force = el.dataset.force === '1';
        if (force && !confirm('Повторно обробити всю таблицю, навіть якщо вона не змінилася з минулої перевірки?')) return;
        A.sync.busy = true;
        render();
        try {
          const r = await api('POST', '/api/admin/sync/run', force ? { force: true } : {});
          if (r.status) {
            S.openConflicts = r.status.openConflicts;
            if (A.sync.data) A.sync.data = Object.assign({}, A.sync.data, r.status);
          }
          toast(runSummary(r.run));
        } catch (e) { toast(e.message); }
        A.sync.busy = false;
        const k = pageKey();
        if (k === 'admin/sync') loadSync(); else if (k === 'admin/overview') loadDash(); else render();
        D.loadRating(undefined, true);
      },
      async aSyncDiag(el) {
        await D.withBusy(el, async () => {
          toast('Перевіряю доступ до таблиці…');
          try { A.sync.diag = await api('POST', '/api/admin/sync/diagnostics', {}); toast(A.sync.diag.accessible ? 'Таблиця доступна' : 'Таблиця недоступна — див. деталі'); } catch (e) { toast(e.message); }
          render();
        });
      },
      aRun(el) { openRun(el.dataset.id); },
      aRunsFilter(el) { A.sync.runsStatus = el.dataset.v; loadRuns(1); },
      aRunsPage(el) { loadRuns(Math.max(1, parseInt(el.dataset.page, 10) || 1)); },

      aCfStatus(el) { A.cf.status = el.dataset.v; A.cf.page = 1; A.cf.data = null; render(); loadConflicts(); },
      aCfPage(el) { pageTo(A.cf, el, loadConflicts); },
      aResolve(el) { openResolve(el.dataset.id, el.dataset.r); },
      aResolveOpt(el) { const s = D.sheetOf(el); s.r = el.dataset.r; D.rerender(s); },
      async aResolveSave(el) {
        const s = D.sheetOf(el);
        const c = s.c;
        const body = { resolution: s.r, note: field(s, 'note') };
        if (s.r === 'custom') {
          const v = parseNum(field(s, 'value'));
          if (v == null || Number.isNaN(v) || v < 0) { say(s, 'Введіть невід’ємне число.'); return; }
          body.value = v;
        }
        await D.withBusy(el, async () => {
          try {
            await api('POST', `/api/admin/conflicts/${enc(c.id)}/resolve`, body);
            toast('Конфлікт розв’язано');
            D.closeSheet();
            S.openConflicts = Math.max(0, S.openConflicts - 1);
          } catch (e) {
            say(s, e.message);
            if (e.status !== 409) return;
          }
          const k = pageKey();
          if (k === 'admin/conflicts') loadConflicts();
          else if (k === 'admin/student') loadStudent();
          else render();
        });
      },

      aHistPage(el) { pageTo(A.hist, el, loadHistory); },
      aHistAll() { Object.assign(A.hist, { studentId: '', studentName: '', page: 1 }); loadHistory(); },
      aAudPage(el) { pageTo(A.aud, el, loadAudit); },

      catalogOpen: openCatalog,
      async aCatSave(el) {
        const s = D.sheetOf(el);
        const row = el.closest('.a-cat');
        const key = row.dataset.key;
        const title = row.querySelector('[data-f="title"]').value.trim();
        const maxScore = parseNum(row.querySelector('[data-f="max"]').value);
        const active = row.querySelector('[data-f="active"]').checked;
        if (maxScore == null || Number.isNaN(maxScore) || maxScore <= 0) { toast('Максимальний бал має бути більшим за 0'); return; }
        await D.withBusy(el, async () => {
          try {
            const r = await api('PUT', `/api/admin/catalog/${enc(key)}`, { title, maxScore, active });
            toast(r.above ? `Збережено. Увага: у ${r.above} ${D.studentsWord(r.above)} бал перевищує новий максимум` : `Предмет «${key}» збережено`);
            s.data = await api('GET', '/api/admin/catalog');
            A.catalog = s.data;
            D.rerender(s);
          } catch (e) { toast(e.message); }
        });
      },
      importOpen: openImport,
    },
    changes: {
      aAnGroup(el) { A.anGroup = el.value; loadAnalytics(); render(); },
      aStFilter(el) {
        const F = A.st;
        const k = el.dataset.k;
        F[k] = el.value;
        F.page = 1;
        if (k === 'subject') { F.sort = el.value ? 'subject' : 'rank'; F.dir = ''; }
        loadStudents();
      },
      aFixSubject(el) { const s = D.sheetOf(el); s.key = el.value; D.rerender(s); },
      aHistF(el) { A.hist[el.dataset.k] = el.value; A.hist.page = 1; loadHistory(); },
      aAudF(el) { A.aud[el.dataset.k] = el.value; A.aud.page = 1; loadAudit(); },
    },
    inputs: {
      aStQ(el) { A.st.q = el.value; A.st.page = 1; debounce(loadStudents); },
      aHistQ(el) { A.hist.q = el.value; A.hist.page = 1; debounce(loadHistory); },
      aAudQ(el) { A.aud.q = el.value; A.aud.page = 1; debounce(loadAudit); },
      // Чернетки назв: автооновлення сторінки (раз на 2 хв) не стирає вже введений текст.
      aGrpNewInp(el) { A.grp.draft = el.value; },
      aGrpRenameInp(el) { A.grp.renameDraft = el.value; },
    },
  });
})();
