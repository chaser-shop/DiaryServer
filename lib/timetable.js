'use strict';
/*
 * Портал розкладу академії (asu.navs.edu.ua, система МКР, Yii2).
 *
 * Публічного API немає: усе робить одна сторінка /time-table/group?type=0 з формою:
 *   1. GET сторінки         → cookie сесії + CSRF-токен + список факультетів;
 *   2. POST (факультет)     → та сама сторінка зі списком курсів;
 *   3. POST (факультет+курс)→ сторінка зі списком груп;
 *   4. POST (усі три + дати)→ сторінка з таблицею розкладу (`#timeTable`).
 * Саме так працює JavaScript самого порталу, тому сервер повторює ті самі кроки й розбирає HTML.
 *
 * Принципи:
 *  - запити до порталу лише з сервера (CORS у браузері не дозволить), по одному за раз, з паузою й кешем;
 *  - захист Cloudflare не обходимо: якщо портал відхиляє запит, повертаємо зрозумілу помилку;
 *  - інтерфейс і база отримують лише розібрані дані, ніколи сирий HTML.
 */

const { zonedToUtc, parseCell } = require('../public/schedule');
const { HttpError } = require('./util');

const BASE = (process.env.TIMETABLE_BASE || 'https://asu.navs.edu.ua').replace(/\/+$/, '');
const PAGE = '/time-table/group?type=0';
const UA = process.env.TIMETABLE_UA || 'Mozilla/5.0 (compatible; StudentDiary/2.0; +reads the public group timetable)';
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.TIMETABLE_TIMEOUT_MS, 10) || 20000);
const GAP_MS = process.env.TIMETABLE_GAP_MS != null ? Math.max(0, parseInt(process.env.TIMETABLE_GAP_MS, 10) || 0) : 400;
const SESSION_TTL = 20 * 60 * 1000;
const TTL = { faculties: 6 * 3600e3, courses: 3600e3, groups: 3600e3, schedule: 3 * 60e3 };
const MAX_RANGE_DAYS = 150;

// ───────────────────────── HTML → дані (чисті функції) ─────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
  }
  const v = NAMED[e.toLowerCase()];
  return v === undefined ? m : v;
});
const squash = (s) => decode(s).replace(/[\s\u00A0]+/g, ' ').trim();
const text = (html) => squash(String(html).replace(/<[^>]*>/g, ''));
const BR = /<br\s*\/?>/i;

function csrfOf(html) {
  const m = /<meta\s+name="csrf-token"\s+content="([^"]*)"/i.exec(html);
  return m ? decode(m[1]) : '';
}

/** Варіанти <option> одного <select>: { items: [{id, name}], selected } або null, якщо списку немає. */
function parseOptions(html, selectId) {
  const m = new RegExp(`<select\\b[^>]*\\bid="${selectId}"[^>]*>([\\s\\S]*?)</select>`, 'i').exec(html);
  if (!m) return null;
  const items = [];
  let selected = '';
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let o;
  while ((o = re.exec(m[1]))) {
    const v = /\bvalue="([^"]*)"/i.exec(o[1]);
    const id = v ? decode(v[1]).trim() : '';
    if (!id) continue; // «--Факультет--»
    items.push({ id, name: text(o[2]) });
    if (/\bselected\b/i.test(o[1])) selected = id;
  }
  return { items, selected };
}

function parseForm(html) {
  const fac = parseOptions(html, 'timetableform-facultyid');
  const crs = parseOptions(html, 'timetableform-course');
  const grp = parseOptions(html, 'timetableform-groupid');
  return {
    csrf: csrfOf(html),
    hasForm: !!fac,
    faculties: fac ? fac.items : [],
    courses: crs ? crs.items : [],
    groups: grp ? grp.items : [],
    selected: { faculty: fac ? fac.selected : '', course: crs ? crs.selected : '', group: grp ? grp.selected : '' },
  };
}

const pad = (n) => String(n).padStart(2, '0');
const dmyToKey = (d, m, y) => `${y}-${pad(m)}-${pad(d)}`;

/** Тег з атрибутами, де значення в лапках можуть містити «>» (у data-content є сирі <br>). */
const TAG = /<div\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const attrsOf = (s) => {
  const o = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
};

