import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Page } from "playwright-core";
import { parseScheduleRows } from "../src/schedule.js";

const origin = "https://asu.navs.edu.ua";
const selects = [
  "#timetableform-facultyid",
  "#timetableform-course",
  "#timetableform-groupid",
];
export type PortalOption = { value: string; label: string };

async function options(page: Page, selector: string): Promise<PortalOption[]> {
  return page.locator(selector + " option").evaluateAll((elements) =>
    elements
      .map((el) => el as HTMLOptionElement)
      .filter((o) => o.value && !o.disabled)
      .map((o) => ({ value: o.value, label: o.text.trim() })),
  );
}

export async function navigatePortal(page: Page, values: string[]) {
  page.setDefaultTimeout(20000);
  await page.route("**/*", (route) => {
    const req = route.request();
    if (
      new URL(req.url()).origin !== origin ||
      ["image", "media", "font"].includes(req.resourceType())
    )
      return route.abort();
    return route.fallback();
  });
  await page.goto(origin + "/time-table/group", {
    waitUntil: "load",
    timeout: 40000,
  });
  const selected: PortalOption[] = [];
  for (let i = 0; i < values.length; i++) {
    const option = (await options(page, selects[i])).find(
      (o) => o.value === values[i],
    );
    if (!option)
      throw new Error(
        "Вибір більше недоступний на порталі НАВС. Оновіть список.",
      );
    selected.push(option);
    const select = page.locator(selects[i]);
    if (i < 2) {
      const old = await page.locator(selects[i + 1]).elementHandle();
      await select.selectOption(option.value, { force: true });
      // The portal replaces the entire form on each change, including an empty dependent select.
      await page.waitForFunction((el) => !el?.isConnected, old);
      await old?.dispose();
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        select.selectOption(option.value, { force: true }),
      ]);
    }
  }
  if (values.length < 3)
    return { options: await options(page, selects[values.length]), selected };
  if ((await page.locator(selects[2]).inputValue()) !== values[2])
    throw new Error("Портал не підтвердив вибрану групу.");
  const table = page.locator("#timeTable");
  await table.waitFor({ state: "visible" });
  const rows = await table.evaluate((el) =>
    Array.from((el as HTMLTableElement).rows, (row) =>
      Array.from(row.cells, (cell, index) => {
        if (index === 0 && cell.classList.contains("headcol")) {
          const part = (selector: string) =>
            cell.querySelector(selector)?.textContent?.trim() ?? "";
          return part(".lesson") + " " + part(".start") + "-" + part(".end");
        }
        return cell.innerText.trim();
      }),
    ),
  );
  const cells = rows
    .filter((row) => /^\d+\s*пара/.test(row[0]))
    .flatMap((row) => row.slice(1));
  const checkedEmpty =
    cells.length > 0 &&
    cells.every((cell) => !cell.trim()) &&
    rows.some(
      (row) =>
        /^(Пн|Вт|Ср|Чт|Пт|Сб|Нд)$/.test(row[0]) &&
        row.slice(1).some((date) => /^\d{2}\.\d{2}\.\d{4}$/.test(date)),
    );
  const lessons = checkedEmpty ? [] : parseScheduleRows(rows).lessons;
  return { selected, lessons };
}

export async function readPortal(values: string[]) {
  const browser = await playwright.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: true,
  });
  try {
    return await navigatePortal(
      await browser.newPage({ locale: "uk-UA" }),
      values,
    );
  } finally {
    await browser.close();
  }
}
