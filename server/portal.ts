import { load, type CheerioAPI } from "cheerio";
import { CookieJar } from "tough-cookie";
import { parseScheduleRows } from "../src/schedule.js";

const portal = new URL("https://asu.navs.edu.ua/time-table/group");
const fields = [
  "#timetableform-facultyid",
  "#timetableform-course",
  "#timetableform-groupid",
];
const names = ["факультетів", "курсів", "груп"];
type PortalOption = { value: string; label: string };

export class PortalError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

// Each operation starts with its own cookies and reads the current form, including its CSRF token.
async function requestPage(
  jar: CookieJar,
  url: URL,
  body?: URLSearchParams,
  ajax = false,
) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.origin !== portal.origin || url.pathname !== portal.pathname)
      throw new PortalError(
        "Портал НАВС перенаправив запит за межі сторінки розкладу.",
      );
    const headers = new Headers({
      Accept: "text/html",
      "Cache-Control": "no-cache",
    });
    const cookie = await jar.getCookieString(url.href);
    if (cookie) headers.set("Cookie", cookie);
    if (body) {
      headers.set("Referer", portal.href);
      headers.set("Origin", portal.origin);
      if (ajax) headers.set("X-Requested-With", "XMLHttpRequest");
    }
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      body,
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    for (const value of response.headers.getSetCookie())
      await jar.setCookie(value, url.href, { ignoreError: true });
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.headers.has("location")
    ) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location")!, url);
      if ([301, 302, 303].includes(response.status)) body = undefined;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PortalError(
        `Портал НАВС відповів кодом ${response.status}. Спробуйте ще раз.`,
        [400, 403, 408, 500, 502, 503, 504].includes(response.status),
      );
    }
    const $ = load(await response.text());
    if (!$("#filter-form").length)
      throw new PortalError("У відповіді порталу немає форми розкладу.", true);
    return $;
  }
  throw new PortalError("Портал НАВС не відкрив сторінку розкладу.");
}

function options($: CheerioAPI, index: number): PortalOption[] {
  const select = $("#filter-form").find(fields[index]);
  if (!select.length)
    throw new PortalError(`Портал не повернув список ${names[index]}.`, true);
  return select
    .find("option:not([disabled])")
    .toArray()
    .map((el) => ({
      value: $(el).attr("value") ?? "",
      label: $(el).text().trim(),
    }))
    .filter((o) => o.value);
}

function timetable($: CheerioAPI) {
  const table = $("#timeTable");
  if (!table.length)
    throw new PortalError(
      "Для вибраної групи портал не повернув таблицю розкладу.",
    );
  const rows = table
    .find("tr")
    .toArray()
    .map((row) =>
      $(row)
        .children("th,td")
        .toArray()
        .map((cell) => {
          const td = $(cell);
          if (td.hasClass("headcol"))
            return (
              td.find(".lesson").text().trim() +
              " " +
              td.find(".start").text().trim() +
              "-" +
              td.find(".end").text().trim()
            );
          td.find("br").replaceWith("\n");
          const lessons = td.find('[data-toggle="popover"]');
          return lessons.length
            ? lessons
                .toArray()
                .map((el) => $(el).text().trim())
                .join("\n")
            : td.text().trim();
        }),
    );
  const cells = rows
    .filter((row) => /^\d+\s*пара/.test(row[0]))
    .flatMap((row) => row.slice(1));
  if (
    cells.length &&
    cells.every((cell) => !cell) &&
    rows.some(
      (row) =>
        /^(Пн|Вт|Ср|Чт|Пт|Сб|Нд)$/.test(row[0]) &&
        row.slice(1).some((date) => /^\d{2}\.\d{2}\.\d{4}$/.test(date)),
    )
  )
    return [];
  try {
    return parseScheduleRows(rows).lessons;
  } catch {
    throw new PortalError("Не вдалося прочитати таблицю пар вибраної групи.");
  }
}

async function readForm(values: string[]) {
  const jar = new CookieJar();
  let $ = await requestPage(jar, portal);
  const selected: PortalOption[] = [];
  for (const [i, value] of values.entries()) {
    const option = options($, i).find((o) => o.value === value);
    if (!option)
      throw new PortalError(
        `Вибір у списку ${names[i]} змінився. Виберіть його повторно.`,
      );
    selected.push(option);
    const form = $("#filter-form");
    const body = new URLSearchParams(form.serialize());
    for (const [j, selector] of fields.entries()) {
      const name = form.find(selector).attr("name");
      if (name) body.set(name, j <= i ? values[j] : "");
    }
    $ = await requestPage(
      jar,
      new URL(form.attr("action") || portal.href, portal),
      body,
      i < 2,
    );
  }
  if (values.length < 3)
    return { options: options($, values.length), selected };
  if (String($(fields[2]).val()) !== values[2])
    throw new PortalError("Портал не підтвердив вибрану групу.", true);
  return { selected, lessons: timetable($) };
}

export async function readPortal(values: string[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readForm(values);
    } catch (error) {
      if (error instanceof PortalError && !error.retryable) throw error;
      if (attempt)
        throw error instanceof PortalError
          ? error
          : new PortalError(
              "Немає відповіді від порталу НАВС. Повторіть запит.",
            );
    }
  }
}
