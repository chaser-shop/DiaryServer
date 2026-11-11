/*
 * Розбір таблиці розкладу (портал ACY) у список пар.
 * Порт ScheduleParser.swift: те саме формат клітинок, ті самі id пар («yyyyMMdd-номер»).
 *
 * Структура:
 *   рядок з днем:  Пн | 12.10.2026 | 19.10.2026 | …
 *   рядок пари:    «3 пара\n11:00-12:20» | клітинка для кожного тижня
 *   клітинка:      «Предмет [Тип  т.7/з.7]\nауд. 416-ЦК\nВикладач»
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_NAMES = new Set(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']);
  const PAIR_RE = /^\s*(\d+)\s*пара\s+(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/;

  // Час пар у розкладі — київський, незалежно від часового поясу пристрою адміністратора.
  const TZ = (function () {
    for (const z of ['Europe/Kyiv', 'Europe/Kiev']) {
      try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch (e) { /* далі */ }
    }
    return null;
  })();

  function tzOffsetMs(ms) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms));
    const v = {};
    parts.forEach((p) => { v[p.type] = +p.value; });
    const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  /** Київський «настінний» час → момент UTC. */
  function zonedToUtc(y, mo, d, h, mi) {
    if (!TZ) return new Date(y, mo - 1, d, h, mi);
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    let utc = wall - tzOffsetMs(wall);
    utc = wall - tzOffsetMs(utc);
    return new Date(utc);
  }

  const pad = (n, w) => String(n).padStart(w || 2, '0');

  function parseDay(text) {
    const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(String(text || ''));
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, mo, d };
  }

  function parseCell(cell) {
    const info = { name: '', kind: '', topic: '', room: '', teacher: '', remote: false };
    const lines = String(cell).replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return info;
    const title = lines[0];
    const open = title.indexOf('[');
    if (open >= 0) {
      info.name = title.slice(0, open).trim();
      let inner = title.slice(open + 1);
      const close = inner.indexOf(']');
      if (close >= 0) inner = inner.slice(0, close);
      const parts = inner.split(/[ \t\u00A0]+/).filter(Boolean);
      if (parts.length) info.kind = parts[0];
      if (parts.length > 1) info.topic = parts.slice(1).join(' ');
    } else {
      info.name = title;
    }
    const teachers = [];
    for (const line of lines.slice(1)) {
      if (line.toLowerCase().startsWith('ауд')) {
        let room = line;
        const dot = room.indexOf('.');
        if (dot >= 0) room = room.slice(dot + 1).trim();
        if (room.toLowerCase().includes('дистанц')) info.remote = true;
        else info.room = room;
      } else {
        teachers.push(line);
      }
    }
    info.teacher = teachers.join(', ');
    return info;
  }

  /** grid: [рядок][колонка] рядків → { title, lessons } */
  function parse(grid) {
    const lessons = [];
    let dates = [];
    for (const row of grid) {
      if (!row || !row.length) continue;
      const head = String(row[0] == null ? '' : row[0]).trim();

      if (DAY_NAMES.has(head)) {
        dates = row.map((c) => parseDay(c));
        continue;
      }
      const m = PAIR_RE.exec(head);
      if (!m || !dates.length) continue;
      const pair = +m[1], sh = +m[2], sm = +m[3], eh = +m[4], em = +m[5];

      for (let col = 1; col < row.length; col++) {
        const day = dates[col];
        if (!day) continue;
        const cell = String(row[col] == null ? '' : row[col]).trim();
        if (!cell) continue;
        const info = parseCell(cell);
        if (!info.name) continue;
        lessons.push({
          id: `${day.y}${pad(day.mo)}${pad(day.d)}-${pair}`,
          pair,
          start: zonedToUtc(day.y, day.mo, day.d, sh, sm).toISOString(),
          end: zonedToUtc(day.y, day.mo, day.d, eh, em).toISOString(),
          subjectKey: info.name,
          kind: info.kind,
          topic: info.topic,
          room: info.room,
          teacher: info.teacher,
          isRemote: info.remote,
        });
      }
    }
    if (!lessons.length) throw new Error('У файлі не знайдено жодної пари. Перевірте, що це розклад групи.');

    let title = '';
    if (grid[0] && grid[0][0] != null) title = String(grid[0][0]).trim();
    if (grid.length > 1 && grid[1] && grid[1][0] != null) {
      const r = String(grid[1][0]).trim();
      if (r) title += title ? ' · ' + r : r;
    }
    lessons.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { title, lessons };
  }

  /** CSV (utf-8 або windows-1251) → сітка. */
  function readCSV(buffer) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      text = new TextDecoder('windows-1251').decode(buffer);
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    // Роздільник визначаємо за першими рядками (заголовок може не містити жодного).
    const head = text.split(/\r\n|\n|\r/).slice(0, 12).join('\n');
    let delimiter = ',';
    let best = (head.match(/,/g) || []).length;
    for (const d of [';', '\t']) {
      const n = head.split(d).length - 1;
      if (n > best) { best = n; delimiter = d; }
    }

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* ігноруємо */ }
      else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  return { parse, readCSV, zonedToUtc, parseCell };
});
