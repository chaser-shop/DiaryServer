// Створює/перевстановлює користувача admin / admin123.
// Запуск: npm run seed  (потрібен .env.local з MONGODB_URI)
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const client = await new MongoClient(process.env.MONGODB_URI).connect();
const users = client.db(process.env.MONGODB_DB || "navs-era").collection("users");
await users
  .createIndex({ login: 1 }, { unique: true, partialFilterExpression: { login: { $type: "string" } } })
  .catch((e) => console.warn("createIndex skipped:", e.message));
await users.updateOne(
  { login: "admin" },
  {
    $set: { passwordHash: await bcrypt.hash("admin123", 10), name: "Адміністратор", role: "admin" },
    $setOnInsert: { login: "admin", createdAt: new Date() },
  },
  { upsert: true },
);
console.log("OK: admin / admin123");
await client.close();
