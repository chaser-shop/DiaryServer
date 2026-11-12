/* Щоденник студента — вебверсія. Без збірки й залежностей: один файл, ванільний JS. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ───────────── сховище на пристрої ─────────────

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* переповнене сховище — не критично */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  let deviceId = LS.get('deviceId', null);
  if (!deviceId) { deviceId = makeId(); LS.set('deviceId', deviceId); }

  const DEFAULT_SETTINGS = { notificationsEnabled: true, leadMinutes: 2, askHomework: true, autoOpenLink: true, notifyHomework: true, notifyProgress: true };

  const S = {
    token: LS.get('token', null),
    user: null,
    lessons: [], homework: [], subjects: {}, teachers: {}, scheduleTitle: '',
    settings: Object.assign({}, DEFAULT_SETTINGS, LS.get('settings', {})),
    answered: new Set(LS.get('answered', [])),
    done: new Set(LS.get('done', [])),
    tab: 'today',
    // Обраний підрозділ для вкладок із кількома сторінками.
    sub: Object.assign({ progress: 'scores', admin: 'overview', settings: 'profile' }, LS.get('subs', {})),
    day: sod(new Date()),
    syncing: false, syncError: '',
    push: { supported: false, permission: 'default', subscribed: false },
    pendingRoute: null,
    pushEnsured: false,
    installEvent: null,
    needPassword: false,
    deviceRequests: 0,
    unread: 0,
    openConflicts: 0,
    deviceTrusted: true,
    noHw: new Set(),
    schedMsg: { text: '', cls: 'muted' },
    rating: { data: null, group: '', subject: '', err: '', msg: { text: '', cls: 'muted' } },
    grades: { items: null, lastCheck: null, err: '', checking: false, msg: '', cls: 'muted' },
    notify: { users: null, userId: 'all', title: '', body: '', msg: '', cls: 'muted', sending: false, err: '' },
  };

  // ───────────── дати ─────────────

  function sod(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fTime = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fDM = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long' });
  const fWD = new Intl.DateTimeFormat('uk-UA', { weekday: 'long' });
  const fWS = new Intl.DateTimeFormat('uk-UA', { weekday: 'short' });
  const hm = (d) => fTime.format(d);
  const dayMonth = (d) => fDM.format(d);
  const weekdayName = (d) => cap(fWD.format(d));
  const weekdayShort = (d) => fWS.format(d).toUpperCase();
  const pad = (n) => String(n).padStart(2, '0');
  const toInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromInput = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const weekStart = (d) => addDays(sod(d), -((sod(d).getDay() + 6) % 7));

  // ───────────── оформлення ─────────────

  const PALETTE = ['#0A84FF', '#30B455', '#FF375F', '#FF9F0A', '#32ADE6', '#BF5AF2', '#5E5CE6'];
  function subjColor(name) {
    let sum = 0;
    for (const ch of String(name)) sum = (sum + ch.codePointAt(0)) & 0xFFFF;
    return PALETTE[sum % PALETTE.length];
  }

  const ICONS = {
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    video: '<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    circle: '<circle cx="12" cy="12" r="10"/>',
    checkc: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M8 12.5l3 3 5-6" stroke="#fff"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    xc: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    bars: '<path d="M6 20V10M12 20V4M18 20v-7"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    device: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  };
  const ic = (name, size = 22) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ───────────── мережа ─────────────

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  let inflight = 0;
  let slowTimer = null;

  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    if (deviceId) headers['X-Device-Id'] = deviceId;
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 90000);
    if (++inflight === 1) slowTimer = setTimeout(() => { $('#banner').hidden = false; }, 6000);
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    } catch (e) {
      throw new ApiError(e && e.name === 'AbortError'
        ? 'Сервер довго не відповідає. Спробуйте ще раз за хвилину.'
        : 'Немає зв’язку із сервером. Перевірте інтернет.', 0);
    } finally {
      clearTimeout(kill);
      if (--inflight === 0) { clearTimeout(slowTimer); $('#banner').hidden = true; }
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* порожня відповідь */ }
    if (res.status === 401 && S.token) {
      forceSignOut('Сеанс завершено. Увійдіть знову.');
      throw new ApiError('Сеанс завершено. Увійдіть знову.', 401);
    }
    if (!res.ok) throw new ApiError((data && data.error) || `Помилка сервера (${res.status}).`, res.status, data && data.code);
    return data;
  }

  // ───────────── дані ─────────────

  const ROLE_NOTICE = {
    starosta: 'Вас призначено старостою. Тепер ви можете завантажувати розклад і підтверджувати домашнє.',
    deputy: 'Вас призначено заступником старости. Тепер ви можете завантажувати розклад і підтверджувати домашнє.',
    '': 'Вашу роль знято — ви знову студент.',
  };

  function applySync(r, fromCache) {
    const prevRole = S.user ? (S.user.isAdmin ? 'admin' : S.user.role || '') : null;
    S.user = r.user;
    if (!fromCache) {
      // Роль змінилась (адміністратор призначив або зняв) — показуємо повідомлення й запам'ятовуємо останню відому.
      const nowRole = r.user.isAdmin ? 'admin' : r.user.role || '';
      const known = LS.get('knownRole:' + r.user.id, prevRole);
      if (known !== null && known !== nowRole && nowRole !== 'admin') {
        setTimeout(() => toast(ROLE_NOTICE[nowRole] || ROLE_NOTICE['']), 300);
      }
      LS.set('knownRole:' + r.user.id, nowRole);
    }
    S.lessons = (r.lessons || []).map((l) => Object.assign({}, l, { start: new Date(l.start), end: new Date(l.end) }));
    S.subjects = r.subjects || {};
    S.teachers = r.teachers || {};
    S.scheduleTitle = r.scheduleTitle || '';
    S.deviceRequests = r.deviceRequests || 0;
    S.unread = r.unread || 0;
    S.openConflicts = r.openConflicts || 0;
    S.deviceTrusted = r.deviceTrusted !== false;
    S.noHw = new Set(r.noHomework || []);
    if (Array.isArray(r.answered)) {
      // Відповіді, дані на іншому пристрої, підтягуються з сервера; локальні, яких там ще немає, — відправляються туди.
      const server = new Set(r.answered);
      const extra = [...S.answered].filter((id) => !server.has(id));
      r.answered.forEach((id) => S.answered.add(id));
      LS.set('answered', [...S.answered]);
      if (extra.length && S.token) api('POST', '/api/answered', { ids: extra }).catch(() => {});
    }
    const ids = new Set();
    S.homework = (r.homework || []).map((h) => {
      ids.add(h.id);
      return Object.assign({}, h, { due: new Date(h.due), created: new Date(h.created || Date.now()) });
    });
    S.done = new Set([...S.done].filter((id) => ids.has(id)));
    LS.set('done', [...S.done]);
  }

  // Сервер щойно прокинувся й ще читає Google-таблицю: перевіримо ще раз за кілька секунд, без ручного оновлення.
  const sheetRetry = { n: 0, timer: null };
  async function sync() {
    if (!S.token) return;
    S.syncing = true;
    render({ soft: true });
    try {
      const r = await api('GET', '/api/sync');
      applySync(r);
      LS.set('cache', r);
      S.syncError = '';
      loadRating(undefined, true);
      runHooks('sync');
      clearTimeout(sheetRetry.timer);
      if (r.sheetPending && sheetRetry.n < 6) {
        sheetRetry.n++;
        sheetRetry.timer = setTimeout(() => { if (S.user) sync(); }, 8000);
      } else if (!r.sheetPending) sheetRetry.n = 0;
      await ensurePush();
      maybeAskPush();
    } catch (e) {
      if (e.status !== 401) S.syncError = e.message;
    } finally {
      S.syncing = false;
      render({ soft: true });
      processRoute();
    }
  }

  function resetLocal() {
    S.lessons = []; S.homework = []; S.subjects = {}; S.teachers = {}; S.scheduleTitle = '';
    S.answered = new Set(); S.done = new Set(); S.syncError = ''; S.pushEnsured = false; S.rating = { data: null, group: '', subject: '', err: '', msg: { text: '', cls: 'muted' } };
    S.unread = 0; S.openConflicts = 0;
    LS.del('cache'); LS.set('answered', []); LS.set('done', []);
    runHooks('reset');
  }

  async function login(fullName, password) {
    const r = await api('POST', '/api/auth/login', {
      fullName, deviceId, password: password || undefined,
      deviceLabel: window.DeviceInfo ? DeviceInfo.label() : undefined,
    });
    stopPending();
    S.token = null;
    resetLocal();
    S.token = r.token;
    LS.set('token', r.token);
    S.user = r.user;
    S.tab = 'today';
    await sync();
  }

  // Новий пристрій людини, в якої вже є інші: запит іде адміністратору, а ми чекаємо підтвердження.
  let pendingTimer = null;
  function stopPending() { clearInterval(pendingTimer); pendingTimer = null; }

  function setLoginMsg(text, kind) {
    const el = $('#loginErr');
    if (!el) return;
    if (kind === 'wait') {
      el.className = '';
      el.innerHTML = `<div class="info-box"><span class="spin"></span><div>${esc(text)}</div></div>`;
    } else {
      el.className = kind === 'err' ? 'err' : '';
      el.textContent = text;
    }
  }

  function startPending(name) {
    stopPending();
    pendingTimer = setInterval(async () => {
      const f = $('#fullName');
      if (S.user || !f || f.value.replace(/\s+/g, ' ').trim() !== name) { stopPending(); return; }
      try {
        const r = await api('POST', '/api/auth/device-status', { fullName: name, deviceId });
        if (r.status === 'approved') {
          stopPending();
          setLoginMsg('Підтверджено! Входимо…', 'ok');
          try { await login(name, ''); } catch (e) { setLoginMsg(e.message, 'err'); }
        } else if (r.status === 'none') {
          stopPending();
          setLoginMsg('Адміністратор відхилив запит на цей пристрій. Можна надіслати його ще раз, натиснувши «Увійти».', 'err');
        }
      } catch (e) { /* немає зв’язку — спробуємо ще раз */ }
    }, 6000);
  }

  let loginNotice = '';
  function forceSignOut(notice) {
    removePushAsk();
    S.token = null; S.user = null;
    LS.del('token');
    resetLocal();
    closeAllSheets();
    loginNotice = notice || '';
    render();
  }

  async function signOut() {
    try {
      const sub = await getSub();
      if (sub) await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    } catch (e) { /* не критично */ }
    forceSignOut('');
  }

  // ───────────── доменна логіка ─────────────

  const isAdmin = () => !!(S.user && S.user.isAdmin);
  /** Адмін, староста або заступник: підтверджують домашнє й завантажують розклад. */
  const isMod = () => !!(S.user && (S.user.isAdmin || S.user.canModerate));
  const ROLE_TITLES = { starosta: 'Староста', deputy: 'Заступник старости' };
  const roleBadge = (u) => (u && u.isAdmin ? badge('АДМІН', 'accent') : u && ROLE_TITLES[u.role] ? badge(ROLE_TITLES[u.role].toUpperCase(), 'accent') : '');
  const lessonById = (id) => S.lessons.find((l) => l.id === id);
  const lessonsOn = (day) => S.lessons.filter((l) => sameDay(l.start, day)).sort((a, b) => a.start - b.start);
  const nextLesson = (now) => S.lessons.filter((l) => l.end > now).sort((a, b) => a.start - b.start)[0];

  const kindTitle = (l) => ({ 'Лк': 'Лекція', 'Пз': 'Практична', 'Сем': 'Семінар', '': 'Пара' }[l.kind] || l.kind);
  const placeTitle = (l) => (l.isRemote ? 'Дистанційно' : l.room ? 'ауд. ' + l.room : '—');

  function subjectKeys() {
    const set = new Set(S.lessons.map((l) => l.subjectKey));
    Object.keys(S.subjects).forEach((k) => set.add(k));
    S.homework.forEach((h) => set.add(h.subjectKey));
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'uk'));
  }
  function subjName(key) {
    const n = ((S.subjects[key] && S.subjects[key].fullName) || '').trim();
    return n || key;
  }
  function joinURL(key) {
    let s = ((S.subjects[key] && S.subjects[key].link) || '').trim();
    if (!s) return null;
    if (!s.includes('://')) s = 'https://' + s;
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString() : null; } catch (e) { return null; }
  }
  function teacherName(raw) { const n = (S.teachers[raw] || '').trim(); return n || raw; }
  function teacherKeys() { return [...new Set(S.lessons.map((l) => l.teacher))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'uk')); }

  function dueDateAfter(lesson) {
    const next = S.lessons.filter((l) => l.subjectKey === lesson.subjectKey && l.start > lesson.end).sort((a, b) => a.start - b.start)[0];
    return next ? sod(next.start) : sod(addDays(lesson.start, 1));
  }
  // «Здати на наступний семінар / практичну / лекцію»: дату знаходимо в розкладі самі.
  const KIND_MODES = [['Сем', 'Наступний семінар'], ['Пз', 'Наступна практична'], ['Лк', 'Наступна лекція']];
  const dueBase = (item) => { const l = item.lessonID && lessonById(item.lessonID); return l ? l.end : new Date(); };
  function nextLessonFor(subjectKey, base, mode) {
    return S.lessons.filter((l) => l.subjectKey === subjectKey && l.start > base && (mode === 'any' || l.kind === mode))
      .sort((a, b) => a.start - b.start)[0] || null;
  }
  function dueModes(subjectKey, base) {
    const out = [['date', 'Вибрати дату вручну']];
    if (nextLessonFor(subjectKey, base, 'any')) out.push(['any', 'Наступна пара']);
    for (const [k, title] of KIND_MODES) if (nextLessonFor(subjectKey, base, k)) out.push([k, title]);
    return out;
  }
  const dueModeOptions = (subjectKey, base, cur) => dueModes(subjectKey, base)
    .map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  function dueHint(subjectKey, base, mode) {
    if (mode === 'date') return '';
    const l = nextLessonFor(subjectKey, base, mode);
    return l ? `${kindTitle(l)}: ${weekdayName(l.start)}, ${dayMonth(l.start)}, ${hm(l.start)}` : 'У розкладі такої пари не знайдено — оберіть дату вручну.';
  }
  /** Оновлює дату й список варіантів у відкритій формі після зміни предмета чи способу вибору дати. */
  function hwRefreshDue(s) {
    const subj = $('[name=subject]', s.el).value;
    const modeSel = $('[name=dueMode]', s.el);
    const dateInp = $('[name=due]', s.el);
    const base = dueBase(s.item);
    let mode = modeSel.value;
    const modes = dueModes(subj, base);
    if (!modes.some(([v]) => v === mode)) mode = 'date';
    modeSel.innerHTML = dueModeOptions(subj, base, mode);
    modeSel.value = mode;
    s.item.dueMode = mode;
    const auto = mode !== 'date';
    if (auto) {
      const l = nextLessonFor(subj, base, mode);
      if (l) dateInp.value = toInput(sod(l.start));
    }
    dateInp.readOnly = auto;
    dateInp.tabIndex = auto ? -1 : 0;
    dateInp.style.pointerEvents = auto ? 'none' : '';
    dateInp.style.opacity = auto ? '.7' : '';
    $('[data-role="dueHint"]', s.el).textContent = dueHint(subj, base, mode);
  }
  const newHomework = (l) => ({ id: null, subjectKey: l.subjectKey, lessonID: l.id, text: '', due: dueDateAfter(l) });
  const blankHomework = () => ({ id: null, subjectKey: subjectKeys()[0] || '', lessonID: null, text: '', due: sod(addDays(new Date(), 1)) });

  /**
   * Домашнє, що стосується конкретної пари:
   *  given — задали саме на цій парі (прив'язане до неї або внесене з цього предмета в день пари);
   *  due   — треба здати на цю пару (термін збігається з днем пари).
   */
  function lessonHomework(l) {
    const all = S.homework.filter((h) => h.status === 'approved' || h.authorID === (S.user && S.user.id));
    const given = all.filter((h) => h.lessonID === l.id || (!h.lessonID && h.subjectKey === l.subjectKey && sameDay(h.created, l.start)))
      .sort((a, b) => a.created - b.created);
    const ids = new Set(given.map((h) => h.id));
    const due = all.filter((h) => !ids.has(h.id) && h.subjectKey === l.subjectKey && sameDay(h.due, l.start))
      .sort((a, b) => a.created - b.created);
    return { given, due };
  }

  const hwDone = (h) => S.done.has(h.id);
  const listedHomework = () => S.homework.filter((h) => h.status === 'approved' || h.authorID === (S.user && S.user.id));
  const moderationQueue = () => (isMod() ? S.homework.filter((h) => h.status === 'pending').sort((a, b) => a.created - b.created) : []);
  const canEdit = (h) => isMod() || (h.authorID === (S.user && S.user.id) && h.status !== 'approved');

  function pendingPrompts() {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000);
    return S.lessons.filter((l) => l.end <= now && l.end > from && !S.answered.has(l.id) && !S.noHw.has(l.id) && !hasHomeworkFor(l))
      .sort((a, b) => b.end - a.end);
  }

  /** Домашнє з цієї пари вже записано (прив’язане до пари або внесене з цього предмета після її початку). */
  function hasHomeworkFor(l) {
    return S.homework.some((h) => h.status !== 'rejected' && (h.lessonID === l.id || (h.subjectKey === l.subjectKey && h.created >= l.start)));
  }

  /** «Нічого не задали»: у адміна/старости плашка зникає в усіх, у решти — лише на їхньому пристрої. */
  async function answerNone(lessonId) {
    markAnswered(lessonId);
    if (isMod()) {
      S.noHw.add(lessonId);
      try { await api('POST', `/api/lessons/${encodeURIComponent(lessonId)}/no-homework`); } catch (e) { toast(e.message); S.noHw.delete(lessonId); }
    }
    render();
  }

  function markAnswered(id) {
    S.answered.add(id);
    LS.set('answered', [...S.answered]);
    if (S.token) api('POST', `/api/lessons/${encodeURIComponent(id)}/answered`).catch(() => {});
  }
  function toggleDone(id) {
    if (S.done.has(id)) S.done.delete(id); else S.done.add(id);
    LS.set('done', [...S.done]);
  }
  function saveSettings() { LS.set('settings', S.settings); }

  // ───────────── шаблони ─────────────

  const card = (inner, cls = '') => `<div class="card ${cls}">${inner}</div>`;
  const badge = (text, cls = '') => `<span class="badge ${cls}">${esc(text)}</span>`;
  const hwBadge = (h) => (h.status === 'pending' ? badge('ОЧІКУЄ ПІДТВЕРДЖЕННЯ', 'warn') : h.status === 'rejected' ? badge('ВІДХИЛЕНО', 'red') : '');

  // Форматування чисел і дат українською.
  const fNum = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
  const fPct = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
  const fDMY = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  const fShort = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' });
  const clean = (s) => s.replace(/\u00a0/g, ' ');
  const fmt = {
    num: (n) => (n == null || Number.isNaN(n) ? '—' : clean(fNum.format(n))),
    pct: (n) => (n == null || Number.isNaN(n) ? '—' : clean(fPct.format(n)) + '%'),
    signed: (n, unit = '') => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + clean(fNum.format(Math.abs(n))) + unit),
    date: (v) => { const d = v ? new Date(v) : null; if (!d || Number.isNaN(d.getTime())) return '—'; return d.getFullYear() === new Date().getFullYear() ? dayMonth(d) : fDMY.format(d); },
    dateTime: (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? `${fmt.date(d)}, ${hm(d)}` : '—'; },
    dayKey: (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; },
    shortDay: (k) => { const d = fmt.dayKey(k); return d ? clean(fShort.format(d)).replace('.', '') : String(k || ''); },
    longDay: (k) => { const d = fmt.dayKey(k); return d ? fmt.date(d) : String(k || ''); },
    month: (k) => { const m = /^(\d{4})-(\d{2})/.exec(k || ''); return m ? new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' }).format(new Date(+m[1], +m[2] - 1, 1)) : String(k || ''); },
    rel: (v) => {
      const d = v ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) return '—';
      const s = (Date.now() - d.getTime()) / 1000;
      if (s < 60) return 'щойно';
      if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
      if (sameDay(d, new Date())) return `сьогодні о ${hm(d)}`;
      if (sameDay(d, addDays(new Date(), -1))) return `учора о ${hm(d)}`;
      return fmt.dateTime(d);
    },
    dayGroup: (v) => { const d = new Date(v); return sameDay(d, new Date()) ? 'Сьогодні' : sameDay(d, addDays(new Date(), -1)) ? 'Учора' : cap(fmt.date(d)); },
    plural: (n, one, few, many) => { const a = Math.abs(n) % 100; const b = a % 10; return !Number.isInteger(n) ? few : a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; },
    /** «1 бал», «3 бали», «7 балів», «7,5 бала» (дробові — родовий однини). */
    points: (n) => `${fmt.num(n)} ${Number.isInteger(n) ? fmt.plural(n, 'бал', 'бали', 'балів') : 'бала'}`,
    /** Час події: «сьогодні, 18:07», «учора, 09:15», інакше «12 листопада, 18:07». */
    when: (v) => {
      const d = v ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) return '—';
      if (sameDay(d, new Date())) return `сьогодні, ${hm(d)}`;
      if (sameDay(d, addDays(new Date(), -1))) return `учора, ${hm(d)}`;
      return fmt.dateTime(d);
    },
  };

  const SOURCE_TITLES = { sheet: 'Google-таблиця', student: 'Студент', admin: 'Адміністратор', import: 'Імпорт файлу', seed: 'Початкові дані', migration: 'Перенесення даних' };

  // Спільні елементи інтерфейсу для всіх сторінок.
  const ui = {
    loading: () => '<div class="loading"><span class="spin"></span></div>',
    skeleton: (n = 3, h = 86) => Array.from({ length: n }, () => `<div class="skel" style="height:${h}px"></div>`).join(''),
    empty: (icon, title, text, action = '') => `<div class="card"><div class="empty"><span class="e-ic">${ic(icon, 26)}</span><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}${action}</div></div>`,
    notice: (kind, html, icon) => `<div class="notice ${kind}">${ic(icon || (kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert'), 18)}<div>${html}</div></div>`,
    error: (msg, act) => `<div class="card">${ui.notice('err', esc(msg))}${act ? `<button class="btn auto ghost" data-act="${act}">${ic('refresh', 16)} Спробувати ще раз</button>` : ''}</div>`,
    /** Зміна з кольором: up — зелений, down — червоний. good=false інвертує (наприклад, місце в рейтингу). */
    delta(v, { unit = '', text = '', good } = {}) {
      if (v == null || Number.isNaN(v)) return '<span class="delta flat">—</span>';
      const positive = good === undefined ? v > 0 : good;
      const cls = v === 0 ? 'flat' : positive ? 'up' : 'down';
      return `<span class="delta ${cls}">${v === 0 ? '' : v > 0 ? '▲ ' : '▼ '}${esc(text || fmt.signed(v, unit))}</span>`;
    },
    kpi({ label, value, unit = '', sub = '', icon = '', tone = '', act = '', attrs = '' }) {
      const tag = act ? 'button' : 'div';
      return `<${tag} class="kpi" ${act ? `data-act="${act}"` : ''} ${attrs}><div class="k-top"><span class="k-label">${esc(label)}</span>${icon ? `<span class="k-ic ${tone}">${ic(icon, 17)}</span>` : ''}</div>
        <div class="k-val">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="k-sub">${sub}</div></${tag}>`;
    },
    src: (s, text) => `<span class="badge src-${['sheet', 'student', 'admin', 'import'].includes(s) ? s : 'other'}">${esc(text || SOURCE_TITLES[s] || 'Інше')}</span>`,
    srcIcon: (s) => `<span class="feed-ic ${['sheet', 'student', 'admin', 'import'].includes(s) ? 'fi-' + s : ''}">${ic(s === 'sheet' ? 'sheet' : s === 'student' ? 'user' : s === 'admin' ? 'shield' : s === 'import' ? 'upload' : 'clock', 17)}</span>`,
    change: (oldV, newV) => `<span class="change"><s>${esc(fmt.num(oldV))}</s> → ${esc(fmt.num(newV))}</span>`,
    progress: (value, max, cls = '') => `<div class="progress ${cls}"><i style="width:${Math.max(0, Math.min(100, max ? (value / max) * 100 : 0)).toFixed(1)}%"></i></div>`,
    pager(p, act) {
      if (!p || !p.total) return '';
      if (p.pages <= 1) return `<div class="pager"><span>Записів: ${p.total}</span></div>`;
      return `<div class="pager"><span>Сторінка ${p.page} з ${p.pages} · записів: ${p.total}</span><div class="btn-row">
        <button class="btn small ghost" data-act="${act}" data-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>${ic('left', 16)} Назад</button>
        <button class="btn small ghost" data-act="${act}" data-page="${p.page + 1}" ${p.page >= p.pages ? 'disabled' : ''}>Далі ${ic('right', 16)}</button></div></div>`;
    },
    seg: (items, cur, act, attrs = '') => `<div class="seg inline" role="group" ${attrs}>${items.map(([v, t]) => `<button class="${v === cur ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}">${esc(t)}</button>`).join('')}</div>`,
    /** «75 → 82»; відсутнє значення — «—». */
    scoreValues: (oldV, newV) => `<span class="sc-vals"><span class="sc-old">${esc(fmt.num(oldV))}</span><span class="sc-arr" aria-hidden="true">→</span><b>${esc(fmt.num(newV))}</b></span>`,
    /** «+7 балів» / «−3 бали». Перший і прибраний бал — словами: різниці з нулем тут немає. */
    scoreDelta(oldV, newV) {
      const has = (v) => typeof v === 'number' && Number.isFinite(v);
      if (!has(oldV) && has(newV)) return '<span class="sc-delta new">новий бал</span>';
      if (has(oldV) && !has(newV)) return '<span class="sc-delta down">бал видалено</span>';
      if (!has(oldV)) return '';
      const d = Math.round((newV - oldV) * 100) / 100;
      if (!d) return '<span class="sc-delta flat">без змін</span>';
      return `<span class="sc-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${esc(fmt.points(Math.abs(d)))}</span>`;
    },
    /** Зміна балу — один вигляд на всіх сторінках: предмет, хто/коли, «75 → 82» і «+7 балів». */
    scoreChange(h, { who = '', source = '' } = {}) {
      const subj = h.subjectTitle || h.subject;
      const at = new Date(h.at);
      const iso = Number.isNaN(at.getTime()) ? '' : at.toISOString();
      return `<div class="sc-item">${ui.srcIcon(h.source)}
        <div class="sc-main"><div class="sc-subj">${esc(subj)}${subj !== h.subject ? ` <span class="sc-key">${esc(h.subject)}</span>` : ''}</div>
          ${who ? `<div class="sc-who">${who}</div>` : ''}
          <div class="sc-meta"><time datetime="${esc(iso)}" title="${esc(fmt.dateTime(h.at))}">${esc(fmt.when(h.at))}</time>${source ? ` · ${source}` : ''}</div>
          ${h.reason ? `<div class="sc-reason">${esc(h.reason)}</div>` : ''}</div>
        <div class="sc-side">${ui.scoreValues(h.oldValue, h.newValue)}${ui.scoreDelta(h.oldValue, h.newValue)}</div></div>`;
    },
  };

  function lessonRow(l) {
    const now = new Date();
    const ongoing = l.start <= now && now < l.end;
    const finished = l.end <= now;
    const lh = lessonHomework(l);
    const hwCount = lh.given.length + lh.due.length;
    return `<button class="lesson ${finished ? 'dim' : ''}" data-act="lesson" data-id="${esc(l.id)}">
      <div class="lt"><b>${hm(l.start)}</b><span>${hm(l.end)}</span></div>
      <i class="bar" style="background:${subjColor(l.subjectKey)}"></i>
      <div class="lm"><div class="ln">${esc(subjName(l.subjectKey))}</div>
        <div class="ls">${l.pair} пара · ${esc(kindTitle(l))} · ${esc(placeTitle(l))}</div></div>
      ${hwCount ? badge('ДЗ ' + hwCount, 'warn') : ''}
      ${ongoing ? badge('ЗАРАЗ') : l.isRemote ? `<span class="muted">${ic('video', 20)}</span>` : ''}
    </button>`;
  }

  function statusText(l, now) {
    if (l.start <= now) return 'Закінчиться о ' + hm(l.end);
    const minutes = Math.floor((l.start - now) / 60000);
    if (minutes < 1) return 'Починається зараз';
    if (minutes < 60) return `Через ${minutes} хв · ${hm(l.start)}`;
    if (sameDay(l.start, now)) return 'Сьогодні о ' + hm(l.start);
    if (sameDay(l.start, addDays(now, 1))) return 'Завтра о ' + hm(l.start);
    return `${weekdayName(l.start)}, ${dayMonth(l.start)} о ${hm(l.start)}`;
  }

  function nextCard() {
    const now = new Date();
    const l = nextLesson(now);
    if (!l) return card('<div class="muted">Найближчих пар у розкладі немає. Адміністратор чи староста можуть завантажити новий розклад у налаштуваннях.</div>');
    const ongoing = l.start <= now;
    const url = joinURL(l.subjectKey);
    const color = subjColor(l.subjectKey);
    return card(`
      <div class="label">${ongoing ? 'Зараз іде' : 'Наступна пара'}</div>
      <div class="hstack">
        <div class="avatar" style="background:${color}38;color:${color}">${esc(l.subjectKey.charAt(0).toUpperCase())}</div>
        <div><div class="next-title">${esc(subjName(l.subjectKey))}</div>
          <div class="muted small">${esc(kindTitle(l))} · ${esc(placeTitle(l))}</div></div>
      </div>
      <div class="status ${ongoing ? 'now' : 'soon'}">${esc(statusText(l, now))}</div>
      ${l.teacher ? `<div class="muted small">${esc(teacherName(l.teacher))}</div>` : ''}
      <div class="btn-row">
        ${url ? `<a class="btn green" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic('video', 18)} Приєднатися</a>` : ''}
        <button class="btn" data-act="lesson" data-id="${esc(l.id)}">Деталі</button>
      </div>`);
  }

  function promptCard(l) {
    return card(`
      <div class="label">Пара закінчилась о ${hm(l.end)}</div>
      <div style="font-size:17px;font-weight:600">Що задали з «${esc(subjName(l.subjectKey))}»?</div>
      <div class="btn-row">
        <button class="btn" data-act="hwNew" data-lesson="${esc(l.id)}">Записати</button>
        <button class="btn deep" data-act="answered" data-lesson="${esc(l.id)}">Нічого не задали</button>
      </div>`);
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  function installHint() {
    if (!(isIOS && !isStandalone()) || LS.get('hintOff', false)) return '';
    return card(`
      <div><b>Сповіщення на iPhone.</b> Відкрийте щоденник у Safari, натисніть «Поділитися» ⬆︎ → «На початковий екран» і запускайте його з іконки — лише так iOS дозволяє вебзастосункам надсилати сповіщення.</div>
      <button class="btn deep" data-act="hintOff">Зрозуміло</button>`, 'hint');
  }


  // ───────────── вкладення до домашнього: посилання й зображення ─────────────

  const MAX_LINKS = 5;
  const MAX_IMAGES = 6;
  const IMG = {};          // id → blob-URL (зображення завантажуються з токеном, тож <img src> напряму не підходить)
  const imgLoading = {};
  const imgFailed = new Set();

  function loadImg(id) {
    if (IMG[id]) return Promise.resolve(IMG[id]);
    if (!imgLoading[id]) {
      imgLoading[id] = fetch('/api/images/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + S.token } })
        .then((r) => { if (!r.ok) throw new Error('img'); return r.blob(); })
        .then((b) => { IMG[id] = URL.createObjectURL(b); return IMG[id]; })
        .finally(() => { delete imgLoading[id]; });
    }
    return imgLoading[id];
  }

  function imgTag(id, cls) {
    const c = cls ? ` class="${cls}"` : '';
    if (IMG[id]) return `<img${c} src="${IMG[id]}" alt="">`;
    if (imgFailed.has(id)) return `<img${c} class="broken" alt="Не завантажилось">`;
    return `<img${c} data-img="${esc(id)}" alt="">`;
  }

  function hydrateImages() {
    document.querySelectorAll('img[data-img]').forEach((el) => {
      const id = el.dataset.img;
      if (IMG[id]) { el.src = IMG[id]; el.removeAttribute('data-img'); return; }
      if (!S.token) return;
      loadImg(id)
        .then((u) => { el.src = u; el.removeAttribute('data-img'); })
        .catch(() => { imgFailed.add(id); el.removeAttribute('data-img'); el.classList.add('broken'); });
    });
  }
  let hydrateQueued = false;
  new MutationObserver(() => {
    if (hydrateQueued) return;
    hydrateQueued = true;
    requestAnimationFrame(() => { hydrateQueued = false; hydrateImages(); });
  }).observe(document.body, { childList: true, subtree: true });

  function normLink(v) {
    let t = String(v || '').trim();
    if (!t) return '';
    if (!t.includes('://')) t = 'https://' + t;
    try {
      const u = new URL(t);
      return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString() : null;
    } catch (e) { return null; }
  }
  const shortUrl = (u) => { const t = String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''); return t.length > 42 ? t.slice(0, 41) + '…' : t; };

  function attHTML(h) {
    const links = (h.links || []).map((u) => `<a class="chip-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(shortUrl(u))}</a>`).join('');
    const imgs = (h.images || []).map((id) => `<button class="thumb" data-act="imgOpen" data-id="${esc(id)}" aria-label="Відкрити зображення">${imgTag(id)}</button>`).join('');
    return links || imgs ? `<div class="att">${links}${imgs ? `<div class="thumbs">${imgs}</div>` : ''}</div>` : '';
  }

  /** Стискає фото до розумного розміру (JPEG, довша сторона ≤ 1600 px) — щоб швидко вантажилося й не забивало базу. */
  async function compressImage(file) {
    let bmp = null;
    if (window.createImageBitmap) { try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; } }
    if (!bmp) {
      bmp = await new Promise((res, rej) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); res(im); };
        im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Не вдалося прочитати зображення.')); };
        im.src = url;
      });
    }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
    if (!w0 || !h0) throw new Error('Не вдалося прочитати зображення.');
    for (const [side, q] of [[1600, 0.78], [1280, 0.65], [1024, 0.5], [800, 0.45]]) {
      const k = Math.min(1, side / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= 1.2 * 1024 * 1024) return blob;
    }
    throw new Error('Зображення завелике.');
  }

  const blobToB64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('Не вдалося прочитати файл.'));
    r.readAsDataURL(blob);
  });

  async function addImages(s, files) {
    const err = () => $('[data-role="err"]', s.el);
    files = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)).slice(0, MAX_IMAGES - s.item.images.length);
    if (!files.length) return;
    s.uploading = (s.uploading || 0) + files.length;
    rerender(s);
    let msg = '';
    for (const f of files) {
      try {
        const blob = await compressImage(f);
        const r = await api('POST', '/api/images', { data: await blobToB64(blob) });
        IMG[r.id] = URL.createObjectURL(blob);
        s.item.images.push(r.id);
      } catch (e) { msg = e.message || 'Не вдалося додати зображення.'; }
      s.uploading--;
      rerender(s);
    }
    if (msg && err()) err().textContent = msg;
  }

  // ───────────── екрани ─────────────

  function viewToday() {
    const first = (S.user.fullName.split(' ')[1] || S.user.fullName.split(' ')[0] || '');
    let left = '';
    if (!S.lessons.length) {
      left += card(`<div class="next-title">Розкладу ще немає</div><div class="muted">${isAdmin()
        ? 'Відкрийте «Адміністрування → Керування» і завантажте файл розкладу (.xls) — його одразу побачать усі студенти.'
        : isMod() ? 'Відкрийте «Профіль → Налаштування» і завантажте файл розкладу (.xls) — його одразу побачать усі студенти.'
          : 'Адміністратор чи староста ще не завантажили розклад. Зайдіть пізніше або натисніть оновлення вгорі.'}</div>`);
    } else {
      left += nextCard();
      pendingPrompts().forEach((l) => { left += promptCard(l); });
      const section = (title, day) => {
        const items = lessonsOn(day);
        return `<div class="section"><div class="sec-head"><h2>${title}</h2><span class="muted small">${dayMonth(day)}</span></div>
          ${items.length ? items.map(lessonRow).join('') : card('<span class="muted">Пар немає</span>', 'tight')}</div>`;
      };
      left += section('Сьогодні', new Date()) + section('Завтра', addDays(new Date(), 1));
    }
    const side = hookHtml('homeSide');
    return `<div class="greet"><div><small>${esc(cap(weekdayName(new Date())))}, ${esc(dayMonth(new Date()))}</small><h2>Привіт, ${esc(first)}!</h2></div></div>
      ${installHint()}
      ${hookHtml('homeTop')}
      <div class="home-grid"><div class="home-col">${left}</div>${side ? `<div class="home-col">${side}</div>` : ''}</div>`;
  }

  function viewSchedule() {
    const start = weekStart(S.day);
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
    const items = lessonsOn(S.day);
    return `
      <div class="weekbar">
        <button class="icon-btn" data-act="shift" data-d="-7" aria-label="Попередній тиждень">${ic('left')}</button>
        <b>${dayMonth(days[0])} – ${dayMonth(days[6])}</b>
        <button class="icon-btn" data-act="shift" data-d="7" aria-label="Наступний тиждень">${ic('right')}</button>
      </div>
      <div class="chips">${days.map((d) => `
        <button class="chip ${sameDay(d, S.day) ? 'sel' : ''} ${lessonsOn(d).length ? 'has' : ''}" data-act="day" data-ts="${d.getTime()}">
          <small>${weekdayShort(d)}</small><strong>${d.getDate()}</strong><i></i></button>`).join('')}</div>
      <div class="section"><div class="sec-head"><span class="label">${weekdayName(S.day)}</span><span class="muted small">${dayMonth(S.day)}</span></div>
        ${items.length ? items.map(lessonRow).join('') : card('<span class="muted">Пар немає</span>')}</div>`;
  }

  function hwRow(h) {
    const left = h.status === 'approved'
      ? `<button class="chk ${hwDone(h) ? 'on' : ''}" data-act="done" data-id="${esc(h.id)}" aria-label="Виконано">${ic(hwDone(h) ? 'checkc' : 'circle', 26)}</button>`
      : `<span class="chk st" style="color:${h.status === 'pending' ? 'var(--warn)' : 'var(--red)'}">${ic(h.status === 'pending' ? 'clock' : 'xc', 26)}</span>`;
    return `<div class="hw">${left}<div class="hw-main">
      <button class="body" data-act="hwOpen" data-id="${esc(h.id)}">
        <div class="subj" style="color:${subjColor(h.subjectKey)}">${esc(subjName(h.subjectKey))} ${hwBadge(h)}</div>
        <div class="txt ${hwDone(h) ? 'done' : ''}">${esc(h.text)}</div>
        <div class="muted small">До ${dayMonth(h.due)}</div>
      </button>${attHTML(h)}</div></div>`;
  }

  function viewHomework() {
    const today = sod(new Date());
    const tomorrow = addDays(today, 1);
    const all = listedHomework();
    const pending = all.filter((h) => !hwDone(h));
    const overdue = pending.filter((h) => h.due < today).sort((a, b) => a.due - b.due);
    const todayItems = pending.filter((h) => sameDay(h.due, today));
    const tomorrowItems = pending.filter((h) => sameDay(h.due, tomorrow));
    const later = pending.filter((h) => h.due > tomorrow && !sameDay(h.due, tomorrow)).sort((a, b) => a.due - b.due);
    const done = all.filter(hwDone).sort((a, b) => b.due - a.due).slice(0, 15);

    const sec = (title, items) => `<div class="hw-sec"><div class="label">${title}</div>${items.map(hwRow).join('')}</div>`;
    let h = '';
    const q = moderationQueue();
    if (q.length) h += `<button class="card row" data-act="moderation" style="justify-content:space-between"><span>Чекають підтвердження</span>${badge(String(q.length), 'warn')}</button>`;
    pendingPrompts().forEach((l) => { h += promptCard(l); });
    h += `<div class="hw-sec"><div class="label">На завтра · ${dayMonth(tomorrow)}</div>${tomorrowItems.length ? tomorrowItems.map(hwRow).join('') : '<div class="muted" style="padding:10px 0">На завтра нічого не задано</div>'}</div>`;
    if (todayItems.length) h += sec('На сьогодні', todayItems);
    if (overdue.length) h += sec('Прострочено', overdue);
    if (later.length) h += sec('Пізніше', later);
    if (done.length) h += sec('Виконано', done);
    return h + `<div class="fab-gap"></div><button class="fab" data-act="hwNew" aria-label="Додати домашнє">${ic('plus', 26)}</button>`;
  }

  // ───────────── оцінки (адмін) ─────────────

  const numGrade = (v) => (/^\d+([.,]\d+)?$/.test(String(v).trim()) ? parseFloat(String(v).replace(',', '.')) : null);
  function gradeDate(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    return dayMonth(d) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }

  function viewGrades() {
    const g = S.grades;
    if (!g.items) {
      return g.err
        ? card(`<div class="err">${esc(g.err)}</div><button class="btn" data-act="gradesReload">Спробувати ще раз</button>`)
        : '<div class="spin" style="margin:60px auto;width:28px;height:28px"></div>';
    }
    const groups = new Map();
    for (const it of g.items) {
      const k = (it.subject || 'Без предмета') + (it.period ? ' · ' + it.period : '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const names = [...groups.keys()].sort((x, y) => x.localeCompare(y, 'uk'));
    let h = '';
    h += card(`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <span>Усього оцінок</span>${badge(String(g.items.length), 'accent')}</div>
      <div class="muted small">Перевірка нових оцінок — щодня о 20:00 за київським часом.${g.lastCheck ? ' Остання: ' + esc(dayMonth(g.lastCheck) + ', ' + hm(g.lastCheck)) + '.' : ''}</div>
      <div class="${g.cls} small" ${g.msg ? '' : 'hidden'}>${esc(g.msg)}</div>
      <button class="btn" data-act="gradesCheck" ${g.checking ? 'disabled' : ''}>${g.checking ? '<span class="spin"></span>' : 'Перевірити зараз'}</button>`);
    if (!g.items.length) return h + `<div class="foot">${g.docs ? `У колекції grades (база «${esc(g.db)}») є документів: ${g.docs}, але масиву grades із оцінками в них немає.` : `У колекції grades (база «${esc(g.db)}») немає жодного документа. Якщо оцінки лежать в іншій базі, вкажіть її у змінній GRADES_DB.`}</div>`;
    for (const name of names) {
      const list = groups.get(name);
      const nums = list.map((x) => numGrade(x.value)).filter((n) => n != null);
      const avg = nums.length ? (nums.reduce((p, c) => p + c, 0) / nums.length).toFixed(2).replace(/\.?0+$/, '') : '';
      h += `<div><div class="label" style="margin:0 0 6px 4px">${esc(name)} · ${list.length}${avg ? ' · сер. ' + esc(avg) : ''}</div><div class="list">${list.map((x) => {
        const sub = [x.type, gradeDate(x.date), x.teacher].filter(Boolean).join(' · ');
        const extra = !x.value && x.extra ? x.extra : '';
        return `<div class="row"><span style="min-width:0">${esc(sub || (x.value ? 'Оцінка' : 'Запис'))}${extra ? `<span class="muted small" style="display:block">${esc(extra)}</span>` : ''}</span>${x.value ? badge(x.value, 'accent') : ''}</div>`;
      }).join('')}</div></div>`;
    }
    return h;
  }

  async function loadGrades() {
    S.grades.err = '';
    try {
      const r = await api('GET', '/api/admin/grades');
      S.grades.items = r.items.map((x) => ({ ...x, date: x.date ? new Date(x.date) : null }));
      S.grades.lastCheck = r.lastCheck ? new Date(r.lastCheck) : null;
      S.grades.docs = r.docs; S.grades.db = r.db;
    } catch (e) { S.grades.err = e.message; }
    render();
  }

  function viewNotify() {
    const n = S.notify;
    const opts = [`<option value="all" ${n.userId === 'all' ? 'selected' : ''}>Усім, хто увімкнув сповіщення</option>`]
      .concat((n.users || []).map((u) => `<option value="${esc(u.id)}" ${n.userId === u.id ? 'selected' : ''}>${esc(u.fullName)} ${u.pushDevices ? '🔔' + u.pushDevices : '🔕'}</option>`));
    return `
      ${card(`
        <label style="display:flex;flex-direction:column;gap:6px"><span class="label">Кому</span>
          <select class="field" data-chg="notifyField" data-key="userId" ${n.users ? '' : 'disabled'}>${opts.join('')}</select></label>
        <label style="display:flex;flex-direction:column;gap:6px"><span class="label">Заголовок (необов’язково)</span>
          <input class="field" data-inp="notifyField" data-key="title" maxlength="60" placeholder="Повідомлення від адміністратора" value="${esc(n.title)}"></label>
        <label style="display:flex;flex-direction:column;gap:6px"><span class="label">Текст</span>
          <textarea class="field" data-inp="notifyField" data-key="body" maxlength="300" rows="4" placeholder="Наприклад: завтра перша пара скасована">${esc(n.body)}</textarea></label>
        <div class="${n.cls} small" ${n.msg ? '' : 'hidden'}>${esc(n.msg)}</div>
        <button class="btn" data-act="notifySend" ${n.sending ? 'disabled' : ''}>${n.sending ? '<span class="spin"></span>' : 'Надіслати'}</button>`)}
      <div class="foot">Сповіщення прийде на всі пристрої обраної людини, де вона ввімкнула сповіщення (🔔 і число — кількість таких пристроїв, 🔕 — сповіщення не ввімкнені). Налаштування нагадувань на нього не впливають.</div>`;
  }

  async function loadNotifyUsers() {
    try {
      S.notify.users = await api('GET', '/api/admin/users');
      if (S.notify.userId !== 'all' && !S.notify.users.some((u) => u.id === S.notify.userId)) S.notify.userId = 'all';
    } catch (e) { S.notify.msg = e.message; S.notify.cls = 'err'; }
    render();
  }

  function pushStatusText() {
    const p = S.push;
    if (!p.supported) return isIOS && !isStandalone() ? 'Потрібна іконка на екрані «Додому»' : 'Не підтримується';
    if (p.permission === 'denied') return 'Заборонено';
    return p.subscribed ? 'Увімкнено на цьому пристрої' : 'Не увімкнено';
  }

  // ───────────── рейтинг ─────────────

  const fPts = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
  const ptsText = (p) => (p == null ? '—' : fPts.format(p));
  const shortName = (n) => String(n).split(' ').slice(0, 2).join(' ');
  const initialsOf = (n) => String(n).split(' ').slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();
  const medalOf = (r) => (r === 1 ? 'm1' : r === 2 ? 'm2' : r === 3 ? 'm3' : '');
  const studentsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'студент' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'студенти' : 'студентів');

  // quiet — фонове оновлення: помилки не показуються
  async function loadRating(group, quiet) {
    const R = S.rating;
    if (group !== undefined) R.group = group;
    R.err = '';
    try {
      const qs = [];
      if (isAdmin() && R.group) qs.push('group=' + encodeURIComponent(R.group));
      if (R.subject) qs.push('subject=' + encodeURIComponent(R.subject));
      R.data = await api('GET', '/api/rating' + (qs.length ? '?' + qs.join('&') : ''));
      if (isAdmin()) R.group = R.data.group;
      R.subject = R.data.subject || '';
    } catch (e) { if (!quiet) R.err = e.message; }
    render();
    sheets.filter((x) => x.isRatingAdmin).forEach(rerender);
  }

  function ratingTitle(key) { return (S.rating.data && S.rating.data.titles && S.rating.data.titles[key]) || key; }

  function rkRow(e) {
    return `<div class="rk ${medalOf(e.rank)} ${e.isMe ? 'me' : ''}" ${e.isMe ? 'id="rk-me"' : ''}>
      <span class="rk-pos">${e.rank != null ? e.rank : '–'}</span>
      <span class="rk-name">${esc(e.fullName)}${e.note ? ' ' + badge(e.note, 'accent') : ''}${e.isMe ? ' <i class="you">Ви</i>' : ''}</span>
      <b class="rk-pts">${esc(ptsText(e.points))}</b></div>`;
  }

  function viewRating() {
    const R = S.rating;
    const d = R.data;
    if (!d) {
      return R.err ? card(`<div class="err">${esc(R.err)}</div><button class="btn auto" data-act="ratingReload">Спробувати ще раз</button>`)
        : '<div class="loading"><span class="spin"></span></div>';
    }
    let bar = '';
    if (isAdmin() && (d.groups || []).length > 1) {
      bar += `<select class="field" data-chg="ratingGroup" aria-label="Група">${d.groups.map((g) => `<option value="${esc(g.name)}" ${g.name === d.group ? 'selected' : ''}>${esc(g.name)} · ${g.students}</option>`).join('')}</select>`;
    }
    if ((d.subjects || []).length) {
      bar += `<select class="field" data-chg="ratingSubject" aria-label="Предмет">
        <option value="" ${d.subject ? '' : 'selected'}>Загальний рейтинг (сума балів)</option>
        ${d.subjects.map((k) => `<option value="${esc(k)}" ${k === d.subject ? 'selected' : ''}>${esc(k)}${ratingTitle(k) !== k ? ' — ' + esc(ratingTitle(k)) : ''}</option>`).join('')}</select>`;
    }
    if (isAdmin()) bar += `<button class="btn small soft" data-act="ratingManage">${ic('edit', 16)} Керувати</button>`;
    let h = bar ? `<div class="rk-bar">${bar}</div>` : '';
    if (!d.group) {
      return h + ui.empty(isAdmin() ? 'users' : 'link', isAdmin() ? 'Груп ще немає' : (d.unassigned ? 'Обліковий запис ще не прив’язано до рейтингу' : 'Вас ще немає в рейтингу'),
        isAdmin() ? 'Натисніть «Керувати», створіть групу й додайте студентів або запустіть синхронізацію з Google-таблицею.'
          : (d.unassigned ? 'Адміністратор має прив’язати ваш обліковий запис до запису в рейтингу (Адміністрування → Керування → Учасники та пристрої).' : 'Перевірте, чи завантажено актуальну таблицю рейтингу.'));
    }
    const ranked = d.entries.filter((e) => e.rank != null);
    const unranked = d.entries.filter((e) => e.rank == null);
    const me = d.entries.find((e) => e.isMe);
    const sh = d.sheet || {};
    const asOf = sh.lastSuccessAt ? ` (станом на ${esc(fmt.when(sh.lastSuccessAt))})` : '';
    if (sh.enabled && sh.failing) {
      h += ui.notice('warn', isAdmin()
        ? `Не вдалося оновити дані з Google-таблиці${sh.error ? `: ${esc(sh.error)}` : ''}. Показано останні збережені бали${asOf}. <button class="link" data-act="go" data-tab="admin" data-sub="sync">Деталі синхронізації</button>`
        : `Не вдалося отримати свіжі дані з Google-таблиці. Показано останні збережені бали${asOf}.`);
    }
    if (d.archived) h += ui.notice('warn', 'Ваш запис у рейтингу групи архівовано. Якщо це помилка, зверніться до адміністратора.');
    if (me) {
      h += `<div class="card hero"><span class="label">Ваше місце · ${esc(d.group)}${d.subject ? ' · ' + esc(ratingTitle(d.subject)) : ''}</span>
        <div class="hero-main">
          <div class="hero-pos"><b>${me.rank != null ? me.rank : '—'}</b><span>${me.rank != null ? 'місце з ' + ranked.length : 'бали ще не внесено'}</span></div>
          <div class="hero-pts"><b>${esc(ptsText(me.points))}</b><span>${d.subject ? 'балів з предмета' : 'балів разом'}</span></div></div>
        <button class="btn deep auto" data-act="ratingJump">Показати мій рядок</button></div>`;
    } else {
      h += card(`<div class="card-title">Група ${esc(d.group)}</div>
        <div class="muted">${isAdmin() ? `Студентів у рейтингу: ${d.total}.` : 'Вас немає в рейтингу цієї групи — адміністратор ще не вніс ваші бали.'}</div>`);
    }
    if (ranked.length >= 3) {
      h += `<div class="card"><div class="podium">${[1, 0, 2].map((i) => { const e = ranked[i]; return `<div class="pd p${i + 1} ${medalOf(e.rank)} ${e.isMe ? 'me' : ''}">
        <div class="pd-av">${esc(initialsOf(e.fullName))}</div><div class="pd-name">${esc(shortName(e.fullName))}</div>
        <div class="pd-pts">${esc(ptsText(e.points))}</div><div class="pd-step">${e.rank}</div></div>`; }).join('')}</div></div>`;
    }
    h += `<div class="section"><div class="sec-head"><h2>${d.subject ? 'Рейтинг · ' + esc(ratingTitle(d.subject)) : 'Рейтинг групи'}</h2><span class="muted small">${d.total} ${studentsWord(d.total)}</span></div>
      <div class="rk-list">${ranked.length ? ranked.map(rkRow).join('') : `<div class="rk"><span class="muted">${d.subject ? 'З цього предмета балів ще ніхто не має' : 'Балів ще ніхто не має'}</span></div>`}</div></div>`;
    if (unranked.length) h += `<div class="section"><div class="sec-head"><h2>Без балів</h2></div><div class="rk-list">${unranked.map(rkRow).join('')}</div></div>`;
    const fresh = sh.enabled && sh.lastSuccessAt ? ` Дані з Google-таблиці перевірено ${esc(fmt.when(sh.lastSuccessAt))}.` : '';
    return h + `<div class="foot">Рейтинг оновлюється автоматично після синхронізації з Google-таблицею та після кожної зміни балів. Однакові бали — однакове місце.${fresh}</div>`;
  }

  // ───────────── керування рейтингом (адмін) ─────────────

  const ratingCols = () => {
    const cols = [...((S.rating.data && S.rating.data.subjects) || [])];
    for (const e of (S.rating.data && S.rating.data.entries) || []) for (const k of Object.keys(e.subjects || {})) if (!cols.includes(k)) cols.push(k);
    return cols;
  };

  // Блок «Завантажити таблицю рейтингу» (адмін): той самий принцип, що й для розкладу.
  function ratingUploadBlock() {
    const R = S.rating;
    const d = R.data;
    const st = d && d.syncStatus;
    return `<div class="card"><div class="card-title">Таблиця рейтингу</div>
        <div class="muted small">${!d ? 'Завантаження…' : d.subjects && d.subjects.length
          ? `Студентів у групі: ${d.total} · предмети: ${d.subjects.map(esc).join(', ')}` : 'Таблицю ще не завантажено'}</div>
        ${st && st.enabled ? `<div class="small ${st.lastError ? 'err' : 'muted'}">Google Sheets: ${st.lastError ? 'помилка синхронізації — ' + esc(st.lastError) : 'автоматичне оновлення увімкнено'}${st.lastSuccessAt ? ' · остання успішна перевірка: ' + esc(fmt.dateTime(st.lastSuccessAt)) : ''}</div>` : ''}
        <div class="btn-row"><button class="btn small soft" data-act="ratingSyncNow">${ic('refresh', 16)} Оновити з Google Sheets</button>
          <label class="btn small ghost" style="cursor:pointer">${ic('upload', 16)} Завантажити файл (.xlsx, .xls, .csv)
            <input type="file" data-chg="ratingFile" accept=".xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden></label></div>
        <div class="ratingMsg ${R.msg.cls} small" ${R.msg.text ? '' : 'hidden'}>${esc(R.msg.text)}</div>
        <div class="muted small">Файл: перша колонка — ПІБ, далі — бали за предметами. Імпорт файлу — рішення адміністратора: він замінює бали групи (включно зі зміненими студентами), відсутніх у файлі студентів архівує; усі зміни записуються в історію.</div></div>`;
  }

  function openRatingAdmin() {
    const s = { auto: false, isRatingAdmin: true, form: null, title: () => (s.form ? (s.form.id ? 'Студент' : 'Новий студент') : 'Керування рейтингом') };
    s.render = () => {
      const d = S.rating.data;
      if (!d) return '<div class="muted">Завантаження…</div>';
      if (s.form) return ratingFormHTML(s.form, d);
      const opts = (d.groups || []).map((g) => `<option value="${esc(g.name)}" ${g.name === d.group ? 'selected' : ''}>${esc(g.name)} · ${g.students}</option>`).join('');
      let h = ratingUploadBlock();
      h += '<div class="muted small">Зміни одразу бачать студенти групи. Бали «Разом» можна змінювати прямо в списку, а бали за предметами — у картці студента.</div>';
      if ((d.groups || []).length > 1 || !d.group) h += card(`<span class="label">Група</span>
        <select class="field" data-chg="ratingGroup" ${opts ? '' : 'disabled'}>${opts || '<option>Груп ще немає</option>'}</select>
        <div class="btn-row"><button class="btn deep" data-act="groupsManage">${ic('layers', 18)} Керувати групами</button></div>`);
      if (!d.group) return h;
      h += `<button class="btn" data-act="ratingAdd">${ic('plus', 18)} Додати студента</button>`;
      h += d.entries.length ? `<div class="list">${d.entries.map((e) => `<div class="ra-row">
          <button class="ra-name" data-act="ratingEdit" data-id="${esc(e.id)}"><span class="rk-pos ${medalOf(e.rank)}">${e.rank != null ? e.rank : '–'}</span><span>${esc(e.fullName)}${e.note ? ' <small class="muted">· ' + esc(e.note) + '</small>' : ''}</span></button>
          <input class="field ra-pts" type="number" inputmode="decimal" min="0" step="any" placeholder="—" value="${e.points != null ? e.points : ''}" data-prev="${e.points != null ? e.points : ''}" data-chg="ratingPts" data-id="${esc(e.id)}" aria-label="Бали: ${esc(e.fullName)}">
          <button class="icon-btn danger" data-act="ratingDel" data-id="${esc(e.id)}" data-name="${esc(e.fullName)}" aria-label="Видалити">${ic('trash', 18)}</button></div>`).join('')}</div>`
        : card('<span class="muted">У цій групі ще немає студентів.</span>');
      return h;
    };
    openSheet(s);
    loadRating();
  }

  function ratingFormHTML(f, d) {
    const cols = ratingCols();
    const gopts = (d.groups || []).map((g) => `<option value="${esc(g.name)}" ${g.name === f.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
    return `<div class="form">
      <label><span class="label">ПІБ</span><input class="field" name="fullName" autocapitalize="words" placeholder="Прізвище Ім’я По батькові" value="${esc(f.fullName)}"></label>
      <label><span class="label">Група</span><select class="field" name="group">${gopts}</select></label>
      <label><span class="label">Бали (разом)</span><input class="field" name="points" type="number" inputmode="decimal" min="0" step="any" placeholder="Порожньо — без балів" value="${f.points != null ? esc(f.points) : ''}"></label>
      <label><span class="label">Примітка</span><input class="field" name="note" maxlength="60" placeholder="Наприклад: староста" value="${esc(f.note)}"></label>
      <div class="label">Бали за предметами (необов’язково — сума підставляється в «Разом»)</div>
      <div class="subj-grid">${cols.map((c) => `<label><span class="small muted">${esc(c)}</span><input class="field" name="s_${esc(c)}" type="number" inputmode="decimal" min="0" step="any" data-inp="ratingSubj" value="${f.subjects[c] != null ? esc(f.subjects[c]) : ''}"></label>`).join('')}</div>
      <div class="subj-grid"><label><span class="small muted">Інший предмет</span><input class="field" name="x_name" maxlength="20" placeholder="Назва"></label>
        <label><span class="small muted">Бали</span><input class="field" name="x_val" type="number" inputmode="decimal" min="0" step="any" data-inp="ratingSubj"></label></div>
      <div class="muted small" data-role="msg"></div>
      <div class="btn-row"><button class="btn deep" data-act="ratingCancel">Скасувати</button><button class="btn" data-act="ratingSave">Зберегти</button></div></div>`;
  }

  function ratingFormBody(el) {
    const root = sheetOf(el).el;
    const v = (n) => { const i = root.querySelector(`[name="${n}"]`); return i ? i.value.trim() : ''; };
    const subjects = {};
    root.querySelectorAll('[name^="s_"]').forEach((i) => { subjects[i.name.slice(2)] = i.value.trim() === '' ? null : i.value.trim(); });
    if (v('x_name') && v('x_val') !== '') subjects[v('x_name')] = v('x_val');
    return { fullName: v('fullName'), group: v('group'), points: v('points') === '' ? null : v('points'), note: v('note'), subjects };
  }

  async function ratingSavePts(el) {
    const raw = el.value.trim();
    if (raw === el.dataset.prev) return;
    try {
      await api('PATCH', `/api/admin/rating/${encodeURIComponent(el.dataset.id)}`, { points: raw === '' ? null : raw });
      toast('Бали збережено');
      await loadRating();
    } catch (e) { toast(e.message); el.value = el.dataset.prev; }
  }

  // ───────────── керування (адміністратор, староста) ─────────────

  function tile(act, icon, title, sub, extra = '', attrs = '') {
    return `<button class="tile" data-act="${act}" ${attrs}><span class="tile-ic">${ic(icon, 20)}</span><span class="tile-t">${title}<small>${sub}</small></span>${extra}<span class="tile-go">${ic('right', 16)}</span></button>`;
  }

  /** «Адміністрування → Керування»: усе адміністрування поза аналітикою журналу. */
  function viewManage() {
    return `<div class="section"><div class="sec-head"><h2>Журнал і рейтинг</h2></div><div class="tiles">
        ${tile('users', 'users', 'Учасники та пристрої', 'Ролі, групи, прив’язка до рейтингу, довіра до пристроїв', S.deviceRequests ? badge(String(S.deviceRequests), 'warn') : '')}
        ${tile('ratingManage', 'trophy', 'Студенти й групи', 'Записи рейтингу, групи, ручне редагування')}
        ${tile('catalogOpen', 'target', 'Предмети рейтингу', 'Повні назви й максимальні бали')}
        ${tile('importOpen', 'upload', 'Імпорт таблиці з файлу', 'Excel або CSV, якщо Google-таблиця недоступна')}
        ${tile('go', 'star', 'Оцінки', 'Перегляд і перевірка нових оцінок', '', 'data-tab="admin" data-sub="grades"')}
        ${tile('go', 'bell', 'Надіслати сповіщення', 'Повідомлення на пристрої студентів', '', 'data-tab="admin" data-sub="notify"')}
      </div></div>
      ${modBlocks(true)}`;
  }

  // Блоки «Розклад» і «Навчальний процес» — для адміністратора (Керування) та старости/заступника (Налаштування).
  function modBlocks(inAdmin) {
    const q = moderationQueue().length;
    return `<div class="grid c2">
      <div class="card"><div><div class="card-title">Розклад</div>
          <div class="card-sub">${S.lessons.length ? `${S.scheduleTitle ? esc(S.scheduleTitle) + ' · ' : ''}Пар: ${S.lessons.length}${scheduleRange()}` : 'Розклад не завантажено'}</div></div>
        <label class="btn soft" style="cursor:pointer">${ic('upload', 18)} Завантажити розклад (.xls, .xlsx, .csv)
          <input type="file" id="schedFile" data-chg="schedFile" accept=".xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden></label>
        <div id="schedMsg" class="${S.schedMsg.cls} small" ${S.schedMsg.text ? '' : 'hidden'}>${esc(S.schedMsg.text)}</div>
        <div class="muted small">Файл розбирається у браузері й одразу стає доступним усім. Новий файл замінює пари від його першої дати; домашнє й посилання зберігаються.</div></div>
      <div class="card"><div class="card-title">Навчальний процес</div>
        <div class="list" style="box-shadow:none;border:0;margin:0 -20px -20px;border-radius:0 0 var(--r-lg) var(--r-lg)">
        ${tile('moderation', 'book', 'Домашнє на підтвердження', 'Перевірка завдань від студентів', q ? badge(String(q), 'warn') : '')}
        ${tile('subjects', 'calendar', 'Предмети й посилання', 'Повні назви, Zoom / Meet')}
        ${tile('teachers', 'users', 'Викладачі', 'ПІБ викладачів у розкладі')}
        ${isAdmin() && !inAdmin ? tile('users', 'shield', 'Учасники та пристрої', 'Прив’язка студентів, ролі, запити на вхід', S.deviceRequests ? badge(String(S.deviceRequests), 'warn') : '') : ''}
      </div></div></div>`;
  }

  const roleTitle = (u = S.user) => (u && u.isAdmin ? 'Адміністратор' : u && ROLE_TITLES[u.role] ? ROLE_TITLES[u.role] : 'Студент');

  function viewSettings() {
    const st = S.settings;
    const toggle = (key, label, sub) => `<label class="row"><span>${label}${sub ? `<small class="muted" style="display:block;font-size:12.5px">${sub}</small>` : ''}</span><span class="toggle"><input type="checkbox" data-chg="setting" data-key="${key}" ${st[key] ? 'checked' : ''}><span></span></span></label>`;
    const theme = LS.get('theme', 'auto');
    let h = '<div class="grid c2"><div class="home-col">';
    h += `<div><span class="label gl">Акаунт</span><div class="list">
      <div class="row"><span class="hstack"><span class="ava">${esc(initialsOf(S.user.fullName))}</span><span><b>${esc(S.user.fullName)}</b><small class="muted" style="display:block">${esc(roleTitle())}${S.user.studentName ? ' · рейтинг: ' + esc(S.user.studentName) : ''}</small></span></span></div>
      ${S.syncError ? `<div class="err">${esc(S.syncError)}</div>` : ''}
      <button class="row" data-act="sync"><span>Оновити дані</span>${ic('refresh', 18)}</button>
      <button class="row" data-act="share"><span>Поділитися посиланням на щоденник</span>${ic('external', 18)}</button>
      <button class="row" data-act="logout"><span style="color:var(--red)">Вийти</span></button>
    </div>${!isMod() ? '<div class="foot">Посилання на пари й імена викладачів налаштовують адміністратор і староста.</div>' : ''}</div>`;
    h += `<div><span class="label gl">Тема оформлення</span><div class="seg" role="group" aria-label="Тема">${[['auto', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']].map(([k, t]) => `<button class="${theme === k ? 'on' : ''}" data-act="theme" data-mode="${k}">${t}</button>`).join('')}</div></div>`;
    h += hookHtml('prefs');
    h += '</div><div class="home-col">';
    h += installHint();
    h += `<div><span class="label gl">Сповіщення на цьому пристрої</span><div class="list">
      ${toggle('notificationsEnabled', 'Нагадувати про пари')}
      <div class="row"><span>За ${st.leadMinutes} хв до початку</span><span class="stepper">
        <button data-act="lead" data-d="-1" aria-label="Менше">−</button><b>${st.leadMinutes}</b><button data-act="lead" data-d="1" aria-label="Більше">+</button></span></div>
      ${toggle('askHomework', 'Питати про домашнє після пари')}
      ${toggle('notifyHomework', 'Повідомляти про нове домашнє')}
      ${toggle('notifyProgress', 'Успішність', 'Зміни балів, рейтингу й підсумки дня')}
      ${toggle('autoOpenLink', 'Одразу відкривати посилання на пару')}
      <div class="row"><span>Стан на цьому пристрої</span><span class="${S.push.permission === 'denied' ? 'err' : 'muted'} small" style="text-align:right">${esc(pushStatusText())}</span></div>
      ${S.push.supported && S.push.permission !== 'denied'
        ? (S.push.subscribed
          ? '<button class="row" data-act="pushOff"><span>Вимкнути на цьому пристрої</span></button><button class="row" data-act="pushTest"><span style="color:var(--accent)">Надіслати тестове сповіщення</span></button>'
          : '<button class="row" data-act="pushOn"><span style="color:var(--accent);font-weight:600">Увімкнути сповіщення</span></button>')
        : ''}
      ${S.push.permission === 'denied' ? '<div class="muted small">Сповіщення заборонено в налаштуваннях пристрою чи браузера. Дозвольте їх там і поверніться сюди.</div>' : ''}
      ${S.installEvent ? '<button class="row" data-act="install"><span style="color:var(--accent)">Встановити застосунок</span></button>' : ''}
    </div><div class="foot">Сповіщення приходять із сервера, тому працюють, навіть коли щоденник закрито. Дозвіл і підписка — окремі для кожного пристрою.</div></div>`;
    h += '</div></div>';
    if (isMod() && !isAdmin()) h += modBlocks(false);
    return h;
  }

  function scheduleRange() {
    if (!S.lessons.length) return '';
    const a = S.lessons.reduce((m, l) => (l.start < m ? l.start : m), S.lessons[0].start);
    const b = S.lessons.reduce((m, l) => (l.start > m ? l.start : m), S.lessons[0].start);
    return ` · ${dayMonth(a)} – ${dayMonth(b)}`;
  }

  // ───────────── навігація й оболонка ─────────────

  const NAV = [
    { id: 'today', title: 'Головна', short: 'Головна', icon: 'home' },
    { id: 'schedule', title: 'Розклад', short: 'Розклад', icon: 'calendar' },
    { id: 'homework', title: 'Домашнє завдання', short: 'Домашнє', icon: 'book' },
    {
      id: 'progress', title: 'Успішність', short: 'Успішність', icon: 'chart', subs: [
        { id: 'scores', title: 'Мої бали', icon: 'target' },
        { id: 'rating', title: 'Рейтинг групи', icon: 'trophy' },
        { id: 'stats', title: 'Статистика', icon: 'bars' },
      ],
    },
    {
      id: 'admin', title: 'Адміністрування', short: 'Адмін', icon: 'shield', admin: true, subs: [
        { id: 'overview', title: 'Огляд', icon: 'grid' },
        { id: 'analytics', title: 'Аналітика', icon: 'chart' },
        { id: 'students', title: 'Студенти', icon: 'users' },
        { id: 'groups', title: 'Групи', icon: 'layers' },
        { id: 'sync', title: 'Google Sheets', icon: 'sheet' },
        { id: 'conflicts', title: 'Конфлікти', icon: 'alert' },
        { id: 'history', title: 'Історія балів', icon: 'clock' },
        { id: 'audit', title: 'Журнал дій', icon: 'list' },
        { id: 'manage', title: 'Керування', icon: 'gear' },
        { id: 'student', title: 'Студент', hidden: true, back: 'students' },
        { id: 'grades', title: 'Оцінки', hidden: true, back: 'manage' },
        { id: 'notify', title: 'Сповіщення студентам', hidden: true, back: 'manage' },
      ],
    },
    { id: 'notifications', title: 'Сповіщення', short: 'Сповіщення', icon: 'bell', hideInTabbar: true },
    {
      id: 'settings', title: 'Профіль', short: 'Профіль', icon: 'user', subs: [
        { id: 'profile', title: 'Профіль', icon: 'user' },
        { id: 'prefs', title: 'Налаштування', icon: 'gear' },
      ],
    },
  ];
  const navVisible = () => NAV.filter((t) => !t.admin || isAdmin());
  const navTab = (id) => navVisible().find((t) => t.id === id);

  // Сторінки: вбудовані тут і зареєстровані модулями (progress.js, admin.js) через Diary.register().
  const PAGES = {
    today: { render: viewToday },
    schedule: { render: viewSchedule },
    homework: { render: viewHomework },
    'progress/rating': { render: viewRating, enter: () => loadRating() },
    'admin/manage': { render: viewManage },
    'admin/grades': { render: viewGrades, enter: () => loadGrades() },
    'admin/notify': { render: viewNotify, enter: () => loadNotifyUsers() },
    'settings/prefs': { render: viewSettings },
  };
  const HOOKS = {};
  const CHG = {};
  const INP = {};
  function runHooks(name, ...args) {
    for (const fn of HOOKS[name] || []) { try { fn(...args); } catch (e) { console.error(e); } }
  }
  function hookHtml(name) {
    return (HOOKS[name] || []).map((fn) => { try { return fn() || ''; } catch (e) { console.error(e); return ''; } }).join('');
  }

  function badgeFor(id) {
    if (id === 'homework') return moderationQueue().length;
    if (id === 'admin') return S.deviceRequests + S.openConflicts;
    if (id === 'admin/conflicts') return S.openConflicts;
    if (id === 'admin/manage') return S.deviceRequests + moderationQueue().length;
    if (id === 'notifications') return S.unread;
    return 0;
  }
  const dot = (n) => (n ? `<span class="dot">${n > 99 ? '99+' : n}</span>` : '');

  function currentPage() {
    const t = navTab(S.tab) || navTab('today');
    S.tab = t.id;
    let sub = null;
    if (t.subs) {
      sub = t.subs.find((x) => x.id === S.sub[t.id]) || t.subs[0];
      S.sub[t.id] = sub.id;
    }
    const key = sub ? `${t.id}/${sub.id}` : t.id;
    const page = PAGES[key] || { render: () => ui.loading() };
    return { key, tab: t, sub, page, title: (page.title && page.title()) || (sub ? sub.title : t.title) };
  }

  /** Перехід на сторінку (вкладка + підрозділ) із завантаженням її даних. */
  function go(tab, sub, opts = {}) {
    S.tab = tab;
    if (sub) S.sub[tab] = sub;
    LS.set('subs', { progress: S.sub.progress, settings: S.sub.settings });
    const cur = currentPage();
    if (cur.page.enter && opts.enter !== false) cur.page.enter(opts);
    render();
    const m = $('main.content');
    if (m) m.scrollTop = 0;
  }

  function sidebarHTML(cur) {
    const item = (tab, sub, icon, title, n) => {
      const active = cur.tab.id === tab && (!sub || cur.sub.id === sub || cur.sub.back === sub);
      return `<button class="sb-item ${active ? 'active' : ''}" data-act="go" data-tab="${tab}" ${sub ? `data-sub="${sub}"` : ''}>${ic(icon, 19)}<span>${title}</span>${dot(n)}</button>`;
    };
    let h = `<div class="sb-inner"><div class="sb-brand"><img src="/icons/icon-192.png" alt=""><div><b>Щоденник</b><small>Журнал успішності</small></div></div>`;
    h += '<div class="sb-label">Навчання</div>' + item('today', null, 'home', 'Головна') + item('schedule', null, 'calendar', 'Розклад') + item('homework', null, 'book', 'Домашнє завдання', badgeFor('homework'));
    h += '<div class="sb-label">Успішність</div>' + navTab('progress').subs.map((s) => item('progress', s.id, s.icon, s.title)).join('');
    if (isAdmin()) h += '<div class="sb-label">Адміністрування</div>' + navTab('admin').subs.filter((s) => !s.hidden).map((s) => item('admin', s.id, s.icon, s.title, badgeFor('admin/' + s.id))).join('');
    h += '<div class="sb-spacer"></div>' + item('notifications', null, 'bell', 'Сповіщення', S.unread) + item('settings', 'prefs', 'gear', 'Налаштування');
    h += `<button class="sb-user" data-act="go" data-tab="settings" data-sub="profile"><span class="ava">${esc(initialsOf(S.user.fullName))}</span><span class="who"><b>${esc(S.user.fullName)}</b><small>${esc(roleTitle())}</small></span></button></div>`;
    return h;
  }

  let lastKey = null;
  /** soft — фонове оновлення: не перемальовуємо, поки людина вводить текст. */
  function render(opts = {}) {
    const app = $('#app');
    if (!S.user) {
      removePushAsk();
      if (S.token) { app.innerHTML = '<div class="login-wrap"><span class="spin" style="width:28px;height:28px"></span></div>'; return; }
      if (!$('#loginForm')) app.innerHTML = viewLogin();
      return;
    }
    const a = document.activeElement;
    const typing = !!(a && a.closest && a.closest('main.content') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    if (opts.soft && typing) return;
    const focus = typing && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
    const oldMain = $('main.content');
    const y = oldMain ? oldMain.scrollTop : 0;
    const cur = currentPage();
    const entering = lastKey !== cur.key;
    lastKey = cur.key;
    const back = cur.sub && cur.sub.back ? cur.sub.back : null;
    const subnav = cur.tab.subs && !back ? cur.tab.subs.filter((s) => !s.hidden) : null;
    app.innerHTML = `
      <aside class="sidebar">${sidebarHTML(cur)}</aside>
      <div class="main">
        <header class="topbar"><div class="tb-l">${back ? `<button class="icon-btn" data-act="go" data-tab="${cur.tab.id}" data-sub="${back}" aria-label="Назад">${ic('left', 22)}</button>` : ''}
            <div style="min-width:0">${cur.sub && cur.tab.subs.length > 2 ? `<span class="crumb">${esc(cur.tab.title)}</span>` : ''}<h1>${esc(cur.title)}</h1></div></div>
          <div class="right">
            ${cur.tab.id === 'schedule' ? '<button class="link" data-act="goToday">Сьогодні</button>' : ''}
            <button class="icon-btn ${S.syncing ? 'refreshing' : ''}" data-act="sync" aria-label="Оновити" title="Оновити">${ic('refresh', 20)}</button>
            <button class="icon-btn" data-act="go" data-tab="notifications" aria-label="Сповіщення" title="Сповіщення">${ic('bell', 21)}${dot(S.unread)}</button>
          </div></header>
        <main class="content ${entering ? 'enter' : ''}"><div class="page">
          ${subnav ? `<nav class="subnav tb-mobile ${subnav.length <= 4 ? 'fit' : ''}" aria-label="Розділи">${subnav.map((s) => `<button class="${s.id === cur.sub.id ? 'on' : ''}" data-act="go" data-tab="${cur.tab.id}" data-sub="${s.id}" ${s.id === cur.sub.id ? 'aria-current="page"' : ''}>${esc(s.title)}${dot(badgeFor(cur.tab.id + '/' + s.id))}</button>`).join('')}</nav>` : ''}
          ${cur.page.render()}
        </div></main>
        <nav class="tabbar" aria-label="Навігація"><div class="tabbar-in">${navVisible().filter((t) => !t.hideInTabbar).map((t) => `
          <button class="tab ${t.id === cur.tab.id ? 'active' : ''}" data-act="go" data-tab="${t.id}">${ic(t.icon, 22)}<span>${t.short}</span>${dot(badgeFor(t.id))}</button>`).join('')}</div></nav>
      </div>`;
    const newMain = $('main.content');
    if (newMain) newMain.scrollTop = y;
    // Довгий ряд підрозділів на телефоні: активний пункт завжди видно (по центру ряду).
    const sn = $('.subnav:not(.fit)', app);
    const on = sn && $('.on', sn);
    if (on && sn.scrollWidth > sn.clientWidth) sn.scrollLeft = Math.max(0, on.offsetLeft - sn.offsetLeft - (sn.clientWidth - on.offsetWidth) / 2);
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch (e) { /* поле без курсора */ } }
    }
    refreshSheets();
    if (window.Charts) Charts.mount(app);
  }

  function viewLogin() {
    return `<div class="login-wrap"><div class="login">
      <img class="logo" src="/icons/icon-192.png" alt="">
      <div><h1>Щоденник студента</h1><div class="muted">Розклад, домашнє завдання, бали та статистика успішності в одному місці</div></div>
      <form id="loginForm" autocomplete="on">
        <div class="card">
          <label class="label" for="fullName">Прізвище, ім’я та по батькові</label>
          <input class="field" id="fullName" name="name" type="text" autocomplete="name" autocapitalize="words" autocorrect="off" spellcheck="false" placeholder="Іваненко Іван Іванович" required>
          <div id="passWrap" ${S.needPassword ? '' : 'hidden'} style="display:${S.needPassword ? 'flex' : 'none'};flex-direction:column;gap:10px">
            <label class="label" for="adminPass">Пароль адміністратора</label>
            <input class="field" id="adminPass" type="password" autocomplete="current-password" placeholder="Потрібен для нового пристрою">
          </div>
          <div class="muted small">Під цим ПІБ вас бачитиме адміністратор. Вхід із нового пристрою може потребувати його підтвердження.</div>
          <div id="loginErr" class="err" style="text-align:center">${esc(loginNotice)}</div>
          <button class="btn big" id="loginBtn" type="submit">Увійти</button>
        </div>
      </form>
    </div></div>`;
  }

  // ───────────── шторки (модальні вікна) ─────────────

  const sheets = [];

  function sheetHTML(s) {
    const title = typeof s.title === 'function' ? s.title() : s.title;
    return `<div class="sheet ${s.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="sh-head"><div class="side"><button class="link" data-act="closeSheet">${esc(s.closeLabel || 'Закрити')}</button></div>
        <h2>${esc(title)}</h2><div class="side r">${s.right ? s.right() : ''}</div></div>
      <div class="sh-body">${s.render()}</div></div>`;
  }

  function openSheet(s) {
    s.el = document.createElement('div');
    s.el.className = 'overlay';
    s.el.innerHTML = sheetHTML(s);
    $('#sheets').appendChild(s.el);
    sheets.push(s);
    document.body.classList.add('noscroll');
    history.pushState({ sheet: sheets.length }, '');
    if (window.Charts) Charts.mount(s.el);
    return s;
  }

  function rerender(s) {
    const body = $('.sh-body', s.el);
    const keep = {};
    s.el.querySelectorAll('[name]').forEach((i) => { keep[i.name] = i.value; });
    const top = body.scrollTop;
    const title = typeof s.title === 'function' ? s.title() : s.title;
    $('h2', s.el).textContent = title;
    body.innerHTML = s.render();
    s.el.querySelectorAll('[name]').forEach((i) => { if (i.name in keep) i.value = keep[i.name]; });
    body.scrollTop = top;
    if (window.Charts) Charts.mount(s.el);
  }

  function refreshSheets() {
    for (const s of sheets) {
      if (s.auto === false) continue;
      const a = document.activeElement;
      if (a && s.el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) continue;
      rerender(s);
    }
  }

  const closeSheet = () => { if (sheets.length) history.back(); };

  function closeAllSheets() {
    while (sheets.length) sheets.pop().el.remove();
    document.body.classList.remove('noscroll');
  }

  window.addEventListener('popstate', () => {
    if (!sheets.length) return;
    sheets.pop().el.remove();
    if (!sheets.length) document.body.classList.remove('noscroll');
  });

  const sheetOf = (el) => { const o = el.closest('.overlay'); return o ? sheets.find((s) => s.el === o) : null; };

  function openLesson(id, opts) {
    const l = lessonById(id);
    if (!l) { toast('Пару не знайдено'); return; }
    openSheet({ title: () => { const x = lessonById(id); return x ? subjName(x.subjectKey) : 'Пара'; }, render: () => lessonBody(id) });
    if (opts && opts.join && S.settings.autoOpenLink) {
      const u = joinURL(l.subjectKey);
      if (u) { try { window.open(u, '_blank', 'noopener'); } catch (e) { /* браузер міг заблокувати */ } }
    }
  }

  function lessonBody(id) {
    const l = lessonById(id);
    if (!l) return '<div class="muted">Пару не знайдено</div>';
    const url = joinURL(l.subjectKey);
    const color = subjColor(l.subjectKey);
    const lh = lessonHomework(l);
    const hwItem = (h) => `<div class="hw-item"><div class="txt" style="white-space:pre-wrap;word-break:break-word">${esc(h.text)}</div>${attHTML(h)}
          <div class="muted small">До ${dayMonth(h.due)} ${hwBadge(h)}</div></div>`;
    return `
      ${card(`
        <div class="hstack"><div class="avatar" style="background:${color}38;color:${color}">${esc(l.subjectKey.charAt(0).toUpperCase())}</div>
          <div><div class="next-title">${esc(subjName(l.subjectKey))}</div>
            <div class="muted small">${esc(kindTitle(l))}${l.topic ? ' · ' + esc(l.topic) : ''}</div></div></div>
        <hr class="sep">
        <div class="info"><span>Коли</span><span>${weekdayName(l.start)}, ${dayMonth(l.start)}</span></div>
        <div class="info"><span>Час</span><span>${hm(l.start)} – ${hm(l.end)} (${l.pair} пара)</span></div>
        <div class="info"><span>Де</span><span>${esc(placeTitle(l))}</span></div>
        ${l.teacher ? `<div class="info"><span>Викладач</span><span>${esc(teacherName(l.teacher))}</span></div>` : ''}`)}
      ${url ? `<a class="btn green big" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic('video', 20)} Приєднатися до пари</a>` : ''}
      ${isMod() ? card(`
        <span class="label">Посилання на пару</span>
        <input class="field" name="link" type="url" inputmode="url" autocapitalize="none" autocorrect="off" placeholder="https://zoom.us/j/… або Meet / Teams" value="${esc((S.subjects[l.subjectKey] && S.subjects[l.subjectKey].link) || '')}">
        <div class="muted small">Посилання діє для всього предмета й одразу з’являється в усіх студентів.</div>
        <div class="muted small" data-role="msg"></div>
        <button class="btn deep" data-act="saveLink" data-key="${esc(l.subjectKey)}">Зберегти посилання</button>`) : ''}
      ${card(`
        <span class="label">Домашнє на пару · ${dayMonth(l.start)}</span>
        ${lh.given.length ? lh.given.map(hwItem).join('') : '<div class="muted">На цій парі нічого не записано</div>'}
        <button class="btn" data-act="hwNew" data-lesson="${esc(l.id)}">${isMod() ? 'Записати домашнє' : 'Запропонувати домашнє'}</button>`)}
      ${lh.due.length ? card(`
        <span class="label">Потрібно здати на цю пару</span>
        ${lh.due.map(hwItem).join('')}`) : ''}`;
  }

  function openHomeworkView(h0) {
    const cur = () => S.homework.find((x) => x.id === h0.id) || h0;
    return openSheet({
      viewId: h0.id,
      title: 'Домашнє',
      right: () => canEdit(cur()) ? '<button class="link" data-act="hwEditFromView">Редагувати</button>' : '',
      render: () => {
        const h = cur();
        const links = (h.links || []).map((u) => `<a class="chip-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(shortUrl(u))}</a>`).join('');
        const imgs = (h.images || []).map((id) => `<button class="full-btn" data-act="imgOpen" data-id="${esc(id)}" aria-label="Відкрити зображення">${imgTag(id, 'full')}</button>`).join('');
        return card(`<div class="subj" style="color:${subjColor(h.subjectKey)};font-size:12px;font-weight:700">${esc(subjName(h.subjectKey))} ${hwBadge(h)}</div>
          <div style="white-space:pre-wrap;word-break:break-word">${esc(h.text)}</div>
          <div class="muted small">До ${dayMonth(h.due)}${h.authorName ? ' · додав(ла): ' + esc(h.authorName) : ''}</div>`)
          + (links ? card(`<span class="label">Посилання</span><div class="att">${links}</div>`) : '')
          + (imgs ? card(`<span class="label">Зображення</span>${imgs}`) : '');
      },
    });
  }

  function openHomeworkForm(item) {
    item.links = (item.links || []).slice();
    item.images = (item.images || []).slice();
    const editing = !!item.id && S.homework.some((h) => h.id === item.id);
    const keys = subjectKeys();
    if (item.subjectKey && !keys.includes(item.subjectKey)) keys.push(item.subjectKey);
    const cur = editing ? S.homework.find((h) => h.id === item.id) : null;
    const sheet = {
      auto: false,
      closeLabel: 'Скасувати',
      item, editing, uploading: 0,
      title: editing ? 'Домашнє' : 'Нове домашнє',
      right: () => `<button class="link" data-act="hwSave">${editing ? 'Зберегти' : isMod() ? 'Додати' : 'Надіслати'}</button>`,
      render: () => `<div class="form">
        <label><span class="label">Предмет</span><select class="field" name="subject" data-chg="hwDue">
          ${keys.map((k) => `<option value="${esc(k)}" ${k === item.subjectKey ? 'selected' : ''}>${esc(subjName(k))}</option>`).join('')}</select></label>
        <label><span class="label">Що задали</span><textarea class="field" name="text" rows="5" placeholder="Що задали">${esc(item.text)}</textarea></label>
        <label><span class="label">Здати до</span>
          <select class="field" name="dueMode" data-chg="hwDue">${dueModeOptions(item.subjectKey, dueBase(item), item.dueMode || 'date')}</select></label>
        <input class="field" type="date" name="due" value="${toInput(item.due)}" ${(item.dueMode || 'date') !== 'date' ? 'readonly tabindex="-1" style="pointer-events:none;opacity:.7"' : ''}>
        <div class="muted small" data-role="dueHint">${esc(dueHint(item.subjectKey, dueBase(item), item.dueMode || 'date'))}</div>
        <div class="att-edit">
          <span class="label">Посилання</span>
          ${item.links.map((u, i) => `<div class="att-row"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(u))}</a><button type="button" class="link" data-act="linkDel" data-i="${i}" aria-label="Прибрати">✕</button></div>`).join('')}
          ${item.links.length < MAX_LINKS ? `<div class="att-add"><input class="field" name="linkInput" type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Вставте посилання"><button type="button" class="btn deep" data-act="linkAdd">Додати</button></div>` : ''}
          <span class="label">Зображення</span>
          ${item.images.length || sheet.uploading ? `<div class="thumbs">${item.images.map((id, i) => `<div class="thumb"><button type="button" class="thumb-btn" data-act="imgOpen" data-id="${esc(id)}" aria-label="Відкрити зображення">${imgTag(id)}</button><button type="button" class="x" data-act="imgDel" data-i="${i}" aria-label="Прибрати">✕</button></div>`).join('')}${sheet.uploading ? '<div class="thumb"><span class="spin"></span></div>' : ''}</div>` : ''}
          ${item.images.length < MAX_IMAGES ? `<label class="btn deep att-pick">Додати зображення<input type="file" accept="image/*" multiple data-chg="hwImages" hidden></label>` : ''}
        </div>
        ${!isMod() && !editing ? '<div class="muted small">Завдання з’явиться в усіх після того, як його підтвердить адміністратор, староста чи заступник.</div>' : ''}
        ${editing && cur && cur.status === 'rejected' ? '<div class="muted small">Це завдання відхилили. Виправте його й надішліть знову.</div>' : ''}
        <div class="err" data-role="err"></div>
        ${!editing && item.lessonID ? `<button class="btn deep" data-act="hwNone" data-lesson="${esc(item.lessonID)}">Нічого не задали</button>` : ''}
        ${editing && canEdit(cur || item) ? '<button class="btn red" data-act="hwDelete">Видалити</button>' : ''}
      </div>`,
    };
    return openSheet(sheet);
  }

  function openModeration() {
    openSheet({
      title: 'На підтвердження',
      render: () => {
        const q = moderationQueue();
        if (!q.length) return card('<span class="muted">Немає завдань на підтвердження</span>');
        return q.map((h) => card(`
          <div class="subj" style="color:${subjColor(h.subjectKey)};font-size:12px;font-weight:700">${esc(subjName(h.subjectKey))}</div>
          <div style="white-space:pre-wrap;word-break:break-word">${esc(h.text)}</div>${attHTML(h)}
          <div class="muted small">До ${dayMonth(h.due)} · додав(ла): ${esc(h.authorName)}</div>
          <div class="btn-row"><button class="btn green" data-act="approve" data-id="${esc(h.id)}">Підтвердити</button>
            <button class="btn red" data-act="reject" data-id="${esc(h.id)}">Відхилити</button></div>
          <button class="btn deep" data-act="hwEdit" data-id="${esc(h.id)}">Редагувати</button>`)).join('');
      },
    });
  }

  function openSubjects() {
    openSheet({
      auto: false,
      title: 'Предмети',
      render: () => {
        const keys = subjectKeys();
        if (!keys.length) return card('<span class="muted">Спочатку завантажте розклад</span>');
        return keys.map((k) => {
          const info = S.subjects[k] || {};
          return card(`<span class="label">${esc(k)}</span>
            <input class="field" name="name" placeholder="Повна назва" value="${esc(info.fullName || '')}">
            <input class="field" name="link" type="url" inputmode="url" autocapitalize="none" autocorrect="off" placeholder="Посилання на пару (Zoom / Meet / Teams)" value="${esc(info.link || '')}">
            <div class="muted small" data-role="msg"></div>
            <button class="btn deep" data-act="saveSubject" data-key="${esc(k)}">Зберегти</button>`);
        }).join('');
      },
    });
  }

  function openTeachers() {
    openSheet({
      auto: false,
      title: 'Викладачі',
      render: () => {
        const keys = teacherKeys();
        if (!keys.length) return card('<span class="muted">У розкладі немає викладачів. Спочатку завантажте розклад.</span>');
        return keys.map((k) => card(`<span class="label">У розкладі: ${esc(k)}</span>
          <input class="field" name="name" placeholder="Прізвище Ім’я По батькові" autocapitalize="words" value="${esc(S.teachers[k] || '')}">
          <div class="muted small" data-role="msg"></div>
          <button class="btn deep" data-act="saveTeacher" data-key="${esc(k)}">Зберегти</button>`)).join('');
      },
    });
  }

  const fWhen = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? `${dayMonth(d)}, ${hm(d)}` : ''; };

  /** Учасники: ролі, групи, прив’язка до рейтингу, пристрої (підтвердження, довіра, відв’язування). */
  function openUsers() {
    const s = { auto: false, wide: true, title: 'Учасники та пристрої', users: null, students: [], groups: [], suggestions: [], q: '', err: '' };
    s.render = () => {
      if (s.err) return ui.notice('err', esc(s.err));
      if (!s.users) return ui.loading();
      const q = s.q.trim().toLocaleLowerCase('uk');
      const list = [...s.users].filter((u) => !q || u.fullName.toLocaleLowerCase('uk').includes(q))
        .sort((a, b) => (b.pending.length > 0) - (a.pending.length > 0) || a.fullName.localeCompare(b.fullName, 'uk'));
      let h = ui.notice('info', 'Прив’язка до рейтингу зберігається за людиною: усі її пристрої показують той самий рейтинг. Підвищувати власні бали можна лише з <b>довіреного</b> пристрою — першого, доданого паролем або підтвердженого тут. Перед прив’язкою переконайтеся, що обліковий запис належить цьому студентові.');
      if (s.suggestions.length) {
        h += `<div class="card"><div class="spread wrap"><div><div class="card-title">Збіги ПІБ</div><div class="card-sub">Облікових записів без прив’язки, ПІБ яких збігається зі студентом рейтингу: ${s.suggestions.length}</div></div>
          <button class="btn small" data-act="linkSuggested">${ic('link', 16)} Прив’язати всі</button></div>
          <div class="muted small">${s.suggestions.slice(0, 8).map((x) => esc(x.userName) + ' → ' + esc(x.group)).join(' · ')}${s.suggestions.length > 8 ? ' …' : ''}</div></div>`;
      }
      h += `<input class="field" name="usersQ" id="usersQ" type="search" placeholder="Пошук за ПІБ" value="${esc(s.q)}" data-inp="usersQ">`;
      h += list.length ? list.map((u) => card(`
          <div class="spread"><div class="hstack"><span class="ava">${esc(initialsOf(u.fullName))}</span><div><b>${esc(u.fullName)}</b>
            <div class="muted xs">${u.lastSeenAt ? 'Активність: ' + esc(fmt.rel(u.lastSeenAt)) : 'Ще не заходив(-ла) після оновлення'}</div></div></div>${roleBadge(u)}</div>
          ${u.isAdmin ? '' : `<div class="grid c3">
            <label><span class="label">Група</span><select class="field" data-chg="userGroup" data-user="${esc(u.id)}"><option value="">Не призначено</option>${(s.groups || []).map((g) => `<option value="${esc(g.name)}" ${u.group === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
            <label><span class="label">Роль</span><select class="field" data-chg="userRole" data-user="${esc(u.id)}"><option value="" ${!u.role ? 'selected' : ''}>Студент</option><option value="starosta" ${u.role === 'starosta' ? 'selected' : ''}>Староста</option><option value="deputy" ${u.role === 'deputy' ? 'selected' : ''}>Заступник старости</option></select></label>
            <label><span class="label">Студент рейтингу</span><select class="field" data-chg="accountStudent" data-user="${esc(u.id)}"><option value="">Не прив’язано</option>${(s.students || []).map((st) => `<option value="${esc(st.id)}" ${u.studentId === st.id ? 'selected' : ''}>${esc(st.fullName)}${st.group ? ' · ' + esc(st.group) : ''}${st.active === false ? ' (архів)' : ''}</option>`).join('')}</select></label></div>`}
          ${u.pending.length ? `<div class="label" style="color:var(--warn)">Запити на новий пристрій</div>` + u.pending.map((p) => `
            <div class="dev"><div class="dn">${esc(p.label)}<div class="muted small">${esc(fWhen(p.requestedAt))}</div></div>
              <div class="btn-row" style="flex-wrap:nowrap"><button class="btn green small" data-act="devApprove" data-user="${esc(u.id)}" data-key="${esc(p.key)}">Підтвердити</button>
              <button class="btn red small" data-act="devReject" data-user="${esc(u.id)}" data-key="${esc(p.key)}">Відхилити</button></div></div>`).join('') : ''}
          <div class="label">Пристрої · ${u.devices}</div>
          ${u.deviceList.length ? u.deviceList.map((d) => `
            <div class="dev"><div class="dn">${ic('device', 15)}<span>${esc(d.label)}</span> ${d.trusted ? badge('Довірений', 'accent') : badge('Не підтверджено', 'warn')}${d.addedAt ? `<div class="muted small">додано ${esc(fWhen(d.addedAt))}</div>` : ''}</div>
              <div class="btn-row" style="flex-wrap:nowrap">${u.isAdmin ? '' : d.trusted
                ? `<button class="btn ghost small" data-act="devTrust" data-user="${esc(u.id)}" data-key="${esc(d.key)}" data-trusted="0">Зняти довіру</button>`
                : `<button class="btn green small" data-act="devTrust" data-user="${esc(u.id)}" data-key="${esc(d.key)}" data-trusted="1">Довіряти</button>`}
              <button class="btn deep small" data-act="devRemove" data-user="${esc(u.id)}" data-key="${esc(d.key)}" data-name="${esc(u.fullName)}">Відв’язати</button></div></div>`).join('')
            : '<div class="muted small">Немає — перший пристрій, з якого людина увійде, стане основним.</div>'}
          <div class="btn-row">${u.devices > 1 ? `<button class="btn ghost small" data-act="resetDevices" data-id="${esc(u.id)}">Відв’язати всі пристрої</button>` : ''}
            ${u.id !== S.user.id ? `<button class="btn red small" data-act="deleteUser" data-id="${esc(u.id)}" data-name="${esc(u.fullName)}">Видалити обліковий запис</button>` : ''}</div>`, u.pending.length ? 'pending-box' : '')).join('')
        : ui.empty('users', 'Нікого не знайдено', 'Змініть пошуковий запит.');
      return h;
    };
    s.reload = async () => {
      try {
        const [users, students, groups, sug] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/rating-students'), api('GET', '/api/admin/groups'), api('GET', '/api/admin/link-suggestions')]);
        Object.assign(s, { users, students, groups, suggestions: sug.items || [], err: '' });
      } catch (e) { s.err = e.message; }
      if (sheets.includes(s)) rerender(s);
    };
    openSheet(s);
    s.reload();
  }


  // ───────────── сповіщення ─────────────

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function getSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  function b64ToU8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  const pushSettings = () => ({
    notificationsEnabled: S.settings.notificationsEnabled, leadMinutes: S.settings.leadMinutes,
    askHomework: S.settings.askHomework, notifyHomework: S.settings.notifyHomework, notifyProgress: S.settings.notifyProgress !== false,
  });

  async function refreshPushState() {
    S.push.supported = pushSupported();
    S.push.permission = 'Notification' in window ? Notification.permission : 'denied';
    try { S.push.subscribed = !!(await getSub()); } catch (e) { S.push.subscribed = false; }
    if (S.user && S.tab === 'settings') render();
  }

  /** Чи підписку створено з поточним ключем сервера. Після зміни ключів стара підписка отримує від Apple 403. */
  function sameKey(sub, publicKey) {
    try {
      const k = sub.options && sub.options.applicationServerKey;
      if (!k) return true; // перевірити неможливо
      const a = new Uint8Array(k);
      const b = b64ToU8(publicKey);
      return a.length === b.length && a.every((v, i) => v === b[i]);
    } catch (e) { return true; }
  }

  async function subscribePush(force) {
    const reg = await navigator.serviceWorker.ready;
    const cfg = await api('GET', '/api/push/config');
    let sub = await reg.pushManager.getSubscription();
    if (sub && (force || !sameKey(sub, cfg.publicKey))) {
      // Стара/зламана підписка — прибираємо й створюємо нову з актуальним ключем.
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.publicKey) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), settings: pushSettings(), key: cfg.publicKey });
    return sub;
  }

  /** Якщо дозвіл уже є — тихо прив’язуємо підписку цього пристрою до поточного користувача. */
  async function ensurePush() {
    if (S.pushEnsured || !S.token || !pushSupported() || Notification.permission !== 'granted') { refreshPushState(); return; }
    S.pushEnsured = true;
    try { await subscribePush(); } catch (e) { /* не критично */ }
    refreshPushState();
  }

  async function enablePush() {
    if (!pushSupported()) {
      toast(isIOS && !isStandalone()
        ? 'На iPhone спершу додайте щоденник на екран «Додому» і відкрийте його з іконки.'
        : 'Цей браузер не підтримує сповіщення.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Дозвіл не надано. Його можна змінити в налаштуваннях пристрою.'); refreshPushState(); return; }
    try {
      await subscribePush();
      S.settings.notificationsEnabled = true;
      saveSettings();
      toast('Сповіщення увімкнено');
    } catch (e) {
      toast('Не вдалося увімкнути: ' + e.message);
    }
    refreshPushState();
  }

  async function disablePush() {
    try {
      const sub = await getSub();
      if (sub) {
        await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
    } catch (e) { /* ignore */ }
    refreshPushState();
  }

  // ───────────── запит дозволу на сповіщення при першому заході ─────────────
  // Системний запит браузер дозволяє показати лише після натискання користувача,
  // тому спершу показуємо власне вікно з кнопкою «Дозволити».

  // Питаємо при кожному заході (завантаженні сторінки або поверненні в застосунок після 30+ хв),
  // доки сповіщення не ввімкнені. «Не зараз» ховає вікно лише до наступного заходу.
  let askDismissed = false;
  let hiddenAt = 0;

  function removePushAsk() { const el = document.getElementById('pushAsk'); if (el) el.remove(); }

  async function maybeAskPush() {
    if (!S.user || !S.token) { removePushAsk(); return; }
    if (askDismissed || document.getElementById('pushAsk') || !pushSupported()) return;
    const perm = Notification.permission;
    let subscribed = false;
    try { subscribed = !!(await getSub()); } catch (e) { /* ignore */ }
    if (perm === 'granted' && subscribed) return; // усе ввімкнено
    if (!S.user || document.getElementById('pushAsk')) return;
    const denied = perm === 'denied';
    const howTo = isIOS
      ? 'Відкрийте «Налаштування» iPhone → «Сповіщення» → «Щоденник» і ввімкніть «Дозволити сповіщення». Потім поверніться сюди.'
      : 'Натисніть значок замка (або налаштувань) ліворуч від адреси сайту → «Сповіщення» → «Дозволити», а потім оновіть сторінку.';
    const box = document.createElement('div');
    box.id = 'pushAsk';
    box.className = 'push-ask';
    box.innerHTML = `
      <div class="push-ask-card" role="dialog" aria-modal="true" aria-labelledby="pushAskTitle">
        <div class="push-ask-ico">${denied ? '🔕' : '🔔'}</div>
        <h2 id="pushAskTitle">${denied ? 'Сповіщення вимкнені' : 'Увімкнути сповіщення?'}</h2>
        <p class="muted">${denied
          ? 'Без них ви не отримаєте нагадування про пари й нове домашнє. ' + howTo
          : 'Нагадаємо про пару за кілька хвилин до початку, а після неї — спитаємо, що задали. Працює й коли щоденник закрито.'}</p>
        ${denied ? '' : '<button class="btn" data-act="pushAllow">Дозволити</button>'}
        <button class="link" data-act="pushLater">${denied ? 'Зрозуміло' : 'Не зараз'}</button>
      </div>`;
    document.body.appendChild(box);
  }

  let settingsTimer = null;
  function pushSettingsChanged() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      try {
        const sub = await getSub();
        if (sub) await api('PUT', '/api/push/settings', { endpoint: sub.endpoint, settings: pushSettings() });
      } catch (e) { /* підтягнеться під час наступного входу */ }
    }, 500);
  }

  // ───────────── імпорт розкладу ─────────────

  let xlsxPromise = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxPromise) {
      xlsxPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve;
        s.onerror = () => { xlsxPromise = null; reject(new Error('Не вдалося завантажити бібліотеку для .xls. Перевірте інтернет або використайте .csv.')); };
        document.head.appendChild(s);
      });
    }
    return xlsxPromise;
  }

  function cellText(cell) {
    if (!cell) return '';
    if (cell.t === 'd' && cell.v instanceof Date) {
      const d = cell.v;
      return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    }
    if (cell.t === 'n') {
      if (window.XLSX && cell.z && XLSX.SSF.is_date(cell.z)) {
        const p = XLSX.SSF.parse_date_code(cell.v);
        if (p) return `${pad(p.d)}.${pad(p.m)}.${p.y}`;
      }
      return String(cell.v);
    }
    return String(cell.v == null ? '' : cell.v);
  }

  async function readGrid(file) {
    const buf = await file.arrayBuffer();
    const b = new Uint8Array(buf);
    const ole = b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
    const zip = b[0] === 0x50 && b[1] === 0x4B;
    if (!ole && !zip) return ScheduleParser.readCSV(buf);
    await loadXLSX();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) throw new Error('Не вдалося прочитати файл. Схоже, він пошкоджений.');
    const range = XLSX.utils.decode_range(ws['!ref']);
    const grid = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]));
      grid.push(row);
    }
    return grid;
  }

  async function importSchedule(file) {
    const say = (text, cls) => {
      S.schedMsg = { text, cls: cls || 'muted' };
      const m = $('#schedMsg');
      if (m) { m.hidden = !text; m.className = S.schedMsg.cls + ' small'; m.textContent = text; }
    };
    try {
      say('Читаю файл…');
      const parsed = ScheduleParser.parse(await readGrid(file));
      say(`Відправляю пар: ${parsed.lessons.length}…`);
      await api('PUT', '/api/schedule', { title: parsed.title, lessons: parsed.lessons });
      await sync();
      say(`Готово. Додано пар: ${parsed.lessons.length}`, 'ok');
    } catch (e) {
      say(e.message || 'Не вдалося завантажити розклад.', 'err');
    }
  }

  async function importRating(file) {
    const R = S.rating;
    const say = (text, cls) => {
      R.msg = { text, cls: cls || 'muted' };
      document.querySelectorAll('.ratingMsg').forEach((m) => { m.hidden = !text; m.className = 'ratingMsg ' + R.msg.cls + ' small'; m.textContent = text; });
    };
    try {
      say('Читаю файл…');
      const parsed = RatingParser.parse(await readGrid(file));
      say(`Відправляю студентів: ${parsed.entries.length}…`);
      const r = await api('PUT', '/api/admin/rating/import', { subjects: parsed.subjects, entries: parsed.entries });
      R.group = r.group;
      R.subject = '';
      await loadRating(r.group, true);
      say(`Готово. Студентів: ${r.students}, предметів: ${r.subjects}`, 'ok');
    } catch (e) {
      say(e.message || 'Не вдалося завантажити таблицю.', 'err');
    }
  }

  // ───────────── дії ─────────────

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function setMsg(root, text, cls) {
    const m = root.querySelector('[data-role="msg"]') || root;
    m.textContent = text;
    m.className = (cls || 'muted') + ' small';
    if (m.dataset) m.dataset.role = 'msg';
  }

  async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn) btn.disabled = false; }
  }

  const ACT = {
    tab(el) { go(el.dataset.tab, el.dataset.sub); },
    go(el) { go(el.dataset.tab, el.dataset.sub); },
    back() { go('admin', 'manage'); },
    ratingReload() { loadRating(); },
    async ratingSyncNow() { try { toast('Оновлюю рейтинг…'); await api('POST', '/api/admin/rating/sync', {}); await loadRating(undefined, true); toast('Рейтинг оновлено з Google Sheets'); } catch (e) { toast(e.message || 'Помилка синхронізації'); } },
    ratingManage() { openRatingAdmin(); },
    ratingJump() { const r = $('#rk-me'); if (r) r.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
    theme(el) { LS.set('theme', el.dataset.mode); if (window.__applyTheme) window.__applyTheme(); render(); },
    ratingAdd(el) { const s = sheetOf(el); const d = S.rating.data; s.form = { fullName: '', group: d.group, points: null, note: '', subjects: {} }; rerender(s); },
    ratingEdit(el) {
      const s = sheetOf(el); const d = S.rating.data;
      const e = d.entries.find((x) => x.id === el.dataset.id); if (!e) return;
      s.form = { id: e.id, fullName: e.fullName, group: d.group, points: e.points, note: e.note || '', subjects: Object.assign({}, e.subjects) };
      rerender(s);
    },
    ratingCancel(el) { const s = sheetOf(el); s.form = null; rerender(s); },
    async ratingSave(el) {
      const s = sheetOf(el); const body = ratingFormBody(el);
      await withBusy(el, async () => {
        try {
          if (s.form.id) await api('PATCH', `/api/admin/rating/${encodeURIComponent(s.form.id)}`, body);
          else await api('POST', '/api/admin/rating', body);
          if (body.group !== S.rating.group) S.rating.group = body.group;
          s.form = null;
          toast('Збережено');
          await loadRating();
        } catch (e) { setMsg(s.el, e.message, 'err'); }
      });
    },
    async ratingDel(el) {
      if (!confirm(`Видалити «${el.dataset.name}» з рейтингу?\n\nЯкщо студент є в Google-таблиці, під час наступної синхронізації його буде додано знову. Щоб прибрати студента з рейтингу без втрати даних, архівуйте його в картці студента (Адміністрування → Студенти).`)) return;
      await withBusy(el, async () => {
        try { await api('DELETE', `/api/admin/rating/${encodeURIComponent(el.dataset.id)}`); toast('Видалено'); await loadRating(); } catch (e) { toast(e.message); }
      });
    },
    groupsManage() { closeSheet(); go('admin', 'groups'); },
    gradesReload() { loadGrades(); },
    async gradesCheck() {
      const g = S.grades;
      g.checking = true; g.msg = ''; render();
      try {
        const r = await api('POST', '/api/admin/grades/check');
        g.msg = r.fresh ? `Нових оцінок: ${r.fresh}. Сповіщень доставлено: ${r.notified}.` : 'Нових оцінок немає.'; g.cls = 'ok';
        await loadGrades();
      } catch (e) { g.msg = e.message; g.cls = 'err'; }
      g.checking = false;
      render();
    },
    sync() {
      sync();
      const cur = currentPage();
      if (cur.page.enter) cur.page.enter({ refresh: true });
    },
    async devTrust(el) {
      const s = sheetOf(el);
      const trusted = el.dataset.trusted === '1';
      await withBusy(el, async () => {
        try {
          await api('POST', `/api/admin/users/${encodeURIComponent(el.dataset.user)}/devices/${encodeURIComponent(el.dataset.key)}/trust`, { trusted });
          toast(trusted ? 'Пристрій позначено довіреним' : 'Довіру до пристрою знято');
        } catch (e) { toast(e.message); }
      });
      if (s && s.reload) await s.reload();
    },
    async linkSuggested(el) {
      const s = sheetOf(el);
      if (!s || !s.suggestions.length) return;
      if (!confirm(`Прив’язати ${s.suggestions.length} облікових записів до студентів рейтингу за збігом ПІБ?`)) return;
      await withBusy(el, async () => {
        try {
          const r = await api('POST', '/api/admin/link-suggestions/apply', { userIds: s.suggestions.map((x) => x.userId) });
          toast(`Прив’язано: ${r.linked}`);
        } catch (e) { toast(e.message); }
      });
      await s.reload();
    },
    lesson(el) { openLesson(el.dataset.id); },
    day(el) { S.day = sod(new Date(+el.dataset.ts)); render(); },
    shift(el) { S.day = addDays(S.day, +el.dataset.d); render(); },
    goToday() { S.day = sod(new Date()); render(); },
    done(el) { toggleDone(el.dataset.id); render(); },
    answered(el) { answerNone(el.dataset.lesson); },
    hintOff() { LS.set('hintOff', true); render(); },
    moderation() { openModeration(); },
    subjects() { openSubjects(); },
    teachers() { openTeachers(); },
    users() { openUsers(); },
    closeSheet() { closeSheet(); },

    hwNew(el) {
      const l = el.dataset.lesson ? lessonById(el.dataset.lesson) : null;
      openHomeworkForm(l ? newHomework(l) : blankHomework());
    },
    hwEdit(el) {
      const h = S.homework.find((x) => x.id === el.dataset.id);
      if (!h) return;
      if (canEdit(h)) openHomeworkForm(Object.assign({}, h)); else openHomeworkView(h);
    },
    hwOpen(el) {
      const h = S.homework.find((x) => x.id === el.dataset.id);
      if (h) openHomeworkView(h);
    },
    hwEditFromView(el) {
      const s = sheetOf(el); if (!s) return;
      const id = s.viewId;
      const h = S.homework.find((x) => x.id === id);
      if (!h || !canEdit(h)) return;
      // closeSheet() працює через history.back() (асинхронно) — форму відкриваємо вже після закриття перегляду.
      const reopen = () => { window.removeEventListener('popstate', reopen); setTimeout(() => openHomeworkForm(Object.assign({}, h)), 0); };
      window.addEventListener('popstate', reopen);
      closeSheet();
    },
    linkAdd(el) {
      const s = sheetOf(el); if (!s) return;
      const inp = $('[name=linkInput]', s.el);
      const err = $('[data-role="err"]', s.el);
      const v = normLink(inp.value);
      if (!inp.value.trim()) return;
      if (v === null) { err.textContent = 'Некоректне посилання.'; return; }
      if (!s.item.links.includes(v)) s.item.links.push(v);
      inp.value = '';
      rerender(s);
      $('[data-role="err"]', s.el).textContent = '';
    },
    linkDel(el) { const s = sheetOf(el); if (!s) return; s.item.links.splice(+el.dataset.i, 1); rerender(s); },
    imgDel(el) { const s = sheetOf(el); if (!s) return; s.item.images.splice(+el.dataset.i, 1); rerender(s); },
    imgOpen(el) {
      const id = el.dataset.id;
      openSheet({ auto: false, title: 'Зображення', render: () => `<img class="full" ${IMG[id] ? `src="${IMG[id]}"` : `data-img="${esc(id)}"`} alt="">` });
    },
    hwNone(el) { closeSheet(); answerNone(el.dataset.lesson); },

    async hwSave(el) {
      const s = sheetOf(el);
      if (!s) return;
      const err = $('[data-role="err"]', s.el);
      const subjectKey = $('[name=subject]', s.el).value;
      const text = $('[name=text]', s.el).value.trim();
      const due = fromInput($('[name=due]', s.el).value);
      err.textContent = '';
      if (!subjectKey) { err.textContent = 'Оберіть предмет.'; return; }
      if (!text) { err.textContent = 'Опишіть, що задали.'; return; }
      if (!due) { err.textContent = 'Вкажіть дату.'; return; }
      const pend = $('[name=linkInput]', s.el);
      if (pend && pend.value.trim()) {
        const u = normLink(pend.value);
        if (u === null) { err.textContent = 'Некоректне посилання (або очистіть поле).'; return; }
        if (!s.item.links.includes(u)) s.item.links.push(u);
      }
      if (s.item.links.length > MAX_LINKS) { err.textContent = `Не більше ${MAX_LINKS} посилань.`; return; }
      if (s.uploading > 0) { err.textContent = 'Зачекайте — зображення ще завантажується.'; return; }
      await withBusy(el, async () => {
        try {
          const body = { subjectKey, lessonID: s.item.lessonID || null, text, due: due.toISOString(), links: s.item.links, images: s.item.images };
          if (s.editing) await api('PATCH', '/api/homework/' + encodeURIComponent(s.item.id), body);
          else await api('POST', '/api/homework', body);
          if (s.item.lessonID) markAnswered(s.item.lessonID);
          closeSheet();
          toast(!s.editing && !isMod() ? 'Надіслано на підтвердження' : 'Збережено');
          await sync();
        } catch (e) { err.textContent = e.message; }
      });
    },
    async hwDelete(el) {
      const s = sheetOf(el);
      if (!s || !confirm('Видалити це завдання?')) return;
      await withBusy(el, async () => {
        try {
          await api('DELETE', '/api/homework/' + encodeURIComponent(s.item.id));
          closeSheet();
          await sync();
        } catch (e) { $('[data-role="err"]', s.el).textContent = e.message; }
      });
    },
    async approve(el) { await moderate(el, 'approve'); },
    async reject(el) { await moderate(el, 'reject'); },

    async saveLink(el) {
      const s = sheetOf(el);
      const key = el.dataset.key;
      const box = el.closest('.card');
      await withBusy(el, async () => {
        try {
          await api('PUT', '/api/subjects', { key, fullName: (S.subjects[key] && S.subjects[key].fullName) || '', link: $('[name=link]', box).value.trim() });
          await sync();
          if (s) { const m = $('[data-role="msg"]', s.el); if (m) { m.textContent = 'Збережено'; m.className = 'ok small'; } }
        } catch (e) { setMsg(box, e.message, 'err'); }
      });
    },
    async saveSubject(el) {
      const box = el.closest('.card');
      await withBusy(el, async () => {
        try {
          setMsg(box, '');
          await api('PUT', '/api/subjects', { key: el.dataset.key, fullName: $('[name=name]', box).value.trim(), link: $('[name=link]', box).value.trim() });
          await sync();
          setMsg(box, 'Збережено', 'ok');
        } catch (e) { setMsg(box, e.message, 'err'); }
      });
    },
    async saveTeacher(el) {
      const box = el.closest('.card');
      await withBusy(el, async () => {
        try {
          setMsg(box, '');
          await api('PUT', '/api/teachers', { key: el.dataset.key, fullName: $('[name=name]', box).value.trim() });
          await sync();
          setMsg(box, 'Збережено', 'ok');
        } catch (e) { setMsg(box, e.message, 'err'); }
      });
    },

    async devApprove(el) { await deviceAction(el, 'POST', 'approve', 'Пристрій підтверджено — вхід відбудеться автоматично'); },
    async devReject(el) { await deviceAction(el, 'POST', 'reject', 'Запит відхилено'); },
    async devRemove(el) {
      if (!confirm(`Видалити цей пристрій у «${el.dataset.name}»? З нього треба буде входити знову.`)) return;
      await deviceAction(el, 'DELETE', '', 'Пристрій видалено');
    },
    async resetDevices(el) {
      const s = sheetOf(el);
      if (!confirm('Відв’язати ВСІ пристрої цього користувача? Перший, хто увійде під його ПІБ, стане новим основним.')) return;
      try { await api('POST', `/api/admin/users/${encodeURIComponent(el.dataset.id)}/reset-devices`); toast('Усі пристрої відв’язано'); } catch (e) { toast(e.message); }
      if (s && s.reload) s.reload();
    },
    async deleteUser(el) {
      const s = sheetOf(el);
      if (!confirm(`Видалити користувача «${el.dataset.name}»? Його внесене домашнє збережеться.`)) return;
      try { await api('DELETE', '/api/admin/users/' + encodeURIComponent(el.dataset.id)); } catch (e) { toast(e.message); }
      if (s && s.reload) s.reload();
    },

    async notifySend(el) {
      const n = S.notify;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (!n.body.trim()) { n.msg = 'Введіть текст сповіщення.'; n.cls = 'err'; render(); return; }
      const target = n.userId === 'all' ? 'усім' : (n.users.find((u) => u.id === n.userId) || {}).fullName;
      if (!confirm(`Надіслати сповіщення: ${target}?`)) return;
      n.sending = true; n.msg = ''; render();
      try {
        const r = await api('POST', '/api/admin/notify', { userId: n.userId, title: n.title.trim(), body: n.body.trim() });
        n.msg = `Надіслано на пристроїв: ${r.sent}`; n.cls = 'ok'; n.body = '';
      } catch (e) { n.msg = e.message; n.cls = 'err'; }
      n.sending = false;
      render();
    },
    lead(el) {
      S.settings.leadMinutes = Math.min(15, Math.max(1, S.settings.leadMinutes + +el.dataset.d));
      saveSettings(); pushSettingsChanged(); render();
    },
    pushOn() { enablePush(); },
    async pushAllow() { removePushAsk(); askDismissed = true; await enablePush(); },
    pushLater() { askDismissed = true; removePushAsk(); },
    pushOff() { disablePush(); },
    async pushTest(el) {
      await withBusy(el, async () => {
        const run = async () => {
          const sub = await getSub();
          if (!sub) throw new Error('Спершу увімкніть сповіщення.');
          await api('PUT', '/api/push/settings', { endpoint: sub.endpoint, settings: pushSettings() });
          await api('POST', '/api/push/test', { endpoint: sub.endpoint });
        };
        try {
          try {
            await run();
          } catch (e) {
            // Підписки немає на сервері або її відхилив push-сервіс (403) — створюємо заново й пробуємо ще раз.
            if (e.status === 404 || e.code === 'push_rejected') { await subscribePush(true); await run(); } else throw e;
          }
          toast('Тест надіслано — сповіщення має прийти за кілька секунд.');
        } catch (e) {
          toast(e.code === 'push_rejected' ? e.message + ' Перевірте VAPID_SUBJECT на сервері (має бути реальна пошта).' : e.message);
        }
        refreshPushState();
      });
    },
    async share() {
      const url = location.origin;
      if (navigator.share) { try { await navigator.share({ title: 'Щоденник студента', text: 'Розклад, домашнє й нагадування про пари', url }); } catch (e) { /* скасовано */ } return; }
      try { await navigator.clipboard.writeText(url); toast('Посилання скопійовано'); } catch (e) { toast(url); }
    },
    async install() {
      const ev = S.installEvent;
      if (!ev) return;
      ev.prompt();
      await ev.userChoice.catch(() => {});
      S.installEvent = null;
      render();
    },
    logout() { if (confirm('Вийти з акаунта? Дані на цьому пристрої буде видалено, на сервері вони лишаться.')) signOut(); },
  };

  async function deviceAction(el, method, action, okText) {
    const s = sheetOf(el);
    await withBusy(el, async () => {
      try {
        const path = `/api/admin/users/${encodeURIComponent(el.dataset.user)}/devices/${encodeURIComponent(el.dataset.key)}${action ? '/' + action : ''}`;
        await api(method, path);
        toast(okText);
      } catch (e) { toast(e.message); }
    });
    if (s && s.reload) await s.reload();
    sync();
  }

  async function moderate(el, what) {
    await withBusy(el, async () => {
      try {
        await api('POST', `/api/homework/${encodeURIComponent(el.dataset.id)}/${what}`);
        await sync();
      } catch (e) { toast(e.message); }
    });
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-chg]');
    if (!el) return;
    if (el.dataset.chg === 'setting') {
      S.settings[el.dataset.key] = el.checked;
      saveSettings();
      pushSettingsChanged();
      if (el.dataset.key === 'notificationsEnabled' && el.checked && S.push.supported && !S.push.subscribed) enablePush();
    } else if (el.dataset.chg === 'hwDue') {
      const s = sheetOf(el);
      if (s && s.item) hwRefreshDue(s);
    } else if (el.dataset.chg === 'userGroup') {
      const s = sheetOf(el);
      api('POST', `/api/admin/users/${encodeURIComponent(el.dataset.user)}/group`, { group: el.value })
        .then(() => { toast('Групу змінено'); if (s && s.reload) s.reload(); })
        .catch((e) => { toast(e.message); if (s && s.reload) s.reload(); });
    } else if (el.dataset.chg === 'userRole') {
      const s = sheetOf(el);
      api('POST', `/api/admin/users/${encodeURIComponent(el.dataset.user)}/role`, { role: el.value })
        .then(() => { toast('Роль змінено'); if (s && s.reload) s.reload(); })
        .catch((e) => { toast(e.message); if (s && s.reload) s.reload(); });
    } else if (el.dataset.chg === 'accountStudent') {
      const s = sheetOf(el);
      api('POST', `/api/admin/users/${encodeURIComponent(el.dataset.user)}/student`, { studentId: el.value })
        .then((r) => {
          const also = r && r.alsoLinked && r.alsoLinked.length ? ` Увага: цей студент також прив’язаний до: ${r.alsoLinked.join(', ')}.` : '';
          toast((el.value ? 'Обліковий запис прив’язано до рейтингу.' : 'Прив’язку до рейтингу знято.') + also);
          if (s && s.reload) s.reload();
        })
        .catch((e) => { toast(e.message); if (s && s.reload) s.reload(); });
    } else if (el.dataset.chg === 'ratingGroup') {
      loadRating(el.value);
    } else if (el.dataset.chg === 'ratingSubject') {
      S.rating.subject = el.value;
      loadRating();
    } else if (el.dataset.chg === 'ratingFile' && el.files && el.files[0]) {
      const f = el.files[0];
      el.value = '';
      importRating(f);
    } else if (el.dataset.chg === 'ratingPts') {
      ratingSavePts(el);
    } else if (el.dataset.chg === 'notifyField') {
      S.notify[el.dataset.key] = el.value;
    } else if (el.dataset.chg === 'hwImages' && el.files && el.files.length) {
      const s = sheetOf(el);
      const files = [...el.files];
      el.value = '';
      if (s) addImages(s, files);
    } else if (el.dataset.chg === 'schedFile' && el.files && el.files[0]) {
      const f = el.files[0];
      el.value = '';
      importSchedule(f);
    } else if (CHG[el.dataset.chg]) {
      CHG[el.dataset.chg](el, e);
    }
  });

  let usersQTimer = null;
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-inp]');
    if (el && INP[el.dataset.inp]) INP[el.dataset.inp](el, e);
    if (el && el.dataset.inp === 'usersQ') {
      const s = sheetOf(el);
      clearTimeout(usersQTimer);
      usersQTimer = setTimeout(() => {
        if (!s) return;
        s.q = el.value;
        rerender(s);
        const inp = $('#usersQ', s.el);
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      }, 200);
    }
    if (el && el.dataset.inp === 'notifyField') S.notify[el.dataset.key] = el.value;
    if (el && el.dataset.inp === 'ratingSubj') {
      const root = el.closest('.sh-body');
      let sum = 0; let any = false;
      root.querySelectorAll('[data-inp="ratingSubj"]').forEach((i) => { if (i.value.trim() !== '' && Number.isFinite(+i.value)) { sum += +i.value; any = true; } });
      const t = root.querySelector('[name="points"]');
      if (any && t) t.value = String(Math.round(sum * 100) / 100);
    }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'loginForm') return;
    e.preventDefault();
    const err = $('#loginErr');
    const btn = $('#loginBtn');
    const name = $('#fullName').value.replace(/\s+/g, ' ').trim();
    err.textContent = '';
    if (name.split(' ').length < 2) { err.textContent = 'Введіть прізвище, ім’я та по батькові.'; return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      loginNotice = '';
      stopPending();
      await login(name, $('#adminPass') ? $('#adminPass').value : '');
    } catch (ex) {
      if (!S.user) {
        if (ex.code === 'password_required') {
          S.needPassword = true;
          const w = $('#passWrap');
          if (w) { w.hidden = false; w.style.display = 'flex'; }
        }
        if (ex.code === 'device_pending') {
          setLoginMsg(ex.message, 'wait');
          startPending(name);
        } else {
          setLoginMsg(ex.message, 'err');
        }
        btn.disabled = false;
        btn.textContent = 'Увійти';
      }
    }
  });

  // ───────────── навігація зі сповіщень ─────────────

  function routeFromUrl(urlStr) {
    try { S.pendingRoute = new URL(urlStr, location.origin).search; } catch (e) { return; }
    processRoute();
  }

  function processRoute() {
    if (!S.pendingRoute || !S.user) return;
    const p = new URLSearchParams(S.pendingRoute);
    if (p.has('lesson') && !S.lessons.length) return; // дочекаємося синхронізації
    S.pendingRoute = null;
    if (history.replaceState) history.replaceState(history.state, '', location.pathname);

    if (p.has('lesson')) openLesson(p.get('lesson'), { join: p.get('join') === '1' });
    else if (p.has('homework')) { const l = lessonById(p.get('homework')); openHomeworkForm(l ? newHomework(l) : blankHomework()); }
    else if (p.has('answered')) { answerNone(p.get('answered')); toast('Добре, відмітили'); }
    else if (p.get('tab') === 'users') { if (isAdmin()) { go('admin', 'manage'); openUsers(); } }
    else if (p.get('tab') === 'moderation') { if (isMod()) { go('homework'); openModeration(); } }
    else if (p.get('tab')) {
      // Старі посилання зі сповіщень (rating, grades, notify) ведуть на нові сторінки.
      const legacy = { rating: ['progress', 'rating'], grades: ['admin', 'grades'], notify: ['admin', 'notify'] };
      let [tab, sub] = legacy[p.get('tab')] || [p.get('tab'), p.get('sub')];
      if (!navTab(tab)) { tab = 'today'; sub = null; }
      go(tab, sub || undefined);
    }
  }

  // ───────────── модулі ─────────────
  // progress.js (успішність студента) і admin.js (адміністрування) підключаються після app.js
  // і реєструють свої сторінки, дії та обробники через Diary.register().

  window.Diary = {
    S, api, render, go, toast, esc, ic, card, badge, LS, ui, fmt, SOURCE_TITLES,
    openSheet, rerender, closeSheet, sheetOf, withBusy, setMsg, currentPage,
    isAdmin, isMod, roleBadge, initialsOf, shortName, studentsWord, ptsText, subjColor,
    loadRating, openUsers, openRatingAdmin, ratingUploadBlock, modBlocks,
    register(mod) {
      Object.assign(PAGES, mod.pages || {});
      Object.assign(ACT, mod.actions || {});
      Object.assign(CHG, mod.changes || {});
      Object.assign(INP, mod.inputs || {});
      for (const [k, fn] of Object.entries(mod.hooks || {})) (HOOKS[k] = HOOKS[k] || []).push(fn);
    },
  };

  // ───────────── запуск ─────────────

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvent = e; if (S.user && S.tab === 'settings') render(); });

  function boot() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (!e.data) return;
        if (e.data.type === 'route') routeFromUrl(e.data.url);
        else if (e.data.type === 'sync' && S.user) sync();
      });
    }
    if (location.search) S.pendingRoute = location.search;

    if (S.token) {
      const cached = LS.get('cache', null);
      if (cached) { try { applySync(cached, true); } catch (e) { /* зіпсований кеш */ } }
    }
    render();
    refreshPushState();
    if (S.token) {
      sync();
      if (S.user) { const cur = currentPage(); if (cur.page.enter) cur.page.enter({}); }
    }

    setInterval(() => {
      if (!S.user || sheets.length || document.hidden) return;
      if (S.tab === 'today' || S.tab === 'schedule') render({ soft: true });
    }, 30000);
    setInterval(() => { if (S.user && !document.hidden) sync(); }, 120000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000) askDismissed = false; // новий «захід»
      if (S.user) { sync(); refreshPushState(); }
    });
  }

  // Модулі (progress.js, admin.js) завантажуються після app.js і реєструються до DOMContentLoaded.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();