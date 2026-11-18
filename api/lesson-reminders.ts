import { QueueClient } from "@vercel/queue";
import { ObjectId } from "mongodb";
import { getDb } from "../server/db.js";
import { scheduleReminders, type ReminderJob } from "../server/diary.js";

const queue = new QueueClient();
export default queue.handleNodeCallback<ReminderJob>(
  async ({ groupId, at }) => {
    await scheduleReminders(await getDb(), new ObjectId(groupId), at);
  },
);
