'use strict';
/*
 * Read-only access to the rating spreadsheet.
 *
 * Access methods, in priority order:
 *   1. GOOGLE_SHEET_CSV_URL         — any CSV URL (e.g. «Publish to web» link or a test fixture);
 *   2. GOOGLE_SERVICE_ACCOUNT_JSON  — Sheets API with a service account (for private spreadsheets);
 *   3. public link                  — `/export?format=csv&gid=…`, falling back to the gviz CSV endpoint.
 * The public method needs no credentials: it works when the spreadsheet is shared as
 * «Anyone with the link — Viewer». Google offers no push/webhook for that, so the server polls.
 */

const crypto = require('crypto');
const { readCSV } = require('../public/schedule.js');

const UA = 'Mozilla/5.0 (compatible; DiaryServer-sync/2.0)';
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20000;

function sheetSettings(env = process.env) {
  return {
    id: String(env.GOOGLE_SHEET_ID || '').trim(),
    gid: String(env.GOOGLE_SHEET_GID || '').trim(),
    csvUrl: String(env.GOOGLE_SHEET_CSV_URL || '').trim(),
    serviceAccountJson: String(env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim(),
  };
}

const sheetUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit${gid ? '#gid=' + encodeURIComponent(gid) : ''}`;

async function httpGet(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) throw new Error('Відповідь Google завелика (понад 5 МБ).');
  return { status: res.status, ok: res.ok, type: res.headers.get('content-type') || '', buf: Buffer.from(ab), url: res.url, ms: Date.now() - started };
}

const isHtml = (r) => /text\/html/i.test(r.type) || /^\s*<(!doctype html|html)/i.test(r.buf.subarray(0, 300).toString('utf8'));
const isCsv = (r) => r.ok && !isHtml(r);

function httpProblem(r, gid) {
  if (r.ok && isHtml(r)) return 'Google повернув сторінку входу замість даних: таблиця не відкрита для читання за посиланням.';
  if (r.status === 401 || r.status === 403) return 'Доступ заборонено: таблиця не відкрита для читання за посиланням.';
  if (r.status === 404) return 'Таблицю не знайдено. Перевірте GOOGLE_SHEET_ID.';
  if (r.status === 400 && gid) return `Аркуш з gid=${gid} не знайдено в таблиці.`;
  if (r.status === 429) return 'Google тимчасово обмежив кількість запитів. Спробуємо пізніше.';
  return `Google відповів помилкою HTTP ${r.status}.`;
}

function netProblem(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'Google не відповів за 20 секунд.';
  return 'Немає зв’язку з Google: ' + String((e && e.message) || e).slice(0, 160);
}

function unescapeJs(s) {
  try { return JSON.parse('"' + s.replace(/\\x([0-9a-f]{2})/gi, '\\u00$1') + '"'); } catch { return s; }
}

/** Title and worksheets of a link-shared spreadsheet, read from its public HTML view. */
async function fetchMeta(id) {
  const r = await httpGet(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`);
  if (!r.ok || !/text\/html/i.test(r.type)) throw new Error(httpProblem(r));
  const html = r.buf.toString('utf8');
  if (/accounts\.google\.com\/(ServiceLogin|v3\/signin)/.test(r.url)) throw new Error(httpProblem({ ok: true, type: 'text/html', buf: Buffer.from('<html>') }));
  let title = ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
  title = title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+-\s+Google (Drive|Sheets|Таблиці|Диск)$/i, '').trim();
  const sheets = [];
  const re = /\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"(?:[^"\\]|\\.)*?gid(?:=|\\x3d)(\d+)/g;
  let m;
  while ((m = re.exec(html))) if (!sheets.some((s) => s.gid === m[2])) sheets.push({ name: unescapeJs(m[1]), gid: m[2] });
  return { title, sheets, ms: r.ms };
}

const metaCache = new Map();
async function getMeta(id, { maxAgeMs = 3600000 } = {}) {
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = await fetchMeta(id);
  metaCache.set(id, { at: Date.now(), value });
  return value;
}

// ───────────── service account (optional, for private spreadsheets) ─────────────

