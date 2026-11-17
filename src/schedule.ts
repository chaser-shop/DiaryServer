// Спільний модуль розкладу: типи, розбір таблиці з Excel, пошук найближчої пари.
// Не залежить від React і від бібліотеки читання Excel — приймає вже зчитаний масив рядків.

export type Lesson = {
  /** YYYY-MM-DD */
  date: string;
  pair: number;
  /** HH:mm */
  start: string;
  end: string;
  /** Назва так, як у файлі розкладу (наприклад «Інф ТтаС») */
  subject: string;
  /** Ключ предмета: один з 8 відомих (kpu, spou…) або x-<назва> */
  subjectKey: string;
  /** Пз, Сем, Лек, КонсЕкз… */
  kind: string;
  /** Додаткова позначка, наприклад «т.7/з.2» */
  detail: string;
  /** Аудиторія або «Дистанційно» */
  room: string;
  teacher: string;
};

export type SubjectLink = { key: string; url: string };

export type GroupSchedule = {
  fileName: string;
  uploadedAt: string;
  /** Назва групи з файлу (інформаційно) */
  groupLabel?: string;
  /** Період з файлу, наприклад «17.11.2026-15.12.2026» */
  period?: string;
  lessons: Lesson[];
};

/** Що бачить студент про свою групу. */
export type GroupInfo = {
  groupName: string;
  /** YYYY-MM-DD або null, якщо адмін ще не вказав */
  sessionStart: string | null;
  schedule: { uploadedAt: string; lessons: Lesson[] } | null;
  subjectLinks: SubjectLink[];
};

// ---------------------------------------------------------------------------
// Предмети
// ---------------------------------------------------------------------------

/** Назва з розкладу (лише літери, нижній регістр) → ключ предмета з рейтингу. */
const SUBJECT_ALIASES: Record<string, string> = {
  кпу: "kpu",
  споу: "spou",
  інфттас: "it",
  іноземнамова: "english",
  вступдоспец: "vds",
  умпс: "umsp",
  умсп: "umsp",
  сфп: "sfp",
  тіідтап: "tidtp",
};

const lettersOnly = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function subjectKeyOf(name: string): string {
  const norm = lettersOnly(name);
  return SUBJECT_ALIASES[norm] ?? `x-${norm.slice(0, 40) || "unknown"}`;
}

const KIND_LABELS: Record<string, string> = {
  Пз: "Практичне заняття",
  Сем: "Семінар",
  Лек: "Лекція",
  Лаб: "Лабораторна робота",
  КонсЕкз: "Консультація до екзамену",
  Екз: "Екзамен",
  Зал: "Залік",
};

export const kindLabel = (kind: string) => (kind ? (KIND_LABELS[kind] ?? kind) : "Заняття");

export const isRemote = (room: string) => /дистанц/i.test(room);

// ---------------------------------------------------------------------------
// Розбір таблиці Excel
// ---------------------------------------------------------------------------

const DAY_RE = /^(Пн|Вт|Ср|Чт|Пт|Сб|Нд)$/;
const PAIR_RE = /^(\d+)\s*пара\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/i;
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

const pad = (n: number | string) => String(n).padStart(2, "0");
const cellText = (value: unknown) =>
  String(value ?? "")
    .replace(/\r/g, "")
    .trim();

function parseDate(text: string): string | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

type ParsedCell = Pick<Lesson, "subject" | "kind" | "detail" | "room" | "teacher">;

function parseCell(text: string): ParsedCell[] {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[][] = [];
  for (const line of lines) {
    const startsLesson = /\[[^\]]*\]/.test(line) && !/^ауд/i.test(line);
    if (startsLesson || chunks.length === 0) chunks.push([line]);
    else chunks[chunks.length - 1].push(line);
  }

  return chunks.map((chunk) => {
    const head = chunk[0];
    const m = /^(.*?)\s*\[\s*([^\s\]]+)(?:\s+([^\]]*?))?\s*\]\s*$/.exec(head);
    const subject = (m ? m[1] : head).trim();
    const kind = m ? m[2].trim() : "";
    const detail = m ? (m[3] ?? "").trim() : "";

    let room = "";
    const teachers: string[] = [];
    for (const line of chunk.slice(1)) {
      const aud = /^ауд\.?\s*(.*)$/i.exec(line);
      if (aud && !room) room = aud[1].trim();
      else teachers.push(line);
    }
    // «Дистанційно, Дистанційно» → «Дистанційно»
    room = Array.from(new Set(room.split(",").map((part) => part.trim()).filter(Boolean))).join(", ");

    return { subject, kind, detail, room, teacher: teachers.join(", ") };
  });
}

export type ParsedSchedule = { lessons: Lesson[]; groupLabel: string; period: string };

/**
 * Таблиця ACY Portal: кожен день тижня — блок рядків. У заголовку блока в колонках B.. стоять дати
 * (по одній на тиждень), нижче — рядки «N пара / hh:mm-hh:mm» з текстом заняття в тій самій колонці.
 */
