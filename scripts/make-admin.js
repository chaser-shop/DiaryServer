'use strict';
// Використання:  npm run make-admin "Прізвище Ім'я По батькові"
// Створює користувача (якщо його ще немає) і робить його адміністратором.
// Після цього адміністратор має одразу сам увійти в застосунок під цим ПІБ (перший пристрій закріпиться).
// Потрібна змінна MONGODB_URI (та сама, що й для сервера); DB_NAME — за замовчуванням «navs».

const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { normName, normKey } = require('../lib/util');

(async () => {
  const name = normName(process.argv.slice(2).join(' '));
  if (name.split(' ').length < 2 || name.length > 100) {
    console.error('Використання: npm run make-admin "Прізвище Ім\'я По батькові"');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('Не задано MONGODB_URI.');
    process.exit(1);
  }
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const users = client.db(process.env.DB_NAME || 'navs').collection('users');
  const r = await users.findOneAndUpdate(
    { nameKey: normKey(name) },
    {
      $set: { isAdmin: true },
      $setOnInsert: { _id: crypto.randomUUID(), fullName: name, deviceIds: [], deviceMeta: {}, pendingDevices: [], createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  console.log(`Готово: ${r.fullName} — адміністратор.`);
  await client.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
