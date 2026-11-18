import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { send } from "@vercel/queue";
import { kyivNow, type Lesson } from "../src/schedule.js";
import { readPortal } from "./portal.js";
import { scheduleReminders } from "./diary.js";

export type SyncJob = { groupId: string; version: string; at: number };
const HOUR = 3600000;

function queueNext(groupId: string, version: string, at: number) {
  return send(
    "navs-group-sync",
    { groupId, version, at },
    {
      delaySeconds: Math.max(1, Math.ceil((at - Date.now()) / 1000)),
      retentionSeconds: 86400,
      idempotencyKey: version + "-" + at,
    },
  );
}

export async function refreshGroup(
  db: Db,
  id: ObjectId,
  values?: string[],
  expectedVersion?: string,
) {
  const groups = db.collection("groups");
  const group = await groups.findOne({ _id: id });
  if (expectedVersion && group?.portal?.version !== expectedVersion)
    return null;
  if (!group || (!values && !group.portal))
    throw new Error("Спочатку підключіть розклад групи.");
  const started = new Date();
  const filter = {
    _id: id,
    "portal.version": group.portal?.version ?? null,
    "schedule.uploadedAt": group.schedule?.uploadedAt ?? null,
  };
  try {
    const result = await readPortal(values ?? group.portal.values);
    if (!result.lessons || result.lessons.length > 3000)
      throw new Error("Портал не повернув повну таблицю пар.");
    const labels = result.selected.map((o) => o.label);
    const version = values ? randomUUID() : group.portal.version;
    if (values) await queueNext(String(id), version, Date.now() + HOUR);
    const today = kyivNow().date;
    const earliest = kyivNow(new Date(Date.now() - 60 * 86400000)).date;
    const prior =
      !values || values.join("|") === group.portal?.values.join("|")
        ? (group.schedule?.lessons ?? []).filter(
            (l: Lesson) =>
              l.date >= earliest &&
              l.date < today &&
              (!result.lessons?.length || l.date < result.lessons[0].date),
          )
        : [];
    const schedule = {
      fileName: "АСУ НАВС",
      uploadedAt: started,
      groupLabel: labels[2],
      lessons: [...prior, ...result.lessons],
    };
    const doc = await groups.findOneAndUpdate(
      filter,
      {
        $set: {
          schedule,
          portal: {
            version,
            values: values ?? group.portal.values,
            labels,
            checkedAt: started,
            error: "",
          },
        },
      },
      { returnDocument: "after" },
    );
    if (!doc) throw new Error("Налаштування вже змінилися. Оновіть сторінку.");
    await scheduleReminders(db, id);
    return doc;
  } catch (err) {
    if (!values)
      await groups.updateOne(filter, {
        $set: {
          "portal.checkedAt": started,
          "portal.error":
            "Не вдалося оновити розклад НАВС. Збережено попередню версію.",
        },
      });
    throw err;
  }
}

export async function runSyncJob(db: Db, job: SyncJob) {
  const id = new ObjectId(job.groupId);
  const group = await db
    .collection("groups")
    .findOne({ _id: id, "portal.version": job.version });
  if (!group) return;
  const nextAt =
    job.at + Math.max(1, Math.floor((Date.now() - job.at) / HOUR) + 1) * HOUR;
  await queueNext(job.groupId, job.version, nextAt);
  if (new Date(group.portal.checkedAt).getTime() >= job.at) return;
  await refreshGroup(db, id, undefined, job.version);
}
