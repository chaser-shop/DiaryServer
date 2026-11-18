import { Bell, ClipboardPenLine, Settings, Share2, Send, Check, BellRing } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  dayLabel,
  kindLabel,
  lessonState,
  longDate,
  type Lesson,
  type WallClock,
} from "./schedule";
import { request } from "./ratingApi";
import "./diary.css";

export type Homework = {
  id: string;
  subject: string;
  task: string;
  due: string;
  files: string[];
};
const key = (l: Lesson) =>
  [l.date, l.start, l.subjectKey, l.kind, l.room].join("|");
const ordered = (lessons: Lesson[]) =>
  [...lessons].sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start),
  );
export { Schedule } from "./DaySchedule";
function readFile(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve({ name: file.name, data: String(r.result).split(",")[1] });
    r.onerror = () => reject(new Error("Не вдалося прочитати файл."));
    r.readAsDataURL(file);
  });
}
export function Composer({
  lessons,
  now,
  saved,
}: {
  lessons: Lesson[];
  now: WallClock;
  saved: () => void;
}) {
  const past = ordered(lessons)
    .filter((l) => lessonState(l, now) === "done")
    .reverse();
  const [selected, setSelected] = useState("");
  const [submission, setSubmission] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState("next");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lesson = past.find((l) => key(l) === selected);
  const next =
    lesson &&
    ordered(lessons).find(
      (l) =>
        lessonState(l, now) === "upcoming" &&
        l.subjectKey === lesson.subjectKey,
    );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const files = form
      .getAll("files")
      .filter((f): f is File => f instanceof File && !!f.name);
    if (
      files.length > 5 ||
      files.reduce((n, f) => n + f.size, 0) > 3 * 1024 * 1024
    )
      return setMessage("До 5 вкладень, разом до 3 МіБ.");
    setBusy(true);
    try {
      const result = await request("diary-homework", {
        submission,
        lesson: selected,
        task: form.get("task"),
        due: next && mode === "next" ? "next" : form.get("due"),
        files: await Promise.all(files.map(readFile)),
      });
      if (!result.ok) return setMessage(result.error);
      saved();
      setSubmission(crypto.randomUUID());
      setSelected("");
      setMessage("Завдання додано для групи.");
    } catch {
      setMessage("Не вдалося прочитати вкладення.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="glass-panel content-card diary-panel">
      <header className="diary-heading"><span className="diary-symbol"><ClipboardPenLine size={20}/></span><h2 className="section-title">Що задали?</h2></header>
      {past[0] && !lesson && (
        <button className="primary-button"
          onClick={() => {
            setSelected(key(past[0]));
            setMode("next");
            setMessage("");
          }}
        >
          Що задали з предмета «{past[0].subject}»?
        </button>
      )}
      {past.length ? (
        <label>
          Завершена пара
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setMessage("");
              setMode("next");
            }}
          >
            <option value="">Оберіть пару</option>
            {past.map((l, i) => (
              <option key={key(l) + i} value={key(l)}>
                {l.subject} · {longDate(l.date)}, {l.start}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>Після завершення пари тут можна записати завдання для групи.</p>
      )}
      {lesson && (
        <form onSubmit={submit} key={selected}>
          <label>
            Що задали з предмета «{lesson.subject}»?
            <textarea name="task" required maxLength={4000} />
          </label>
          <label>
            Термін виконання
            <select
              value={next ? mode : "date"}
              onChange={(e) => setMode(e.target.value)}
            >
              {next && (
                <option value="next">
                  До наступної пари · {longDate(next.date)}
                </option>
              )}
              <option value="date">Вибрати дату</option>
            </select>
          </label>
          {(!next || mode === "date") && (
            <label>
              Виконати до
              <input name="due" type="date" min={now.date} required />
            </label>
          )}
          <label>
            Фото та файли (до 5, разом до 3 МіБ)
            <input name="files" type="file" multiple />
          </label>
          <button className="primary-button" disabled={busy}><Check size={16}/>
            {busy ? "Зберігаємо…" : "Додати завдання"}
          </button>
        </form>
      )}
      <p role="status">{message}</p>
    </section>
  );
}

type Preferences = {
  email: string;
  telegram: string;
  minutes: number;
  reminders: boolean;
  homework: boolean;
  publicKey: string;
};
export function DiarySettings() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const supports =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  useEffect(() => {
    let active = true;
    (async () => {
      const r = await request<Preferences>("diary-settings");
      if (!active) return;
      if (!r.ok) return setStatus(r.error);
      setPrefs(r.data);
      if (supports) {
        const reg = await navigator.serviceWorker.getRegistration();
        const current = await reg?.pushManager.getSubscription();
        if (current && active) {
          const synced = await request("diary-device", current.toJSON());
          if (active && synced.ok) setSub(current);
        }
      }
    })().catch(() => setStatus("Не вдалося перевірити підписку."));
    return () => {
      active = false;
    };
  }, [supports]);
  async function run(work: () => Promise<string>) {
    setBusy(true);
    try {
      setStatus(await work());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Дія не вдалася.");
    } finally {
      setBusy(false);
    }
  }
  async function device() {
    if (sub) {
      const r = await request("diary-device", {
        endpoint: sub.endpoint,
        remove: true,
      });
      if (!r.ok) return r.error;
      await sub.unsubscribe();
      setSub(null);
      return "Push вимкнено.";
    }
    if ((await Notification.requestPermission()) !== "granted")
      return "Дозвольте сповіщення для сайту в налаштуваннях браузера.";
    await navigator.serviceWorker.register("/diary-sw.js");
    const reg = await navigator.serviceWorker.ready;
    const raw = prefs!.publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const current =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(raw), (c) =>
          c.charCodeAt(0),
        ),
      }));
    const r = await request("diary-device", current.toJSON());
    if (!r.ok) return r.error;
    setSub(current);
    return "Сповіщення на цьому пристрої ввімкнено.";
  }
  return (
    <section className="glass-panel content-card diary-panel">
      <header className="diary-heading"><span className="diary-symbol"><Settings size={20}/></span><h2 className="section-title">Налаштування</h2></header>
      {prefs && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await request("diary-settings", prefs);
                return r.ok ? "Налаштування збережено." : r.error;
              });
            }}
          >
            <label>
              Електронна пошта
              <input
                type="email"
                value={prefs.email}
                onChange={(e) => setPrefs({ ...prefs, email: e.target.value })}
              />
            </label>
            <label>
              Telegram
              <input
                placeholder="@username"
                value={prefs.telegram}
                onChange={(e) =>
                  setPrefs({ ...prefs, telegram: e.target.value })
                }
              />
            </label>
            <h3 className="diary-subheading"><BellRing size={16}/>Сповіщення на пристрої</h3>
            <label>
              <input
                type="checkbox"
                checked={prefs.reminders}
                onChange={(e) =>
                  setPrefs({ ...prefs, reminders: e.target.checked })
                }
              />{" "}
              Нагадувати про пару
            </label>
            <label>
              За скільки хвилин до початку
              <input
                type="number"
                min="1"
                max="180"
                required
                disabled={!prefs.reminders}
                value={prefs.minutes || ""}
                onChange={(e) =>
                  setPrefs({ ...prefs, minutes: Number(e.target.value) })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={prefs.homework}
                onChange={(e) =>
                  setPrefs({ ...prefs, homework: e.target.checked })
                }
              />{" "}
              Повідомляти про нове домашнє завдання
            </label>
            <button className="primary-button" disabled={busy}><Check size={16}/>Зберегти налаштування</button>
          </form>
          {supports ? (
            <div className="diary-actions">
              <button className="diary-quiet" disabled={busy} onClick={() => run(device)}><Bell size={16}/>
                {sub ? "Вимкнути push" : "Увімкнути push"}
              </button>
              <button className="diary-quiet"
                disabled={!sub || busy}
                onClick={() =>
                  run(async () => {
                    const r = await request("diary-test", {
                      endpoint: sub!.endpoint,
                    });
                    return r.ok ? "Тестове сповіщення надіслано." : r.error;
                  })
                }
              >
                <Send size={15}/> Тестове сповіщення
              </button>
            </div>
          ) : (
            <p>
              Push недоступний у цьому браузері. На iPhone відкрийте щоденник з
              початкового екрана.
            </p>
          )}
          <button className="diary-quiet"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const url = location.origin;
                if (navigator.share) {
                  try {
                    await navigator.share({ title: "Щоденник НАВС", url });
                  } catch (e) {
                    if (!(e instanceof DOMException && e.name === "AbortError"))
                      throw e;
                  }
                  return "";
                }
                await navigator.clipboard.writeText(url);
                return "Посилання скопійовано.";
              })
            }
          >
            <Share2 size={15}/> Поділитися щоденником
          </button>
        </>
      )}
      <p role="status">{status || (!prefs ? "Завантаження…" : "")}</p>
    </section>
  );
}
