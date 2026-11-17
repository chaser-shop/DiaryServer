import { parseScheduleRows, type ParsedSchedule } from "../schedule";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Читає .xls / .xlsx з порталу розкладу прямо в браузері адміністратора
 * (бібліотека підвантажується лише тут, студентський бандл її не містить).
 */
export async function parseScheduleFile(file: File): Promise<ParsedSchedule> {
  if (file.size > MAX_BYTES) throw new Error("Файл завеликий (понад 5 МБ).");
  if (!/\.(xls|xlsx)$/i.test(file.name)) throw new Error("Потрібен файл Excel: .xls або .xlsx.");

  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new Error("Не вдалося прочитати файл. Перевірте, що він не пошкоджений.");
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet || !sheet["!ref"]) throw new Error("Аркуш у файлі порожній.");

  // Рахуємо з A1, навіть якщо Excel зберіг діапазон з іншого місця
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  range.s.r = 0;
  range.s.c = 0;
  sheet["!ref"] = XLSX.utils.encode_range(range);

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
  return parseScheduleRows(rows);
}
