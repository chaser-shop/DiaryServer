/*
 * Розбір таблиці рейтингу (Excel / CSV) у список студентів з балами за предметами.
 *
 * Структура таблиці:
 *   заголовок:  № з/п | Прізвище, ім’я та по батькові | СПОУ | ТіДтП | Укр | …
 *   рядок:      1     | Берлим Дмитро Сергійович      | 21   |       |     | …
 *
 * Колонка з ПІБ шукається за заголовком («ПІБ» або «Прізвище…»); усе правіше неї з непорожнім
 * заголовком — предмети. Колонки «№», «Разом», «Сума», «Місце» пропускаються (підсумок рахує сервер).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RatingParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAME_HEAD = /(^|\s)(піб|прізвище)/i;
  const SKIP_HEAD = /^(№|n|#|разом|сума|всього|total|місце|рейтинг|середній)/i;

  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function toPoints(v) {
    const s = clean(v).replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
    return Math.round(n * 100) / 100;
  }

  /** grid: [рядок][колонка] → { subjects: [назви], entries: [{ fullName, note, subjects }], skipped } */
  function parse(grid) {
    let headRow = -1;
    let nameCol = -1;
    for (let r = 0; r < Math.min(grid.length, 20) && headRow < 0; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (NAME_HEAD.test(clean(row[c]))) { headRow = r; nameCol = c; break; }
      }
    }
    if (headRow < 0) throw new Error('Не знайдено колонку з ПІБ. Перший рядок має містити «Прізвище, ім’я та по батькові».');

    const subjects = [];
    const cols = [];
    const head = grid[headRow];
    for (let c = nameCol + 1; c < head.length; c++) {
      const name = clean(head[c]).replace(/[.$]/g, '');
      if (!name || SKIP_HEAD.test(name) || subjects.includes(name)) continue;
      subjects.push(name);
      cols.push(c);
    }
    if (!subjects.length) throw new Error('Праворуч від ПІБ не знайдено жодного предмета.');

    const entries = [];
    const seen = new Set();
    let skipped = 0;
    for (let r = headRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      let full = clean(row[nameCol]);
      if (!full) continue;
      let note = '';
      full = full.replace(/\(([^)]*)\)/g, (_, t) => { note = note || clean(t); return ' '; });
      full = clean(full);
      if (full.split(' ').length < 2 || seen.has(full.toLowerCase())) { skipped++; continue; }
      seen.add(full.toLowerCase());
      const scores = {};
      subjects.forEach((s, i) => {
        const p = toPoints(row[cols[i]]);
        if (p !== null) scores[s] = p;
      });
      entries.push({ fullName: full, note, subjects: scores });
    }
    if (!entries.length) throw new Error('У таблиці не знайдено жодного студента.');
    return { subjects, entries, skipped };
  }

  return { parse };
});
