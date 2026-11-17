'use strict';
/*
 * Адаптер для Vercel (serverless). Основний варіант розгортання — Render (`npm start`), бо сервер довготривалий.
 * На Vercel працюють сторінки й API, але НЕ працюють фонові задачі: сповіщення про пари, періодична
 * синхронізація з Google-таблицею, перевірка оцінок.
 */
const app = require('../server');

let ready = null;
module.exports = async (req, res) => {
  if (!ready) ready = app.init().catch((e) => { ready = null; throw e; });
  try {
    await ready;
  } catch (e) {
    console.error('Не вдалося ініціалізувати сервер:', e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Сервер не запустився: ${e.message}`);
    return;
  }
  app.server.emit('request', req, res);
};
