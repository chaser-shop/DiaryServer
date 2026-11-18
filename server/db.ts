import { MongoClient, type Db } from "mongodb";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// MongoDB (кешується між викликами serverless-функції)
// Колекції: users (службові), groups, students, grades, lessons, activity
// ---------------------------------------------------------------------------
const globalForMongo = globalThis as unknown as { __navsDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForMongo.__navsDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    globalForMongo.__navsDb = (async () => {
      const client = await new MongoClient(uri).connect();
      const db = client.db(process.env.MONGODB_DB || "navs-era");
      const users = db.collection("users");
      // Помилка індексу не повинна блокувати вхід.
      const safe = (p: Promise<unknown>) =>
        p.catch((e) => console.warn("createIndex skipped:", e instanceof Error ? e.message : e));
      await safe(
        users.createIndex(
          { login: 1 },
          { unique: true, partialFilterExpression: { login: { $type: "string" } } },
        ),
      );
      await safe(db.collection("students").createIndex({ login: 1 }, { unique: true }));
      await safe(db.collection("groups").createIndex({ name: 1 }, { unique: true }));
      await safe(db.collection("grades").createIndex({ studentId: 1 }, { unique: true }));
      // Початковий користувач: admin / admin123 (створюється один раз)
      await users.updateOne(
        { login: "admin" },
        {
          $setOnInsert: {
            login: "admin",
            passwordHash: await bcrypt.hash("admin123", 10),
            name: "Адміністратор",
            role: "admin",
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      return db;
    })().catch((err) => {
      globalForMongo.__navsDb = undefined;
      throw err;
    });
  }
  return globalForMongo.__navsDb;
}