/** «Назва: тема Х» → { name, theme } */
function splitTitle(title) {
  const m = /^(.*?)\s*:\s*тема\s+(.*)$/is.exec(title);
  return m ? { name: m[1].trim(), theme: m[2].trim() } : { name: title.trim(), theme: '' };
}

function parseLessonChunk(chunk, ctx) {
  const cls = /^([^"]*)"/.exec(chunk);
  const classes = cls ? cls[1].split(/\s+/) : [];
  let pop = null;
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(chunk))) {
    const a = attrsOf(m[1]);
    if (a['data-toggle'] === 'popover') { pop = { a, end: TAG.lastIndex }; break; }
  }
  if (!pop) return null;

  // Видимий текст клітинки: «КПУ[КонсЕкз]» / «ауд. …» / «Прізвище І.П.»
  const close = chunk.indexOf('</div>', pop.end);
  const inner = chunk.slice(pop.end, close < 0 ? undefined : close);
  const visible = inner.split(BR).map(text).filter(Boolean).join('\n');
  const info = parseCell(visible);
  if (!info.name) return null;

  // Повний опис зі спливаючої підказки.
  const parts = String(pop.a['data-content'] || '').split(BR).map(text).filter(Boolean);
  const head = parts[0] || '';
  const br = head.lastIndexOf('[');
  const { name: fullName, theme } = splitTitle(br >= 0 ? head.slice(0, br) : head);
  const rest = parts.slice(1);
  const added = rest.map((p) => /Додано:\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(p)).find(Boolean);
  const others = rest.filter((p) => !/^ауд/i.test(p) && !/^Додано/i.test(p));
  const when = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d+)\s*пара/.exec(squash(pop.a.title || ''));

  const date = when ? dmyToKey(+when[1], +when[2], +when[3]) : ctx.date;
  const pair = when ? +when[4] : ctx.pair;
  return {
    date, pair,
    subjectKey: info.name, subjectFull: fullName && fullName !== info.name ? fullName : '',
    kind: info.kind, topic: info.topic, theme,
    room: info.room, isRemote: !!info.remote,
    teacher: info.teacher, teacherFull: others.slice(1).join(', '),
    group: others[0] || '',
    added: added ? dmyToKey(+added[1], +added[2], +added[3]) : '',
    updated: classes.includes('lesson-updated'),
    typeClass: (classes.find((c) => /^lesson-\d+$/.test(c)) || '').replace('lesson-', ''),
  };
}

/**
 * Таблиця `#timeTable`: блок на кожен день тижня — рядок «Пн | дата | дата …», далі по рядку на пару.
 * Колонка таблиці = тиждень. Клітинки «closed» (до початку періоду) і порожні пропускаємо.
 */
function parseSchedule(html) {
  const t = /<table\b[^>]*\bid="timeTable"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!t) return { found: false, lessons: [], dates: 0 };
  const rows = t[1].split(/<tr\b[^>]*>/i).slice(1);
  const lessons = [];
  const seen = new Set();
  let dates = [];
  let datedCols = 0;
  for (const row of rows) {
    if (/class="headday"/i.test(row)) {
      dates = [];
      const re = /class="headdate"[^>]*>\s*(?:<div>)?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/gi;
      let m;
      while ((m = re.exec(row))) dates.push(dmyToKey(+m[1], +m[2], +m[3]));
      datedCols = Math.max(datedCols, dates.length);
      continue;
    }
    const head = /<th\b[^>]*class="headcol"[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    if (!head || !dates.length) continue;
    const pair = /class="lesson">\s*(\d+)\s*пара/i.exec(head[1]);
    const st = /class="start">\s*(\d{1,2}):(\d{2})/i.exec(head[1]);
    const en = /class="end">\s*(\d{1,2}):(\d{2})/i.exec(head[1]);
    if (!pair || !st || !en) continue;
    const cells = row.slice(row.indexOf('</th>') + 5).split(/<td\b[^>]*>/i).slice(1);
    cells.forEach((cell, col) => {
      const date = dates[col];
      if (!date || !/<div class="lesson-/.test(cell)) return;
      const [y, mo, d] = date.split('-').map(Number);
      const chunks = cell.split(/<div class="(?=lesson-)/).slice(1);
      for (const chunk of chunks) {
        const l = parseLessonChunk(chunk, { date, pair: +pair[1] });
        if (!l) continue;
        let n = 1;
        let id = `${date.replace(/-/g, '')}-${l.pair}`;
        while (seen.has(id)) id = `${date.replace(/-/g, '')}-${l.pair}-${++n}`;
        seen.add(id);
        lessons.push({
          ...l, id,
          start: zonedToUtc(y, mo, d, +st[1], +st[2]).toISOString(),
          end: zonedToUtc(y, mo, d, +en[1], +en[2]).toISOString(),
        });
      }
    });
  }
  lessons.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
  return { found: true, lessons, dates: datedCols };
}

// ───────────────────────── Перевірка вхідних даних ─────────────────────────

const idOf = (v, what) => {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,8}$/.test(s)) throw new HttpError(400, `Некоректне значення: ${what}.`);
  return s;
};

