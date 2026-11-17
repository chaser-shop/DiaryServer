import type {
  AcademyGroup,
  ActivityRow,
  GradeRow,
  LessonRow,
  StudentRow,
} from "./AcademyDashboard";
import type { Lesson, SubjectLink } from "../schedule";

export type CreatedStudent = {
  id: string;
  gradeId: string;
  fullName: string;
  login: string;
  password: string;
  groupId: string;
  groupName: string;
};

export type Bootstrap = {
  groups: AcademyGroup[];
  students: StudentRow[];
  grades: GradeRow[];
  lessons: LessonRow[];
  activity: ActivityRow[];
};

export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function call<T>(action: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/${action}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? "Помилка сервера. Спробуйте ще раз." };
    return { ok: true, ...json } as ApiResult<T>;
  } catch {
    return { ok: false, error: "Немає зʼєднання з сервером." };
  }
}

export const loadBootstrap = () => call<Bootstrap>("admin-bootstrap");

export const createGroup = (input: Omit<AcademyGroup, "id">) =>
  call<{ group: AcademyGroup }>("admin-group-create", input);

export const createStudent = (input: { fullName: string; groupId: string }) =>
  call<{ student: CreatedStudent }>("admin-student-create", input);

export const resetStudentPassword = (studentId: string) =>
  call<{ password: string }>("admin-student-reset", { studentId });

export const updateGrade = (gradeId: string, key: string, value: number) =>
  call<{ value: number }>("admin-grade-update", { gradeId, key, value });

export const updateGroup = (
  groupId: string,
  patch: { sessionStart?: string | null; subjectLinks?: SubjectLink[] },
) => call<{ group: AcademyGroup }>("admin-group-update", { groupId, ...patch });

export const saveGroupSchedule = (input: {
  groupId: string;
  fileName: string;
  groupLabel: string;
  period: string;
  lessons: Lesson[];
}) => call<{ group: AcademyGroup }>("admin-group-schedule", input);
