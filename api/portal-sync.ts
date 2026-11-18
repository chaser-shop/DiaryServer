import { QueueClient } from "@vercel/queue";
import { getDb } from "../server/db.js";
import { runSyncJob, type SyncJob } from "../server/groupSync.js";
export default new QueueClient().handleNodeCallback<SyncJob>(async (job) =>
  runSyncJob(await getDb(), job),
);