function keyToDmy(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) throw new HttpError(400, 'Дата має бути у форматі РРРР-ММ-ДД.');
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new HttpError(400, 'Такої дати не існує.');
  return { dmy: `${m[3]}.${m[2]}.${m[1]}`, t };
}

function normRange(from, to) {
  const a = keyToDmy(from);
  const b = keyToDmy(to);
  if (b.t < a.t) throw new HttpError(400, 'Кінець періоду має бути не раніше за початок.');
  if ((b.t - a.t) / 86400000 > MAX_RANGE_DAYS) throw new HttpError(400, `Період задовгий: не більше ${MAX_RANGE_DAYS} днів.`);
  return { from: a.dmy, to: b.dmy };
}

function defaultRange(now = new Date()) {
  const f = (d) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return { from: f(now), to: f(new Date(now.getTime() + 28 * 86400000)) };
}

// ───────────────────────── Клієнт порталу ─────────────────────────

const looksBlocked = (status, headers, body) => {
  const viaCloudflare = /cloudflare/i.test(headers.get('server') || '') && [403, 429, 503].includes(status);
  const challenge = /cf-chl|challenge-platform|Just a moment|Attention Required/i.test(String(body).slice(0, 6000)) && !/timetableform-/.test(body);
  return viaCloudflare || challenge;
};