let tokenCache = { token: '', expiresAt: 0, key: '' };
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function serviceAccountToken(json) {
  let credentials;
  try { credentials = JSON.parse(json); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON має містити коректний JSON ключа сервісного акаунта.'); }
  if (!credentials.client_email || !credentials.private_key) throw new Error('У ключі сервісного акаунта немає client_email або private_key.');
  if (tokenCache.token && tokenCache.key === credentials.client_email && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: tokenUri, iat: now, exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google OAuth: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  tokenCache = { token: body.access_token, key: credentials.client_email, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

async function readViaServiceAccount(cfg) {
  const token = await serviceAccountToken(cfg.serviceAccountJson);
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.id)}`;
  const metaRes = await fetch(`${base}?fields=${encodeURIComponent('properties.title,sheets.properties(sheetId,title)')}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) throw new Error(`Не вдалося прочитати Google-таблицю: ${(meta.error && meta.error.message) || `HTTP ${metaRes.status}`}`);
  const list = (meta.sheets || []).map((x) => x.properties || {});
  const sheet = cfg.gid ? list.find((x) => String(x.sheetId) === cfg.gid) : list[0];
  if (!sheet) throw new Error(`У таблиці немає аркуша з gid=${cfg.gid}.`);
  const range = `'${String(sheet.title).replace(/'/g, "''")}'!A:Z`;
  const valRes = await fetch(`${base}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = await valRes.json().catch(() => ({}));
  if (!valRes.ok) throw new Error(`Не вдалося завантажити значення аркуша: ${(data.error && data.error.message) || `HTTP ${valRes.status}`}`);
  const grid = data.values || [];
  return {
    grid, method: 'service_account', gid: String(sheet.sheetId), sheetTitle: sheet.title,
    title: (meta.properties && meta.properties.title) || '', raw: JSON.stringify(grid), warnings: [],
  };
}

// ───────────── public link ─────────────

async function readPublic(cfg) {
  const warnings = [];
  let meta = null;
  const metaOrNull = async () => {
    if (meta) return meta;
    try { meta = await getMeta(cfg.id); } catch { meta = null; }
    return meta;
  };
  let gid = cfg.gid;
  if (!gid) {
    const m = await metaOrNull();
    if (m && m.sheets.length) gid = m.sheets[0].gid;
  }
  const exportUrl = (g) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.id)}/export?format=csv${g ? '&gid=' + encodeURIComponent(g) : ''}`;
  const problems = [];
  const attempt = async (url, method, g) => {
    try {
      const r = await httpGet(url);
      if (isCsv(r)) return { r, method, gid: g };
      problems.push(httpProblem(r, g));
      return { failed: r };
    } catch (e) {
      problems.push(netProblem(e));
      return { failed: null };
    }
  };

  let got = await attempt(exportUrl(gid), 'csv_export', gid);
  if (!got.r && got.failed && got.failed.status === 400 && gid) {
    // Configured gid does not exist (e.g. the default «0»): use the first worksheet instead.
    const m = await metaOrNull();
    const first = m && m.sheets[0];
    if (first && first.gid !== gid) {
      warnings.push(`Аркуш з gid=${gid} не існує; використано перший аркуш «${first.name}» (gid=${first.gid}). Вкажіть GOOGLE_SHEET_GID=${first.gid}.`);
      gid = first.gid;
      got = await attempt(exportUrl(gid), 'csv_export', gid);
    }
  }
  if (!got.r) {
    const gviz = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.id)}/gviz/tq?tqx=out:csv${gid ? '&gid=' + encodeURIComponent(gid) : ''}`;
    got = await attempt(gviz, 'gviz_csv', gid);
  }
  if (!got.r) throw new Error([...new Set(problems)].join(' '));
  const m = meta || (await metaOrNull());
  const sheet = m && m.sheets.find((s) => s.gid === got.gid);
  const text = got.r.buf.toString('utf8');
  return {
    grid: readCSV(got.r.buf), method: got.method, gid: got.gid || '', sheetTitle: sheet ? sheet.name : '', title: m ? m.title : '',
    raw: text, warnings,
  };
}

async function readCsvUrl(cfg) {
  let r;
  try { r = await httpGet(cfg.csvUrl); } catch (e) { throw new Error(netProblem(e)); }
  if (!isCsv(r)) throw new Error(httpProblem(r));
  return { grid: readCSV(r.buf), method: 'csv_url', gid: cfg.gid, sheetTitle: '', title: '', raw: r.buf.toString('utf8'), warnings: [] };
}

/** Reads the configured worksheet → { grid, method, gid, sheetTitle, title, raw, warnings }. Throws Error with a Ukrainian message. */
async function readSheet(cfg) {
  if (cfg.csvUrl) return readCsvUrl(cfg);
  if (!cfg.id) throw new Error('Не задано GOOGLE_SHEET_ID — синхронізацію вимкнено.');
  if (cfg.serviceAccountJson) return readViaServiceAccount(cfg);
  return readPublic(cfg);
}

const METHOD_TITLES = {
  csv_export: 'Публічне посилання (CSV-експорт)',
  gviz_csv: 'Публічне посилання (Google Visualization)',
  service_account: 'Сервісний акаунт Google (Sheets API)',
  csv_url: 'Пряме CSV-посилання',
};

/** Live connection checks for the administrator (never returns secrets). */
async function diagnose(cfg) {
  const checks = [];
  const run = async (key, label, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({ key, label, ok: true, ms: Date.now() - started, detail });
    } catch (e) {
      checks.push({ key, label, ok: false, ms: Date.now() - started, detail: String((e && e.message) || e).slice(0, 300) });
    }
  };
  let meta = null;
  if (cfg.csvUrl) {
    await run('csv_url', 'Пряме CSV-посилання (GOOGLE_SHEET_CSV_URL)', async () => {
      const r = await readCsvUrl(cfg);
      return `Отримано рядків: ${r.grid.length}`;
    });
  }
  if (cfg.id) {
    await run('meta', 'Сторінка таблиці за посиланням', async () => {
      meta = await fetchMeta(cfg.id);
      metaCache.set(cfg.id, { at: Date.now(), value: meta });
      return `Назва: «${meta.title || 'без назви'}», аркушів: ${meta.sheets.length}${meta.sheets.length ? ` (${meta.sheets.map((s) => `${s.name} — gid ${s.gid}`).join('; ')})` : ''}`;
    });
    const gid = cfg.gid || (meta && meta.sheets[0] ? meta.sheets[0].gid : '');
    await run('csv_export', 'CSV-експорт без ключів', async () => {
      const r = await httpGet(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.id)}/export?format=csv${gid ? '&gid=' + gid : ''}`);
      if (!isCsv(r)) throw new Error(httpProblem(r, gid));
      return `HTTP ${r.status}, рядків: ${readCSV(r.buf).length}, gid: ${gid || 'перший аркуш'}`;
    });
    await run('gviz_csv', 'Google Visualization CSV (запасний спосіб)', async () => {
      const r = await httpGet(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.id)}/gviz/tq?tqx=out:csv${gid ? '&gid=' + gid : ''}`);
      if (!isCsv(r)) throw new Error(httpProblem(r, gid));
      return `HTTP ${r.status}, рядків: ${readCSV(r.buf).length}`;
    });
    if (cfg.serviceAccountJson) {
      await run('service_account', 'Сервісний акаунт (Sheets API)', async () => {
        const r = await readViaServiceAccount(cfg);
        return `Аркуш «${r.sheetTitle}», рядків: ${r.grid.length}`;
      });
    } else {
      checks.push({ key: 'service_account', label: 'Сервісний акаунт (Sheets API)', ok: null, ms: 0, detail: 'Не налаштовано — для таблиці, відкритої за посиланням, не потрібен.' });
    }
  }
  const okKey = cfg.csvUrl ? (checks.find((c) => c.key === 'csv_url' && c.ok) && 'csv_url')
    : cfg.serviceAccountJson && checks.find((c) => c.key === 'service_account' && c.ok) ? 'service_account'
      : checks.find((c) => c.key === 'csv_export' && c.ok) ? 'csv_export'
        : checks.find((c) => c.key === 'gviz_csv' && c.ok) ? 'gviz_csv' : '';
  return {
    checkedAt: new Date(), configured: !!(cfg.id || cfg.csvUrl), accessible: !!okKey, method: okKey || null,
    methodTitle: okKey ? METHOD_TITLES[okKey] : null, title: meta ? meta.title : '', sheets: meta ? meta.sheets : [],
    url: cfg.id ? sheetUrl(cfg.id, cfg.gid) : '', checks,
  };
}

module.exports = { sheetSettings, readSheet, diagnose, getMeta, sheetUrl, METHOD_TITLES };
