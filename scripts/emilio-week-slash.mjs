#!/usr/bin/env node
// emilio-week-slash.mjs — host-side weekly summary for /emilio-week.
// Reads Feedings, Diaper Changes, Sleep Log and outputs a per-day table
// covering the last 7 days (Chicago time).
//
// Usage: node scripts/emilio-week-slash.mjs
// Emits one JSON line: { ok, table }

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const { getAccessToken } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
);

const TZ = 'America/Chicago';
const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';
const DAYS = 7;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// --- Date helpers ---

function chicagoDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function chicagoOffsetHours(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(ts));
  const off = parts.find((x) => x.type === 'timeZoneName')?.value || 'GMT-5';
  const m = off.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1]) : -5;
}

function chicagoMidnightTs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naiveUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = chicagoOffsetHours(naiveUTC);
  return naiveUTC - offset * 3_600_000;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Build list of dates: oldest first
const today = chicagoDateStr();
const dates = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));

// --- Sheet fetch ---

const access_token = await getAccessToken();

async function batchGet(ranges) {
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${qs}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return (j.valueRanges || []).map((vr) => vr.values || []);
}

function rowsToObjs(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h, r[i] || ''])),
  );
}

const [feedRows, diaperRows, sleepRows] = await batchGet([
  'Feedings!A1:G2000',
  'Diaper Changes!A1:D2000',
  'Sleep Log!A1:E2000',
]);

const feeds = rowsToObjs(feedRows);
const diapers = rowsToObjs(diaperRows);
const sleeps = rowsToObjs(sleepRows);

// --- Parse sheet timestamps ---

function parseTime(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const ts = chicagoMidnightTs(`${m[1]}-${m[2]}-${m[3]}`) + (h * 60 + mi) * 60_000;
  return { ts, date: `${m[1]}-${m[2]}-${m[3]}` };
}

// --- Per-day aggregation ---

function hhmm(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dayLabel(dateStr) {
  const [, mo, d] = dateStr.split('-');
  return `${mo}/${d}`;
}

const rows = dates.map((date) => {
  const midnight = chicagoMidnightTs(date);
  const nextMidnight = chicagoMidnightTs(addDays(date, 1));

  // Feeds for this day
  const dayFeeds = feeds
    .map((r) => ({ r, t: parseTime(r['Feed time']) }))
    .filter((x) => x.t && x.t.ts >= midnight && x.t.ts < nextMidnight);
  const totalOz = dayFeeds.reduce((s, x) => s + (parseFloat(x.r['Amount (oz)'] || '0') || 0), 0);

  // Poop: any diaper marked Poopy this day
  const hadPoop = diapers.some((r) => {
    const t = parseTime(r['Feed time']);
    return t && t.ts >= midnight && t.ts < nextMidnight &&
      (r['Diaper Status'] || '').toLowerCase().includes('poop');
  });

  // Sleep: sum durations of naps that started in this day window
  let sleepMin = 0;
  for (const r of sleeps) {
    const start = parseTime(r['Start time'] || r['Start'] || r['Feed time']);
    if (!start || start.ts < midnight || start.ts >= nextMidnight) continue;
    const dur = parseFloat(r['Duration (minutes)'] || r['Duration'] || '0');
    if (dur > 0) sleepMin += dur;
  }

  const ozStr = dayFeeds.length > 0
    ? `${Math.round(totalOz)}oz/${dayFeeds.length}`
    : '—';

  return {
    day: dayLabel(date),
    isToday: date === today,
    feeds: ozStr,
    sleep: sleepMin > 0 ? hhmm(sleepMin) : '—',
    poop: hadPoop ? '💩' : '  ',
  };
});

// --- ASCII table inside a code block ---

function pad(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

const COL = { day: 5, feeds: 7, sleep: 5 };
const divider = `+${'─'.repeat(COL.day + 2)}+${'─'.repeat(COL.feeds + 2)}+${'─'.repeat(COL.sleep + 2)}+${'─'.repeat(4)}+`;
const header  = `| ${pad('Date', COL.day)} | ${pad('Feeds', COL.feeds)} | ${pad('Sleep', COL.sleep)} | 💩 |`;

const tableRows = rows.map((r) =>
  `| ${pad(r.day, COL.day)} | ${pad(r.feeds, COL.feeds)} | ${pad(r.sleep, COL.sleep)} | ${r.poop} |`,
);

const table =
  `\`\`\`\n` +
  `Emilio — Last ${DAYS} Days\n\n` +
  `${divider}\n${header}\n${divider}\n` +
  tableRows.join('\n') + '\n' +
  `${divider}\n` +
  `\`\`\``;

emit({ ok: true, table });
