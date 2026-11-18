import { send } from "@vercel/queue";
import type { Db, Document } from "mongodb";
import { ObjectId } from "mongodb";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import push from "web-push";
import type { Lesson } from "../src/schedule.js";
import { kyivNow, lessonState } from "../src/schedule.js";

const defaults = {
  email: "",
  telegram: "",
  reminders: true,
  minutes: 2,
  homework: true,
};
const lessonId = (l: Lesson) =>
  [l.date, l.start, l.subjectKey, l.kind, l.room].join("|");
const fail = (res: VercelResponse, message: string) =>
  res.status(400).json({ error: message });

async function keys(db: Db) {
  const collection = db.collection<{
    _id: string;
    publicKey: string;
    privateKey: string;
  }>("pushKeys");
  return (
    (await collection.findOne({ _id: "v1" })) ??
    (await collection.findOneAndUpdate(
      { _id: "v1" },
      { $setOnInsert: push.generateVAPIDKeys() },
      { upsert: true, returnDocument: "after" },
    ))!
  );
}

async function deliver(db: Db, device: Document, title: string, body: string) {
  const key = await keys(db);
  try {
    await push.sendNotification(
      device.subscription,
      JSON.stringify({ title, body }),
      {
        TTL: 90,
        timeout: 8000,
        vapidDetails: {
          subject: "https://diary-server.vercel.app",
          publicKey: key.publicKey,
          privateKey: key.privateKey,
        },
      },
    );
    return true;
  } catch (err: any) {
    if ([404, 410].includes(err.statusCode))
      await db.collection("devices").deleteOne({ _id: device._id });
    return false;
  }
}

// Convert the scheduled Kyiv wall time using the offset on the lesson date (including DST).
function startTime(l: Lesson) {
  const probe = Date.parse(l.date + "T" + l.start + ":00Z");
  const wall = kyivNow(new Date(probe));
  const offset =
    Date.parse(wall.date + "T00:00:00Z") + wall.minutes * 60000 - probe;
  return probe - offset;
}

export type ReminderJob = { groupId: string; at: number };
export async function scheduleReminders(
  db: Db,
  groupId: ObjectId,
  from?: number,
) {
  const group = await db.collection("groups").findOne({ _id: groupId });
  const lessons: Lesson[] = group?.schedule?.lessons ?? [];
  if (!lessons.length) return;
  const subscribed = await db.collection("devices").distinct("studentId");
  const students = await db
    .collection("students")
    .find(
      {
        _id: { $in: subscribed },
        groupId,
        status: { $ne: "expelled" },
        "diary.reminders": { $ne: false },
      },
      { projection: { "diary.minutes": 1 } },
    )
    .toArray();
  const now = Date.now();
  let earliest = Infinity;
  for (const l of lessons) {
    const start = startTime(l);
    if (start <= now) continue;
    for (const student of students) {
      const at = start - (student.diary?.minutes ?? 2) * 60000;
      if (at > now) {
        earliest = Math.min(earliest, at);
        continue;
      }
      if (from === undefined || at < from) continue;
      const tag = lessonId(l);
      for await (const device of db
        .collection("devices")
        .find({ studentId: student._id })) {
        const claim = await db
          .collection("devices")
          .updateOne({ _id: device._id, sent: { $ne: tag } }, {
            $push: { sent: { $each: [tag], $slice: -100 } },
          } as any);
        if (
          claim.modifiedCount &&
          !(await deliver(db, device, l.subject, "Початок о " + l.start))
        ) {
          await db
            .collection("devices")
            .updateOne({ _id: device._id }, { $pull: { sent: tag } } as any);
          if (await db.collection("devices").findOne({ _id: device._id }))
            throw new Error("Push delivery failed");
        }
      }
    }
  }
  if (!Number.isFinite(earliest)) return;
  const at = Math.min(
    earliest,
    Math.floor(now / 3600000) * 3600000 + 6 * 86400000,
  );
  await send(
    "lesson-reminders",
    { groupId: String(groupId), at },
    {
      delaySeconds: Math.max(1, Math.ceil((at - Date.now()) / 1000)),
      retentionSeconds: 604800,
      idempotencyKey: String(groupId) + "-" + at,
    },
  );
}

