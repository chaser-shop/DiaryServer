import type { VercelRequest, VercelResponse } from "@vercel/node";
import { MongoClient, type Collection } from "mongodb";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

type UserDoc = {
  login: string;
  passwordHash: string;
  name: string;
  role: string;
  createdAt: Date;
};

const COOKIE = "navs_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 днів

// --- MongoDB (кешується між викликами serverless-функції) ---
const globalForMongo = globalThis as unknown as {
  __navsMongo?: Promise<Collection<UserDoc>>;
};

function getUsers(): Promise<Collection<UserDoc>> {
  if (!globalForMongo.__navsMongo) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    globalForMongo.__navsMongo = (async () => {
      const client = await new MongoClient(uri).connect();
      const users = client.db(process.env.MONGODB_DB || "navs").collection<UserDoc>("users");
      await users.createIndex({ login: 1 }, { unique: true });
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
      return users;
    })().catch((err) => {
      globalForMongo.__navsMongo = undefined;
      throw err;
    });
  }
  return globalForMongo.__navsMongo;
}

// --- Сесія (JWT у httpOnly cookie) ---
function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

function cookie(value: string, maxAge: number) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readSession(req: VercelRequest) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret());
    return { login: String(payload.sub), name: String(payload.name ?? "") };
  } catch {
    return null;
  }
}

// Фіктивний хеш, щоб час відповіді не видавав, чи існує логін
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  const action = String(req.query.action);

  try {
    if (action === "login") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { login, password } = (req.body ?? {}) as { login?: unknown; password?: unknown };
      if (typeof login !== "string" || typeof password !== "string" || !login || !password) {
        return res.status(400).json({ error: "Введіть логін і пароль" });
      }
      const users = await getUsers();
      const user = await users.findOne({ login: login.trim().toLowerCase() });
      const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) return res.status(401).json({ error: "Невірний логін або пароль" });

      const token = await new SignJWT({ name: user.name })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.login)
        .setIssuedAt()
        .setExpirationTime(`${MAX_AGE}s`)
        .sign(secret());
      res.setHeader("Set-Cookie", cookie(token, MAX_AGE));
      return res.status(200).json({ user: { login: user.login, name: user.name } });
    }

    if (action === "me") {
      const user = await readSession(req);
      return user ? res.status(200).json({ user }) : res.status(401).json({ user: null });
    }

    if (action === "logout") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      res.setHeader("Set-Cookie", cookie("", 0));
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Помилка сервера" });
  }
}
