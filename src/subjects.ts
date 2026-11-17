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