class Portal {
  constructor() {
    this.jar = new Map();
    this.csrf = '';
    this.openedAt = 0;
    this.chain = Promise.resolve();
    this.lastAt = 0;
    this.cache = new Map();
  }

  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }

  store(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  /** Усі запити — по черзі, з паузою між ними. */
  enqueue(fn) {
    const run = async () => {
      const wait = this.lastAt + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { this.lastAt = Date.now(); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async raw(path, { method = 'GET', form = null } = {}) {
    let url = BASE + path;
    for (let hop = 0; hop < 4; hop++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method: hop === 0 ? method : 'GET',
          redirect: 'manual',
          signal: ctl.signal,
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'uk-UA,uk;q=0.9',
            ...(this.jar.size ? { Cookie: this.cookieHeader() } : {}),
            ...(hop === 0 && form ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: BASE + PAGE } : {}),
          },
          body: hop === 0 && form ? form.toString() : undefined,
        });
      } catch (e) {
        throw new HttpError(502, e && e.name === 'AbortError' ? 'Портал розкладу не відповів вчасно. Спробуйте ще раз за хвилину.' : 'Не вдалося з’єднатися з порталом розкладу.', { code: 'portal_unreachable' });
      } finally {
        clearTimeout(timer);
      }
      this.store(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        if (!url.startsWith(BASE)) throw new HttpError(502, 'Портал розкладу перенаправив на сторонню адресу.', { code: 'portal_redirect' });
        continue;
      }
      const body = await res.text();
      if (looksBlocked(res.status, res.headers, body)) {
        throw new HttpError(502, 'Портал розкладу відхилив автоматичний запит (захист від ботів). Вибрати групу з порталу з цього сервера зараз не вийде — зверніться до адміністраторів порталу, щоб дозволили читання розкладу сервером.', { code: 'portal_blocked' });
      }
      return { status: res.status, body };
    }
    throw new HttpError(502, 'Портал розкладу зациклив перенаправлення.', { code: 'portal_redirect' });
  }

  async open(force) {
    if (!force && this.csrf && Date.now() - this.openedAt < SESSION_TTL) return null;
    this.jar.clear();
    const { status, body } = await this.raw(PAGE);
    if (status !== 200) throw new HttpError(502, `Портал розкладу відповів помилкою ${status}.`, { code: 'portal_status', status });
    const form = parseForm(body);
    if (!form.hasForm || !form.csrf) throw new HttpError(502, 'Портал розкладу змінив вигляд сторінки: не знайдено форму вибору групи.', { code: 'portal_changed' });
    this.csrf = form.csrf;
    this.openedAt = Date.now();
    return form;
  }

  async post(fields) {
    await this.open(false);
    const send = () => {
      const form = new URLSearchParams();
      form.set('_csrf-frontend', this.csrf);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return this.raw(PAGE, { method: 'POST', form });
    };
    let r = await send();
    if (r.status === 400 || r.status === 403) { // сесія/токен прострочені — одна нова спроба
      await this.open(true);
      r = await send();
    }
    if (r.status !== 200) throw new HttpError(502, `Портал розкладу відповів помилкою ${r.status}.`, { code: 'portal_status', status: r.status });
    return r.body;
  }

  cached(key, ttl, refresh, make) {
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    return this.enqueue(async () => {
      const again = this.cache.get(key);
      if (!refresh && again && Date.now() - again.at < ttl) return again.value;
      const value = await make();
      this.cache.set(key, { at: Date.now(), value });
      if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
      return value;
    });
  }

  fields({ faculty = '', course = '', group = '', from, to } = {}) {
    const r = from && to ? { from, to } : defaultRange();
    return {
      'TimeTableForm[facultyId]': faculty,
      'TimeTableForm[course]': course,
      'TimeTableForm[groupId]': group,
      'date-picker': `${r.from} - ${r.to}`,
      'TimeTableForm[dateStart]': r.from,
      'TimeTableForm[dateEnd]': r.to,
      'TimeTableForm[indicationDays]': '5',
      'time-table-type': '1',
    };
  }

  faculties({ refresh = false } = {}) {
    return this.cached('faculties', TTL.faculties, refresh, async () => {
      const form = await this.open(true);
      return form.faculties;
    });
  }

  async courses(faculty, { refresh = false } = {}) {
    const f = idOf(faculty, 'факультет');
    return this.cached(`courses|${f}`, TTL.courses, refresh, async () => parseForm(await this.post(this.fields({ faculty: f }))).courses);
  }

  async groups(faculty, course, { refresh = false } = {}) {
    const f = idOf(faculty, 'факультет');
    const c = idOf(course, 'курс');
    return this.cached(`groups|${f}|${c}`, TTL.groups, refresh, async () => parseForm(await this.post(this.fields({ faculty: f, course: c }))).groups);
  }

  /** Розклад однієї групи за період (YYYY-MM-DD … YYYY-MM-DD). */
  async schedule({ faculty, course, group, from, to }, { refresh = false } = {}) {
    const f = idOf(faculty, 'факультет');
    const c = idOf(course, 'курс');
    const g = idOf(group, 'група');
    const r = normRange(from, to);
    return this.cached(`schedule|${f}|${c}|${g}|${r.from}|${r.to}`, TTL.schedule, refresh, async () => {
      const html = await this.post(this.fields({ faculty: f, course: c, group: g, from: r.from, to: r.to }));
      const form = parseForm(html);
      const name = (list, id) => (list.find((x) => x.id === id) || {}).name || '';
      if (form.selected.group !== g) {
        throw new HttpError(404, 'Портал не повернув розклад для цієї групи. Перевірте вибір факультету, курсу й групи.', { code: 'portal_no_group' });
      }
      const parsed = parseSchedule(html);
      return {
        faculty: { id: f, name: name(form.faculties, f) },
        course: { id: c, name: c },
        group: { id: g, name: name(form.groups, g) },
        range: { from, to },
        fetchedAt: new Date().toISOString(),
        found: parsed.found,
        weeks: parsed.dates,
        lessons: parsed.lessons,
      };
    });
  }

  reset() { this.jar.clear(); this.csrf = ''; this.openedAt = 0; this.cache.clear(); }
}

const portal = new Portal();

module.exports = { Portal, portal, parseForm, parseOptions, parseSchedule, normRange, defaultRange, BASE, MAX_RANGE_DAYS };
