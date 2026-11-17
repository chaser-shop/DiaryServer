export type SubjectKey = "kpu" | "spou" | "it" | "english" | "vds" | "umsp" | "sfp" | "tidtp";

export type Scores = Record<SubjectKey, number>;

export const SUBJECTS: { key: SubjectKey; label: string }[] = [
  { key: "kpu", label: "КПУ" },
  { key: "spou", label: "СПОУ" },
  { key: "it", label: "ІТ" },
  { key: "english", label: "Англійська" },
  { key: "vds", label: "ВДС" },
  { key: "umsp", label: "УМСП" },
  { key: "sfp", label: "СФП" },
  { key: "tidtp", label: "ТіДтП" },
];

/** Середній бал — так само, як в адмін-панелі: сума / кількість дисциплін. */
export const averageScore = (scores: Scores) =>
  SUBJECTS.reduce((sum, s) => sum + (Number(scores[s.key]) || 0), 0) / SUBJECTS.length;

export const formatAverage = (value: number) => value.toFixed(1);

/**
 * Місце студента в групі за середнім балом. Однакові бали ділять одне місце (1, 1, 3…),
 * так само, як у вкладці «Рейтинг групи». Повертає null, якщо студента немає в списку.
 */
export function groupRank(
  students: { id: string; scores: Scores }[],
  meId: string,
): { rank: number; total: number; hasScores: boolean } | null {
  const me = students.find((student) => student.id === meId);
  if (!me) return null;
  const sum = (scores: Scores) => SUBJECTS.reduce((acc, s) => acc + (Number(scores[s.key]) || 0), 0);
  const mine = sum(me.scores);
  const better = students.filter((student) => sum(student.scores) > mine).length;
  return { rank: better + 1, total: students.length, hasScores: mine > 0 };
}

/**
 * Оцінка за шкалою: 60–63 → 3-, 64–74 → 3, 75–81 → 4, 82–89 → 4+, 90–100 → 5.
 * Нижче 60 шкала не задана — повертає null.
 */
export function gradeOf(score: number | null | undefined): string | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score >= 90) return "5";
  if (score >= 82) return "4+";
  if (score >= 75) return "4";
  if (score >= 64) return "3";
  if (score >= 60) return "3-";
  return null;
}
