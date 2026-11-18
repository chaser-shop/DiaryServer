import type { GroupInfo } from "./schedule";
import type { Scores } from "./subjects";

export type GroupStudent = { id: string; name: string; scores: Scores };

export async function request<T>(action: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/${action}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? "Помилка сервера. Спробуйте ще раз." };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "Немає зʼєднання з сервером." };
  }
}

export const fetchMyScores = () => request<{ scores: Scores | null }>("my-grades");

export const saveMyScore = (key: string, value: number) =>
  request<{ value: number }>("my-grade-update", { key, value });

export const fetchGroupRatings = () =>
  request<{ me: string; students: GroupStudent[] }>("group-ratings");

export const fetchGroupInfo = () => request<GroupInfo>("my-group-info");
