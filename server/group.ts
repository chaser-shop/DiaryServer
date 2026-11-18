import type { Lesson } from "../src/schedule.js";

export const subjectLinksOf = (g: any): { key: string; url: string }[] =>
  Array.isArray(g?.subjectLinks)
    ? g.subjectLinks.map((l: any) => ({
        key: String(l.key),
        url: String(l.url),
      }))
    : [];

export const scheduleOf = (g: any) =>
  g?.schedule && Array.isArray(g.schedule.lessons)
    ? {
        fileName: String(g.schedule.fileName ?? ""),
        uploadedAt: new Date(g.schedule.uploadedAt ?? Date.now()).toISOString(),
        groupLabel: g.schedule.groupLabel
          ? String(g.schedule.groupLabel)
          : undefined,
        period: g.schedule.period ? String(g.schedule.period) : undefined,
        lessons: g.schedule.lessons as Lesson[],
      }
    : null;

export const groupDto = (g: any) => ({
  id: String(g._id),
  name: g.name,
  faculty: g.faculty,
  course: g.course,
  academicYear: g.academicYear,
  curator: g.curator,
  status: g.status,
  sessionStart: typeof g.sessionStart === "string" ? g.sessionStart : null,
  subjectLinks: subjectLinksOf(g),
  schedule: scheduleOf(g),
  portal: g.portal
    ? {
        values: g.portal.values,
        labels: g.portal.labels,
        checkedAt: g.portal.checkedAt,
        error: g.portal.error,
      }
    : null,
});
