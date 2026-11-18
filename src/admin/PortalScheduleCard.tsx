import { useEffect, useState } from "react";
import { CalendarSync, RefreshCw } from "lucide-react";
import { request } from "../ratingApi";
import type { AcademyGroup } from "./AcademyDashboard";

type Option = { value: string; label: string };
const fields = ["Факультет", "Курс", "Група"];
export function PortalScheduleCard({
  group,
  onSaved,
}: {
  group: AcademyGroup;
  onSaved: (g: AcademyGroup) => void;
}) {
  const [editing, setEditing] = useState(!group.portal);
  const [values, setValues] = useState<string[]>([]);
  const [lists, setLists] = useState<Option[][]>([]);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    if (!editing || values.length === 3) {
      setLoading(false);
      return;
    }
    setLoading(true);
    request<{ options: Option[] }>("admin-portal", {
      mode: "options",
      groupId: group.id,
      values,
    }).then((r) => {
      if (!active) return;
      setLoading(false);
      if (r.ok)
        setLists((old) => [...old.slice(0, values.length), r.data.options]);
      else setError(r.error);
    });
    return () => {
      active = false;
    };
  }, [values, editing, retry, group.id]);
  async function save(mode: "connect" | "refresh" | "disconnect") {
    setBusy(true);
    setError("");
    const r = await request<{ group: AcademyGroup }>("admin-portal", {
      mode,
      groupId: group.id,
      values,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSaved(r.data.group);
    setEditing(!r.data.group.portal);
    setValues([]);
    setLists([]);
  }
  return (
    <section className="asu-card mb-4 rounded-2xl border border-white/10 bg-white/[.025] p-4">
      <header className="flex items-center gap-2 text-sm font-semibold">
        <CalendarSync size={18} className="text-blue-300" />
        Розклад із порталу НАВС
      </header>
      {group.portal && (
        <div className="mt-3 text-xs leading-5 text-slate-300">
          <p>{group.portal.labels.join(" · ")}</p>
          <p>
            Щогодини · Остання перевірка{" "}
            {new Date(group.portal.checkedAt).toLocaleString("uk-UA", {
              timeZone: "Europe/Kyiv",
            })}
          </p>
          {group.portal.error && <p role="alert">{group.portal.error}</p>}
        </div>
      )}
      {editing && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
          {fields.map((label, i) => (
            <label
              key={label}
              className="grid min-w-0 gap-1 text-xs text-slate-300"
            >
              {label}
              <select
                className="min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-[#0b1d35] px-2 text-base sm:text-sm"
                value={values[i] ?? ""}
                disabled={busy || i > values.length || !lists[i]?.length}
                onChange={(e) => {
                  const v = e.target.value;
                  setLists((old) => old.slice(0, i + 1));
                  setValues([...values.slice(0, i), ...(v ? [v] : [])]);
                }}
              >
                <option value="">
                  {loading && i === values.length
                    ? "Завантаження…"
                    : lists[i]?.length === 0
                      ? "Немає варіантів"
                      : "Оберіть зі списку"}
                </option>
                {lists[i]?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <>
            <button
              className="primary-button"
              disabled={values.length !== 3 || busy}
              onClick={() => save("connect")}
            >
              {busy ? "Завантаження…" : "Підключити автооновлення"}
            </button>
            {error && values.length < 3 && (
              <button
                className="diary-quiet"
                onClick={() => setRetry((x) => x + 1)}
              >
                Повторити
              </button>
            )}
            {group.portal && (
              <button
                disabled={busy}
                className="diary-quiet"
                onClick={() => setEditing(false)}
              >
                Скасувати
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => save("refresh")}
            >
              <RefreshCw size={14} />
              {busy ? "Оновлення…" : "Оновити зараз"}
            </button>
            <button
              className="diary-quiet"
              disabled={busy}
              onClick={() => {
                setValues([]);
                setEditing(true);
              }}
            >
              Змінити групу НАВС
            </button>
            <button
              className="diary-quiet"
              disabled={busy}
              onClick={() => save("disconnect")}
            >
              Вимкнути автооновлення
            </button>
          </>
        )}
      </div>
    </section>
  );
}