export function parseScheduleRows(rows: unknown[][]): ParsedSchedule {
  const groupLabel = cellText(rows[0]?.[0]).replace(/^Розклад групи:\s*/i, "");
  const period = cellText(rows[1]?.[0]);

  const lessons: Lesson[] = [];
  let dates: (string | null)[] | null = null;

  for (const row of rows) {
    const first = cellText(row[0]);

    if (DAY_RE.test(first)) {
      dates = row.map((cell, index) => (index === 0 ? null : parseDate(cellText(cell))));
      continue;
    }

    const pairMatch = PAIR_RE.exec(first);
    if (!pairMatch || !dates) continue;

    const pair = Number(pairMatch[1]);
    const start = `${pad(pairMatch[2])}:${pairMatch[3]}`;
    const end = `${pad(pairMatch[4])}:${pairMatch[5]}`;

    for (let col = 1; col < row.length; col++) {
      const text = cellText(row[col]);
      const date = dates[col];
      if (!text || !date) continue;
      for (const cell of parseCell(text)) {
        if (!cell.subject) continue;
        lessons.push({ date, pair, start, end, subjectKey: subjectKeyOf(cell.subject), ...cell });
      }
    }
  }

  if (!dates) throw new Error("Не знайдено днів тижня. Перевірте, що це файл розкладу з порталу.");
  if (!lessons.length) throw new Error("У файлі не знайдено жодної пари.");

  lessons.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return { lessons, groupLabel, period };
}

// ---------------------------------------------------------------------------
// Час (за київським часом — так записано розклад)
// ---------------------------------------------------------------------------

let kyivFormatter: Intl.DateTimeFormat | null = null;

function getKyivFormatter() {
  if (!kyivFormatter) {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };
    try {
      kyivFormatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "Europe/Kyiv" });
    } catch {
      kyivFormatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "Europe/Kiev" });
    }
  }
  return kyivFormatter;
}

export type WallClock = { date: string; minutes: number };

export function kyivNow(now: Date = new Date()): WallClock {
  const parts = Object.fromEntries(getKyivFormatter().formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Абсолютна хвилина (для порівняння і різниці між днями). */
const absMinutes = (date: string, minutes: number) => dayNumber(date) * 1440 + minutes;

export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

export const lessonDuration = (lesson: Lesson) => toMinutes(lesson.end) - toMinutes(lesson.start);

export type LessonState = "done" | "current" | "upcoming";

export function lessonState(lesson: Lesson, now: WallClock): LessonState {
  const nowAbs = absMinutes(now.date, now.minutes);
  if (absMinutes(lesson.date, toMinutes(lesson.end)) <= nowAbs) return "done";
  if (absMinutes(lesson.date, toMinutes(lesson.start)) <= nowAbs) return "current";
  return "upcoming";
}

export type NextLesson = {
  lesson: Lesson;
  state: "current" | "upcoming";
  /** Хвилин до початку (upcoming) або до кінця (current) */
  minutes: number;
  /** Днів до дати пари (0 — сьогодні) */
  days: number;
};

/** Перша пара, що ще не закінчилась: або триває зараз, або попереду. */
export function findNextLesson(lessons: Lesson[], now: WallClock): NextLesson | null {
  const nowAbs = absMinutes(now.date, now.minutes);
  for (const lesson of lessons) {
    const end = absMinutes(lesson.date, toMinutes(lesson.end));
    if (end <= nowAbs) continue;
    const start = absMinutes(lesson.date, toMinutes(lesson.start));
    const current = start <= nowAbs;
    return {
      lesson,
      state: current ? "current" : "upcoming",
      minutes: current ? end - nowAbs : start - nowAbs,
      days: daysBetween(now.date, lesson.date),
    };
  }
  return null;
}

export const lessonsOnDate = (lessons: Lesson[], date: string) =>
  lessons.filter((lesson) => lesson.date === date);

// ---------------------------------------------------------------------------
// Форматування
// ---------------------------------------------------------------------------

export function pluralUk(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n);
  if (abs % 10 === 1 && abs % 100 !== 11) return one;
  if (abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 12 || abs % 100 > 14)) return few;
  return many;
}

export function formatMinutes(total: number) {
  if (total < 1) return "менше хвилини";
  if (total < 60) return `${total} хв`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

/** Лічильник для плашки: «Через 24 хв», «Ще 35 хв», «Завтра», «Через 3 дні». */
export function countdownParts(next: NextLesson): { label: string; value: string } {
  if (next.state === "current") return { label: "Ще", value: formatMinutes(next.minutes) };
  if (next.days === 0) return { label: "Через", value: formatMinutes(next.minutes) };
  if (next.days === 1) return { label: "", value: "Завтра" };
  return { label: "Через", value: `${next.days} ${pluralUk(next.days, "день", "дні", "днів")}` };
}

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** «Сьогодні», «Завтра» або «Понеділок, 23 листопада». */
export function dayLabel(date: string, today: string) {
  const diff = daysBetween(today, date);
  if (diff === 0) return "Сьогодні";
  if (diff === 1) return "Завтра";
  const [y, m, d] = date.split("-").map(Number);
  return capitalize(
    new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("uk-UA", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }),
  );
}

/** «25 квітня» */
export function longDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** «23.11.2026» для відображення дати в адмінці. */
export function shortDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

export const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

/** Лише http(s)-посилання; без протоколу додаємо https://. Порожній рядок — «без посилання». */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Тижні (для перегляду розкладу в адмінці)
// ---------------------------------------------------------------------------

export const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Понеділок тижня, до якого належить дата. */
export const mondayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
};
