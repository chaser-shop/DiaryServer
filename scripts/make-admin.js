// Використання:  npm run make-admin "Прізвище Ім'я По батькові"
// Створює користувача (якщо його ще немає) і ставить йому галочку isAdmin.
// Після цього адміністратор має одразу сам увійти в застосунок під цим ПІБ.
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../src/models');
const { cleanName, validName, makeKey } = require('../src/names');

(async () => {
  const name = cleanName(process.argv.slice(2).join(' '));
  if (!validName(name)) {
    console.error('Використання: npm run make-admin "Прізвище Ім\'я По батькові"');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOneAndUpdate(
    { nameKey: makeKey(name) },
    { $set: { isAdmin: true }, $setOnInsert: { fullName: name, deviceId: null } },
    { upsert: true, returnDocument: 'after' },
  );
  console.log(`Готово: ${user.fullName} — адміністратор.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
