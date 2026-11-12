/*
 * Розбір таблиці рейтингу (Google Sheets / Excel / CSV) у список студентів з балами за предметами.
 * Один і той самий модуль використовують браузер (імпорт файлу) і сервер (синхронізація з Google Sheets).
 *
 * Структура таблиці:
 *   заголовок:  № з/п | Прізвище, ім’я та по батькові | СПОУ | ТіДтП | Укр | …
 *   рядок:      1     | Берлим Дмитро Сергійович      | 21   |       |     | …
 *
 * Колонка з ПІБ шукається за заголовком («ПІБ» або «Прізвище…»); усе правіше неї з непорожнім
 * заголовком — предмети. Колонки «№», «Разом», «Сума», «Місце» пропускаються (підсумок рахує сервер).
 * Текст у колонках без заголовка (наприклад, «ПОТРЕБУЄ ОНОВЛЕННЯ») зберігається як примітка рядка.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RatingParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAME_HEAD = /(^|\s)(піб|прізвище)/i;
  const SKIP_HEAD = /^(№|n|#|разом|сума|всього|total|місце|рейтинг|середній)/i;
  const NUMBER_HEAD = /^(№|#|n\b)/i;
  const NUMERIC = /^\d+(?:[.,]\d+)?$/;

  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  /** Ключ для зіставлення людини: без приміток у дужках, єдиний апостроф, нижній регістр. */
  function nameKey(name) {
    return clean(String(name || '').replace(/\([^)]*\)/g, ' ').replace(/[`'ʼ‘’]/g, '’')).toLocaleLowerCase('uk');
  }

  /** '' → null (порожньо); число → бали; інший текст → undefined (некоректне значення). */
  function toPoints(v) {
    const s = clean(v);
    if (!s) return null;
    if (!NUMERIC.test(s)) return undefined;
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 100000) return undefined;
    return Math.round(n * 100) / 100;
  }

  /**
   * grid: [рядок][колонка] →
   *   { subjects: [назви], entries: [{ fullName, nameKey, note, subjects, invalid, row, number, remark }], skipped, duplicates }
   * subjects у рядку містить лише числові значення; invalid — нечислові непорожні значення (їх не імпортуємо).
   */
  function parse(grid) {
    let headRow = -1;
    let nameCol = -1;
    for (let r = 0; r < Math.min(grid.length, 30) && headRow < 0; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (NAME_HEAD.test(clean(row[c]))) { headRow = r; nameCol = c; break; }
      }
    }
    if (headRow < 0) throw new Error('Не знайдено колонку з ПІБ. Рядок заголовка має містити «Прізвище, ім’я та по батькові» або «ПІБ».');

    const head = grid[headRow] || [];
    let numberCol = -1;
    for (let c = 0; c < nameCol; c++) if (NUMBER_HEAD.test(clean(head[c]))) { numberCol = c; break; }

    const subjects = [];
    const cols = [];
    const remarkCols = [];
    for (let c = nameCol + 1; c < head.length; c++) {
      const name = clean(head[c]).replace(/[.$]/g, '').slice(0, 30);
      if (!name) { remarkCols.push(c); continue; }
      if (SKIP_HEAD.test(name) || subjects.includes(name)) continue;
      subjects.push(name);
      cols.push(c);
    }
    if (!subjects.length) throw new Error('Праворуч від колонки ПІБ не знайдено жодного предмета.');

    const entries = [];
    const seen = new Set();
    const duplicates = [];
    let skipped = 0;
    for (let r = headRow + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      let full = clean(row[nameCol]);
      if (!full) continue;
      let note = '';
      full = clean(full.replace(/\(([^)]*)\)/g, (_, t) => { note = note || clean(t); return ' '; }));
      const key = nameKey(full);
      if (full.split(' ').length < 2 || full.length > 100) { skipped++; continue; }
      if (seen.has(key)) { duplicates.push(full); skipped++; continue; }
      seen.add(key);
      const scores = {};
      const invalid = {};
      subjects.forEach((s, i) => {
        const p = toPoints(row[cols[i]]);
        if (p === undefined) invalid[s] = clean(row[cols[i]]).slice(0, 40);
        else if (p !== null) scores[s] = p;
      });
      const remark = remarkCols.map((c) => clean(row[c])).filter(Boolean).join('; ').slice(0, 120);
      const num = numberCol >= 0 ? parseInt(clean(row[numberCol]), 10) : NaN;
      entries.push({
        fullName: full, nameKey: key, note: note.slice(0, 60), subjects: scores, invalid, remark,
        row: r + 1, number: Number.isFinite(num) ? num : null,
      });
    }
    if (!entries.length) throw new Error('У таблиці не знайдено жодного студента.');
    return { subjects, entries, skipped, duplicates };
  }

  return { parse, nameKey };
});
