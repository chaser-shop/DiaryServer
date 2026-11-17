import type { VercelRequest, VercelResponse } from "@vercel/node";
import { MongoClient, ObjectId, type Db } from "mongodb";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { randomInt } from "node:crypto";

const COOKIE = "navs_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 днів

const SUBJECTS = ["kpu", "spou", "it", "english", "vds", "umsp", "sfp", "tidtp"] as const;
type SubjectKey = (typeof SUBJECTS)[number];

// ---------------------------------------------------------------------------
// MongoDB (кешується між викликами serverless-функції)
// Колекції: users (службові), groups, students, grades, lessons, activity
// ---------------------------------------------------------------------------
const globalForMongo = globalThis as unknown as { __navsDb?: Promise<Db> };

function getDb(): Promise<Db> {
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

// ---------------------------------------------------------------------------
// Сесія (JWT у httpOnly cookie)
// ---------------------------------------------------------------------------
type Session = { login: string; name: string; role: string; group?: string };

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

function cookie(value: string, maxAge: number) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readSession(req: VercelRequest): Promise<Session | null> {
  const raw = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret());
    return {
      login: String(payload.sub),
      name: String(payload.name ?? ""),
      role: typeof payload.role === "string" ? payload.role : "student",
      group: typeof payload.group === "string" ? payload.group : undefined,
    };
  } catch {
    return null;
  }
}

async function startSession(res: VercelResponse, s: Session) {
  const token = await new SignJWT({ name: s.name, role: s.role, group: s.group })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.login)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  res.setHeader("Set-Cookie", cookie(token, MAX_AGE));
  return res.status(200).json({ user: s });
}

// Фіктивний хеш, щоб час відповіді не видавав, чи існує логін
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

// ---------------------------------------------------------------------------
// Генерація логіну та тимчасового пароля студента
// ---------------------------------------------------------------------------
const UA_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ж: "zh", з: "z",
  и: "y", і: "i", ї: "yi", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ь: "", ю: "yu", я: "ya", ы: "y", э: "e", ё: "yo", ъ: "",
};

function transliterate(input: string): string {
  return Array.from(input.toLowerCase())
    .map((char) => UA_TO_LATIN[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)];

const normalizeName = (value: string) => value.replace(/\s+/g, " ").trim();

/** «Коваленко Олена Петрівна» + «КН-21» → kovalenko.op.kn21.x7k */
function generateLogin(fullName: string, groupName: string): string {
  const [surname = "", ...rest] = normalizeName(fullName).split(" ");
  const initials = rest.map((part) => transliterate(part).charAt(0)).join("");
  const suffix = Array.from({ length: 3 }, () => pick(SUFFIX_ALPHABET)).join("");
  return [transliterate(surname).slice(0, 24), initials, transliterate(groupName).slice(0, 12), suffix]
    .filter(Boolean)
    .join(".");
}

function generatePassword(length = 12): string {
  const all = UPPER + LOWER + DIGITS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------
// Допоміжне для адмін-дій
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function toObjectId(value: unknown): ObjectId {
  if (typeof value === "string" && ObjectId.isValid(value) && value.length === 24) {
    return new ObjectId(value);
  }
  throw new HttpError(400, "Некоректний ідентифікатор");
}

const str = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

async function logActivity(
  db: Db,
  admin: string,
  entry: {
    summary: string;
    entityType: "grade" | "student" | "group" | "schedule";
    previousValue?: string;
    newValue?: string;
  },
) {
  await db.collection("activity").insertOne({ ...entry, administrator: admin, createdAt: new Date() });
}

// ---------------------------------------------------------------------------
// Розклад, дата сесії, посилання на пари (зберігаються в документі групи)
// ---------------------------------------------------------------------------
type LessonDoc = {
  date: string;
  pair: number;
  start: string;
  end: string;
  subject: string;
  subjectKey: string;
  kind: string;
  detail: string;
  room: string;
  teacher: string;
};

const MAX_LESSONS = 3000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^[\p{L}\p{N}_-]{1,60}$/u;

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d && y >= 2000 && y <= 2100
  );
}