export async function diary(
  action: string,
  req: VercelRequest,
  res: VercelResponse,
  db: Db,
  student: Document,
) {
  const { groupId, _id: studentId } = student;
  const data = req.body ?? {};
  const tasks = db.collection("homework");
  const devices = db.collection("devices");
  if (req.method === "GET") {
    if (action === "diary-settings")
      return res.json({
        ...defaults,
        ...student.diary,
        publicKey: (await keys(db)).publicKey,
      });
    if (action === "diary-homework") {
      const rows = await tasks
        .find({ groupId }, { projection: { "files.data": 0 } })
        .sort({ due: 1, _id: -1 })
        .toArray();
      return res.json(
        rows.map((x) => ({
          id: String(x._id),
          subject: x.subject,
          task: x.task,
          due: x.due,
          files: x.files.map((f: any) => f.name),
        })),
      );
    }
    if (action === "diary-file") {
      const id = String(req.query.id),
        index = Number(req.query.index);
      const row =
        ObjectId.isValid(id) &&
        (await tasks.findOne({ _id: new ObjectId(id), groupId }));
      const file = row && Number.isInteger(index) && row.files[index];
      if (!file) return res.status(404).end();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
      );
      return res.send(Buffer.from(file.data, "base64"));
    }
  }
  if (req.method !== "POST") return res.status(405).end();
  if (action === "diary-settings") {
    const { email, telegram, minutes, reminders, homework } = data;
    if (
      typeof email !== "string" ||
      email.length > 254 ||
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      typeof telegram !== "string" ||
      (telegram && !/^@?[a-zA-Z0-9_]{5,32}$/.test(telegram)) ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 180 ||
      typeof reminders !== "boolean" ||
      typeof homework !== "boolean"
    )
      return fail(
        res,
        "Перевірте пошту, Telegram і час нагадування (1–180 хв).",
      );
    await db
      .collection("students")
      .updateOne(
        { _id: studentId },
        { $set: { diary: { email, telegram, minutes, reminders, homework } } },
      );
    await scheduleReminders(db, groupId);
    return res.json({ ok: true });
  }
  if (action === "diary-device" || action === "diary-test") {
    const endpoint = String(data.endpoint ?? "");
    if (action === "diary-test") {
      const device = await devices.findOne({
        studentId,
        "subscription.endpoint": endpoint,
      });
      if (
        !device ||
        !(await deliver(
          db,
          device,
          "Щоденник НАВС",
          "Тестове сповіщення на цьому пристрої.",
        ))
      )
        return fail(res, "Не вдалося надіслати push. Увімкніть його повторно.");
    } else if (data.remove) {
      await devices.deleteOne({ studentId, "subscription.endpoint": endpoint });
    } else {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        return fail(res, "Некоректна підписка.");
      }
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        !/^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/.test(
          url.hostname,
        ) ||
        !/^[A-Za-z0-9_-]{87}$/.test(data.keys?.p256dh ?? "") ||
        !/^[A-Za-z0-9_-]{22}$/.test(data.keys?.auth ?? "")
      )
        return fail(res, "Підписку цього браузера не підтримано.");
      await devices.createIndex(
        { "subscription.endpoint": 1 },
        { unique: true },
      );
      await devices.updateOne(
        { "subscription.endpoint": endpoint },
        {
          $set: {
            studentId,
            subscription: {
              endpoint,
              keys: { auth: data.keys.auth, p256dh: data.keys.p256dh },
            },
          },
        },
        { upsert: true },
      );
      await scheduleReminders(db, groupId);
    }
    return res.json({ ok: true });
  }
  if (action === "diary-homework") {
    const group = await db.collection("groups").findOne({ _id: groupId });
    const lessons: Lesson[] = group?.schedule?.lessons ?? [];
    const now = kyivNow();
    const lesson = lessons.find(
      (l) => lessonId(l) === data.lesson && lessonState(l, now) === "done",
    );
    if (!lesson) return fail(res, "Оберіть завершену пару з розкладу групи.");
    const next = lessons
      .filter(
        (l) =>
          l.subjectKey === lesson.subjectKey &&
          lessonState(l, now) === "upcoming",
      )
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))[0];
    const due = data.due === "next" ? next?.date : data.due;
    if (
      typeof due !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
      due < now.date ||
      !Number.isFinite(Date.parse(due)) ||
      new Date(due).toISOString().slice(0, 10) !== due
    )
      return fail(res, "Оберіть дійсну дату виконання.");
    const task = String(data.task ?? "").trim();
    if (!task || task.length > 4000)
      return fail(res, "Введіть опис завдання до 4000 символів.");
    const files = data.files;
    if (
      !Array.isArray(files) ||
      files.length > 5 ||
      files.some(
        (f) =>
          typeof f?.name !== "string" ||
          !f.name.trim() ||
          f.name.length > 200 ||
          typeof f.data !== "string" ||
          !/^[a-zA-Z0-9+/]*={0,2}$/.test(f.data),
      ) ||
      files.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0) >
        3 * 1024 * 1024
    )
      return fail(res, "До 5 вкладень, разом до 3 МіБ.");
    if (
      typeof data.submission !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(data.submission)
    )
      return fail(res, "Оновіть форму завдання.");
    await tasks.createIndex(
      { studentId: 1, submission: 1 },
      { unique: true, sparse: true },
    );
    const created = await tasks.updateOne(
      { studentId, submission: data.submission },
      {
        $setOnInsert: {
          groupId,
          studentId,
          lesson: data.lesson,
          subject: lesson.subject,
          due,
          task,
          files: files.map((f) => ({ name: f.name, data: f.data })),
        },
      },
      { upsert: true },
    );
    if (!created.upsertedCount) return res.json({ ok: true });
    const ids = await db
      .collection("students")
      .distinct("_id", {
        groupId,
        status: { $ne: "expelled" },
        "diary.homework": { $ne: false },
      });
    const targets = await devices.find({ studentId: { $in: ids } }).toArray();
    await Promise.allSettled(
      targets.map((device) =>
        deliver(
          db,
          device,
          "Нове домашнє завдання",
          lesson.subject + " · до " + due,
        ),
      ),
    );
    return res.status(201).json({ ok: true });
  }
  return res.status(404).end();
}
