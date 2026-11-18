import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ObjectId } from "mongodb";
import { getDb } from "../server/db.js";
import { groupDto } from "../server/group.js";
import { readSession } from "../server/session.js";
import { PortalError, readPortal } from "../server/portal.js";
import { refreshGroup } from "../server/groupSync.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  if ((await readSession(req))?.role !== "admin")
    return res.status(403).json({ error: "Потрібні права адміністратора." });
  const { mode, groupId, values } = req.body ?? {};
  if (
    !ObjectId.isValid(String(groupId)) ||
    !Array.isArray(values) ||
    values.some((v) => typeof v !== "string" || !/^\d{1,16}$/.test(v))
  )
    return res.status(400).json({ error: "Некоректний вибір групи." });
  const id = new ObjectId(groupId);
  try {
    if (mode === "options" && values.length <= 2)
      return res.json({ options: (await readPortal(values)).options });
    const db = await getDb();
    if (mode === "disconnect") {
      const g = await db
        .collection("groups")
        .findOneAndUpdate(
          { _id: id },
          { $unset: { portal: "" } },
          { returnDocument: "after" },
        );
      return g ? res.json({ group: groupDto(g) }) : res.status(404).end();
    }
    if (mode === "refresh" || (mode === "connect" && values.length === 3)) {
      const g = await refreshGroup(
        db,
        id,
        mode === "connect" ? values : undefined,
      );
      return res.json({ group: groupDto(g) });
    }
    return res.status(400).end();
  } catch (e) {
    console.error(
      "Portal timetable",
      e instanceof Error ? e.message : "Unknown error",
    );
    return res.status(502).json({
      error:
        e instanceof PortalError
          ? e.message
          : "Не вдалося зберегти налаштування розкладу. Спробуйте ще раз.",
    });
  }
}