function cleanLesson(raw: any): LessonDoc {
  const lesson: LessonDoc = {
    date: typeof raw?.date === "string" ? raw.date : "",
    pair: Number(raw?.pair),
    start: typeof raw?.start === "string" ? raw.start : "",
    end: typeof raw?.end === "string" ? raw.end : "",
    subject: str(raw?.subject, 80),
    subjectKey: str(raw?.subjectKey, 60),
    kind: str(raw?.kind, 30),
    detail: str(raw?.detail, 40),
    room: str(raw?.room, 120),
    teacher: str(raw?.teacher, 160),
  };
  if (
    !isIsoDate(lesson.date) ||
    !Number.isInteger(lesson.pair) ||
    lesson.pair < 1 ||
    lesson.pair > 12 ||
    !TIME_RE.test(lesson.start) ||
    !TIME_RE.test(lesson.end) ||
    !lesson.subject ||
    !KEY_RE.test(lesson.subjectKey)
  ) {
    throw new HttpError(400, "Розклад містить некоректний запис. Перевірте файл і завантажте його ще раз.");
  }
  return lesson;
}

/** Порожній рядок — «без посилання»; інакше лише http(s). */
function cleanUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (text.length > 500) throw new HttpError(400, "Посилання задовге (до 500 символів).");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, `Некоректне посилання: ${text.slice(0, 60)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "Посилання має починатися з http:// або https://");
  }
  return url.toString();
}

function cleanSubjectLinks(value: unknown): { key: string; url: string }[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Некоректний список посилань.");
  if (value.length > 100) throw new HttpError(400, "Забагато предметів.");
  const seen = new Set<string>();
  const result: { key: string; url: string }[] = [];
  for (const item of value) {
    const key = str((item as any)?.key, 60);
    if (!KEY_RE.test(key) || seen.has(key)) continue;
    const url = cleanUrl((item as any)?.url);
    if (!url) continue;
    seen.add(key);
    result.push({ key, url });
  }
  return result;
}

const subjectLinksOf = (g: any): { key: string; url: string }[] =>
  Array.isArray(g?.subjectLinks)
    ? g.subjectLinks.map((l: any) => ({ key: String(l.key), url: String(l.url) }))
    : [];

const scheduleOf = (g: any) =>
  g?.schedule && Array.isArray(g.schedule.lessons)
    ? {
        fileName: String(g.schedule.fileName ?? ""),
        uploadedAt: new Date(g.schedule.uploadedAt ?? Date.now()).toISOString(),
        groupLabel: g.schedule.groupLabel ? String(g.schedule.groupLabel) : undefined,
        period: g.schedule.period ? String(g.schedule.period) : undefined,
        lessons: g.schedule.lessons as LessonDoc[],
      }
    : null;

const groupDto = (g: any) => ({
  id: String(g._id),
  name: g.name,
  faculty: g.faculty,
  course: g.course,
  academicYear: g.academicYear,
  curator: g.curator,
  status: g.status,
  sessionStart: typeof g.sessionStart === "string" ? g.sessionStart : null,
  subjectLinks: subjectLinksOf(g),
  schedule: scheduleOf(g),
});

const emptyScores = () => Object.fromEntries(SUBJECTS.map((k) => [k, 0])) as Record<SubjectKey, number>;

async function adminAction(action: string, req: VercelRequest, res: VercelResponse, session: Session) {
  const db = await getDb();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const post = () => {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  };

  if (action === "admin-bootstrap") {
    const [groups, students, grades, lessons, activity] = await Promise.all([
      db.collection("groups").find().sort({ name: 1 }).toArray(),
      db.collection("students").find().sort({ fullName: 1 }).toArray(),
      db.collection("grades").find().sort({ studentName: 1 }).toArray(),
      db.collection("lessons").find().limit(1000).toArray(),
      db.collection("activity").find().sort({ createdAt: -1 }).limit(100).toArray(),
    ]);
    return res.status(200).json({
      groups: groups.map(groupDto),
      students: students.map((s: any) => ({
        id: String(s._id),
        fullName: s.fullName,
        login: s.login,
        password: s.tempPassword ?? undefined,
        groupId: String(s.groupId),
        status: s.status,
        role: "student",
      })),
      grades: grades.map((g: any) => ({
        id: String(g._id),
        studentName: g.studentName,
        groupId: String(g.groupId),
        studentId: String(g.studentId),
        scores: Object.fromEntries(SUBJECTS.map((k) => [k, Number(g[k] ?? 0)])),
      })),
      lessons: lessons.map((l: any) => ({
        id: String(l._id),
        groupId: String(l.groupId),
        day: l.day,
        time: l.time,
        subject: l.subject,
        teacher: l.teacher,
        lessonType: l.lessonType,
        location: l.location,
      })),
      activity: activity.map((a: any) => ({
        id: String(a._id),
        summary: a.summary,
        entityType: a.entityType,
        administrator: a.administrator,
        createdAt: new Date(a.createdAt).toISOString(),
        previousValue: a.previousValue,
        newValue: a.newValue,
      })),
    });
  }

  if (action === "admin-group-create") {
    post();
    const name = str(body.name, 40);
    const faculty = str(body.faculty, 120);
    const curator = str(body.curator, 120);
    const academicYear = str(body.academicYear, 20);
    const course = Number(body.course);
    const status = ["active", "archived", "enrollment"].includes(String(body.status))
      ? String(body.status)
      : "active";
    if (!name || !faculty || !curator || !academicYear) {
      throw new HttpError(400, "Заповніть усі поля групи.");
    }
    if (!Number.isInteger(course) || course < 1 || course > 6) {
      throw new HttpError(400, "Курс має бути від 1 до 6.");
    }
    try {
      const doc = { name, faculty, course, academicYear, curator, status, createdAt: new Date() };
      const { insertedId } = await db.collection("groups").insertOne(doc);
      await logActivity(db, session.name, { summary: `Створено групу ${name}`, entityType: "group" });
      return res.status(200).json({ group: groupDto({ _id: insertedId, ...doc }) });
    } catch (e: any) {
      if (e?.code === 11000) throw new HttpError(409, "Група з такою назвою вже існує.");
      throw e;
    }
  }

  if (action === "admin-group-update") {
    post();
    const id = toObjectId(body.groupId);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    const changes: string[] = [];

    if ("sessionStart" in body) {
      const value = typeof body.sessionStart === "string" ? body.sessionStart.trim() : "";
      if (!value) unset.sessionStart = "";
      else if (isIsoDate(value)) set.sessionStart = value;
      else throw new HttpError(400, "Некоректна дата початку сесії.");
      changes.push(value ? `дату сесії ${value}` : "очищено дату сесії");
    }
    if ("subjectLinks" in body) {
      set.subjectLinks = cleanSubjectLinks(body.subjectLinks);
      changes.push("посилання на пари");
    }
    if (!changes.length) throw new HttpError(400, "Немає що зберігати.");

    const update: Record<string, unknown> = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    const group: any = await db
      .collection("groups")
      .findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
    if (!group) throw new HttpError(404, "Групу не знайдено.");
    await logActivity(db, session.name, {
      summary: `Група ${group.name}: оновлено ${changes.join(", ")}`,
      entityType: "group",
    });
    return res.status(200).json({ group: groupDto(group) });
  }

  if (action === "admin-group-schedule") {
    post();
    const id = toObjectId(body.groupId);
    const rawLessons = Array.isArray(body.lessons) ? body.lessons : null;
    if (!rawLessons) throw new HttpError(400, "Некоректний розклад.");
    if (rawLessons.length > MAX_LESSONS) throw new HttpError(400, "Розклад завеликий.");

    let update: Record<string, unknown>;
    let summary: string;
    if (rawLessons.length === 0) {
      update = { $unset: { schedule: "" } };
      summary = "видалено розклад";
    } else {
      const lessons = rawLessons.map(cleanLesson);
      const fileName = str(body.fileName, 200) || "schedule.xls";
      update = {
        $set: {
          schedule: {
            fileName,
            groupLabel: str(body.groupLabel, 120),
            period: str(body.period, 60),
            uploadedAt: new Date(),
            lessons,
          },
        },
      };
      summary = `завантажено розклад (${lessons.length} пар, ${fileName})`;
    }
    const group: any = await db
      .collection("groups")
      .findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
    if (!group) throw new HttpError(404, "Групу не знайдено.");
    await logActivity(db, session.name, { summary: `Група ${group.name}: ${summary}`, entityType: "schedule" });
    return res.status(200).json({ group: groupDto(group) });
  }

  if (action === "admin-student-create") {
    post();
    const fullName = normalizeName(typeof body.fullName === "string" ? body.fullName : "");
    if (fullName.length < 3 || fullName.length > 120) {
      throw new HttpError(400, "Вкажіть ПІБ студента (від 3 до 120 символів).");
    }
    const group: any = await db.collection("groups").findOne({ _id: toObjectId(body.groupId) });
    if (!group) throw new HttpError(400, "Обрана група не існує.");
    if (group.status === "archived") throw new HttpError(400, "Не можна додавати студентів в архівну групу.");

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 10);
    for (let attempt = 0; attempt < 8; attempt++) {
      const login = generateLogin(fullName, group.name);
      try {
        const { insertedId } = await db.collection("students").insertOne({
          login,
          passwordHash,
          tempPassword: password,
          fullName,
          groupId: group._id,
          status: "active",
          createdAt: new Date(),
        });
        const { insertedId: gradeId } = await db.collection("grades").insertOne({
          studentId: insertedId,
          studentName: fullName,
          groupId: group._id,
          ...emptyScores(),
          updatedAt: new Date(),
        });
        await logActivity(db, session.name, {
          summary: `Додано студента ${fullName} (${group.name})`,
          entityType: "student",
        });
        return res.status(200).json({
          student: {
            id: String(insertedId),
            gradeId: String(gradeId),
            fullName,
            login,
            password,
            groupId: String(group._id),
            groupName: group.name,
          },
        });
      } catch (e: any) {
        if (e?.code === 11000) continue; // логін зайнятий — інший суфікс
        throw e;
      }
    }
    throw new HttpError(500, "Не вдалося згенерувати унікальний логін. Спробуйте ще раз.");
  }

  if (action === "admin-student-reset") {
    post();
    const id = toObjectId(body.studentId);
    const password = generatePassword();
    const result = await db
      .collection("students")
      .updateOne({ _id: id }, { $set: { passwordHash: await bcrypt.hash(password, 10), tempPassword: password } });
    if (!result.matchedCount) throw new HttpError(404, "Студента не знайдено.");
    return res.status(200).json({ password });
  }

  if (action === "admin-grade-update") {
    post();
    const key = String(body.key) as SubjectKey;
    if (!SUBJECTS.includes(key)) throw new HttpError(400, "Невідома дисципліна.");
    const raw = Number(body.value);
    const value = Math.max(0, Math.min(100, Number.isFinite(raw) ? Math.round(raw) : 0));
    const id = toObjectId(body.gradeId);
    const before: any = await db
      .collection("grades")
      .findOneAndUpdate({ _id: id }, { $set: { [key]: value, updatedAt: new Date() } }, { returnDocument: "before" });
    if (!before) throw new HttpError(404, "Запис оцінок не знайдено.");
    await logActivity(db, session.name, {
      summary: `Змінено оцінку для ${before.studentName} (${key})`,
      entityType: "grade",
      previousValue: String(before[key] ?? 0),
      newValue: String(value),
    });
    return res.status(200).json({ ok: true, value });
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Дії студента: власні оцінки, редагування, рейтинг групи
// ---------------------------------------------------------------------------
const scoresOf = (g: any) =>
  Object.fromEntries(SUBJECTS.map((k) => [k, Number(g?.[k] ?? 0)])) as Record<SubjectKey, number>;

async function studentAction(action: string, req: VercelRequest, res: VercelResponse, session: Session) {
  const db = await getDb();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const student: any = await db.collection("students").findOne({ login: session.login });
  if (!student) throw new HttpError(404, "Студента не знайдено.");
  if (student.status === "expelled") throw new HttpError(403, "Доступ закрито");

  let grade: any = await db.collection("grades").findOne({ studentId: student._id });
  if (!grade) {
    const doc = {
      studentId: student._id,
      studentName: student.fullName,
      groupId: student.groupId,
      ...emptyScores(),
      updatedAt: new Date(),
    };
    const { insertedId } = await db.collection("grades").insertOne(doc);
    grade = { _id: insertedId, ...doc };
  }

  if (action === "my-grades") {
    return res.status(200).json({ scores: scoresOf(grade) });
  }

  if (action === "my-grade-update") {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const key = String(body.key) as SubjectKey;
    if (!SUBJECTS.includes(key)) throw new HttpError(400, "Невідома дисципліна.");
    const raw = Number(body.value);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
      throw new HttpError(400, "Оцінка має бути від 0 до 100.");
    }
    const value = Math.round(raw);
    const previous = Number(grade[key] ?? 0);
    await db
      .collection("grades")
      .updateOne({ _id: grade._id }, { $set: { [key]: value, updatedAt: new Date() } });
    await logActivity(db, student.fullName, {
      summary: `Студент змінив власну оцінку для ${student.fullName} (${key})`,
      entityType: "grade",
      previousValue: String(previous),
      newValue: String(value),
    });
    return res.status(200).json({ ok: true, value });
  }

  if (action === "my-group-info") {
    const group: any = await db.collection("groups").findOne({ _id: student.groupId });
    const schedule = scheduleOf(group);
    return res.status(200).json({
      groupName: group?.name ?? "",
      sessionStart: typeof group?.sessionStart === "string" ? group.sessionStart : null,
      schedule: schedule ? { uploadedAt: schedule.uploadedAt, lessons: schedule.lessons } : null,
      subjectLinks: subjectLinksOf(group),
    });
  }

  if (action === "group-ratings") {
    const rows = await db.collection("grades").find({ groupId: student.groupId }).toArray();
    return res.status(200).json({
      me: String(student._id),
      students: rows.map((g: any) => ({
        id: String(g.studentId),
        name: g.studentName,
        scores: scoresOf(g),
      })),
    });
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  const action = String(req.query.action);

  try {
    if (action === "health") {
      const env = {
        MONGODB_URI: !!process.env.MONGODB_URI,
        JWT_SECRET: !!process.env.JWT_SECRET,
      };
      if (!env.MONGODB_URI || !env.JWT_SECRET) return res.status(500).json({ ok: false, env });
      await getDb();
      return res.status(200).json({ ok: true, env, mongo: "connected" });
    }

    if (action === "login") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { login, password } = (req.body ?? {}) as { login?: unknown; password?: unknown };
      if (typeof login !== "string" || typeof password !== "string" || !login || !password) {
        return res.status(400).json({ error: "Введіть логін і пароль" });
      }
      const normalized = login.trim().toLowerCase();
      const db = await getDb();

      // 1) Службовий користувач (admin)
      const user: any = await db.collection("users").findOne({ login: normalized });
      if (user) {
        const ok = await bcrypt.compare(password, user.passwordHash ?? DUMMY_HASH);
        if (!ok) return res.status(401).json({ error: "Невірний логін або пароль" });
        return startSession(res, { login: user.login, name: user.name, role: user.role ?? "admin" });
      }

      // 2) Студент, створений адміністратором
      const student: any = await db.collection("students").findOne({ login: normalized });
      const ok = await bcrypt.compare(password, student?.passwordHash ?? DUMMY_HASH);
      if (!student || !ok) return res.status(401).json({ error: "Невірний логін або пароль" });
      if (student.status === "expelled") return res.status(403).json({ error: "Доступ закрито" });
      const group: any = await db.collection("groups").findOne({ _id: student.groupId });
      return startSession(res, {
        login: student.login,
        name: student.fullName,
        role: "student",
        group: group?.name,
      });
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

    if (
      action === "my-grades" ||
      action === "my-grade-update" ||
      action === "group-ratings" ||
      action === "my-group-info"
    ) {
      const session = await readSession(req);
      if (!session) return res.status(401).json({ error: "Потрібен вхід" });
      if (session.role !== "student") {
        // Адміністратор не має власних оцінок
        if (action === "my-group-info") {
          return res.status(200).json({ groupName: "", sessionStart: null, schedule: null, subjectLinks: [] });
        }
        if (action === "group-ratings") return res.status(200).json({ me: "", students: [] });
        if (action === "my-grades") return res.status(200).json({ scores: null });
        return res.status(403).json({ error: "Лише для студентів" });
      }
      return await studentAction(action, req, res, session);
    }

    if (action.startsWith("admin-")) {
      const session = await readSession(req);
      if (!session) return res.status(401).json({ error: "Потрібен вхід" });
      if (session.role !== "admin") return res.status(403).json({ error: "Лише для адміністратора" });
      return await adminAction(action, req, res, session);
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    let error = "Помилка сервера";
    if (/MONGODB_URI is not set/.test(msg)) error = "На сервері не задано MONGODB_URI";
    else if (/JWT_SECRET is not set/.test(msg)) error = "На сервері не задано JWT_SECRET";
    else if (/ssl|tls|ECONNREFUSED|ENOTFOUND|timed out|Server selection|whitelist|IP/i.test(msg))
      error = "Немає підключення до MongoDB (перевірте Network Access в Атласі і MONGODB_URI)";
    else if (/auth|Authentication/i.test(msg))
      error = "MongoDB: невірний користувач/пароль у MONGODB_URI";
    return res.status(500).json({ error, detail: msg.slice(0, 200) });
  }
}
