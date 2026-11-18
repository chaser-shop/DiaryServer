import { useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Video,
} from "lucide-react";
import {
  isRemote,
  kindLabel,
  lessonState,
  longDate,
  type Lesson,
  type WallClock,
} from "./schedule";

function shift(date: string, days: number) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

export function Schedule({
  lessons,
  now,
  failed,
}: {
  lessons: Lesson[] | null;
  now: WallClock;
  failed: boolean;
}) {
  const [picked, setPicked] = useState("");
  const date = picked || now.date;
  const index = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
  const monday = shift(date, -index);
  const days = new Set(lessons?.map((l) => l.date));
  const rows = (lessons ?? [])
    .filter((l) => l.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));
  const next = [...days].sort().find((d) => d > date);
  return (
    <section className="glass-panel content-card diary-panel agenda">
      <header className="diary-heading">
        <span className="diary-symbol">
          <CalendarDays size={20} />
        </span>
        <h2 className="section-title">Розклад групи</h2>
        <button
          className="diary-quiet agenda-today"
          onClick={() => setPicked(now.date)}
        >
          Сьогодні
        </button>
      </header>
      <div className="agenda-controls">
        <label className="agenda-date">
          {longDate(date)} {date.slice(0, 4)} <CalendarDays size={14} />
          <input
            type="date"
            aria-label="Перейти до дати"
            value={date}
            onChange={(e) => e.target.value && setPicked(e.target.value)}
          />
        </label>
        <div>
          <button
            className="icon-button"
            aria-label="Попередній тиждень"
            onClick={() => setPicked(shift(date, -7))}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Наступний тиждень"
            onClick={() => setPicked(shift(date, 7))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <nav className="agenda-week" aria-label="Дні тижня">
        {weekdays.map((w, i) => {
          const d = shift(monday, i);
          return (
            <button
              key={d}
              aria-label={w + ", " + longDate(d)}
              aria-pressed={date === d}
              onClick={() => setPicked(d)}
            >
              <span>{w}</span>
              <strong>{Number(d.slice(8))}</strong>
              <i className={days.has(d) ? "has-class" : ""} />
            </button>
          );
        })}
      </nav>
      {failed && <p role="alert">Не вдалося оновити розклад.</p>}
      {rows.length ? (
        <ol className="agenda-list">
          {rows.map((l, i) => (
            <li
              key={i}
              className={lessonState(l, now) === "current" ? "in-class" : ""}
            >
              <div className="agenda-time">
                <b>{l.start}</b>
                <span>{l.end}</span>
              </div>
              <div className="agenda-info">
                <small>
                  {l.pair} пара · {kindLabel(l.kind)}
                  {lessonState(l, now) === "current" && " · Триває"}
                </small>
                <h3>{l.subject}</h3>
                {l.room && (
                  <span>
                    {isRemote(l.room) ? (
                      <Video size={13} />
                    ) : (
                      <MapPin size={13} />
                    )}{" "}
                    {l.room}
                  </span>
                )}
                {l.teacher && <p>{l.teacher}</p>}
                {l.detail && <p>{l.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="agenda-empty">
          <p>
            {lessons
              ? "На цей день пар немає."
              : "Розклад групи ще не завантажено."}
          </p>
          {next && (
            <button className="text-button" onClick={() => setPicked(next)}>
              До найближчого заняття · {longDate(next)}{" "}
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
