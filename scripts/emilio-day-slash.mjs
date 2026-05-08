#!/usr/bin/env node
// emilio-day-slash.mjs — host-side single-day timeline for /emilio-day.
// Reads Feedings, Diaper Changes, Sleep Log and outputs a chronological
// event table for one day (Chicago time). Defaults to today; accepts an
// optional --date=YYYY-MM-DD or --date=yesterday.
//
// Usage:
//   node scripts/emilio-day-slash.mjs                  # today
//   node scripts/emilio-day-slash.mjs --date=2026-05-02
//   node scripts/emilio-day-slash.mjs --date=yesterday
//
// Emits one JSON line: { ok, table } or { ok:false, error }

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

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// --- Date helpers (mirrored from emilio-week-slash.mjs) ---

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

// --- Parse args ---

const today = chicagoDateStr();
let targetDate = today;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--date=')) {
    const v = arg.slice('--date='.length);
    if (v === 'today') targetDate = today;
    else if (v === 'yesterday') targetDate = addDays(today, -1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) targetDate = v;
    else {
      emit({ ok: false, error: `Bad --date "${v}". Use YYYY-MM-DD, "today", or "yesterday".` });
      process.exit(0);
    }
  }
}

// --- Sheet fetch ---

let access_token;
try {
  access_token = await getAccessToken();
} catch (err) {
  emit({ ok: false, error: `Auth failed: ${err.message}` });
  process.exit(0);
}

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

let feedRows, diaperRows, sleepRows;
try {
  [feedRows, diaperRows, sleepRows] = await batchGet([
    'Feedings!A1:G2000',
    'Diaper Changes!A1:D2000',
    'Sleep Log!A1:E2000',
  ]);
} catch (err) {
  emit({ ok: false, error: `Sheet read failed: ${err.message}` });
  process.exit(0);
}

const feeds = rowsToObjs(feedRows);
const diapers = rowsToObjs(diaperRows);
const sleeps = rowsToObjs(sleepRows);

function parseTime(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, , , , h, mi] = m.map(Number);
  const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
  const ts = chicagoMidnightTs(dateStr) + (h * 60 + mi) * 60_000;
  return { ts, date: dateStr };
}

// --- Build event list for the target day ---

const midnight = chicagoMidnightTs(targetDate);
const nextMidnight = chicagoMidnightTs(addDays(targetDate, 1));

const events = [];

for (const r of feeds) {
  const t = parseTime(r['Feed time']);
  if (!t || t.ts < midnight || t.ts >= nextMidnight) continue;
  const oz = parseFloat(r['Amount (oz)'] || '0') || 0;
  events.push({
    ts: t.ts,
    feed: oz > 0 ? `${oz % 1 === 0 ? oz.toFixed(0) : oz.toFixed(1)}` : '',
    poop: '',
    sleep: '',
  });
}

for (const r of diapers) {
  const t = parseTime(r['Feed time']);
  if (!t || t.ts < midnight || t.ts >= nextMidnight) continue;
  const status = (r['Diaper Status'] || '').toLowerCase();
  let label = '';
  if (status.includes('both')) label = 'both';
  else if (status.includes('poop')) label = 'poop';
  else if (status.includes('wet')) label = 'wet';
  else if (status) label = status;
  events.push({ ts: t.ts, feed: '', poop: label, sleep: '' });
}

for (const r of sleeps) {
  const t = parseTime(r['Start time'] || r['Start'] || r['Feed time']);
  if (!t || t.ts < midnight || t.ts >= nextMidnight) continue;
  const dur = parseFloat(r['Duration (minutes)'] || r['Duration'] || '0');
  events.push({
    ts: t.ts,
    feed: '',
    poop: '',
    sleep: dur > 0 ? `${Math.round(dur)}m` : 'open',
  });
}

events.sort((a, b) => a.ts - b.ts);

// Merge events at the same timestamp (e.g. a feed logged at the same
// minute as a nap-open) into one row — picks the non-empty value from
// each side. Keeps rows compact and matches how parents log multi-event
// messages (e.g. "2oz and asleep now").
const mergedEvents = [];
for (const e of events) {
  const last = mergedEvents[mergedEvents.length - 1];
  if (last && last.ts === e.ts) {
    last.feed ||= e.feed;
    last.poop ||= e.poop;
    last.sleep ||= e.sleep;
  } else {
    mergedEvents.push({ ...e });
  }
}

// --- Format ---

function fmtTime(ts) {
  // 24-hour HH:MM keeps rows narrow enough for Discord's mobile code-block
  // width (~30 chars). AM/PM is implicit from chronological ordering — the
  // table starts at midnight and stops before next midnight.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const h = parts.find((p) => p.type === 'hour')?.value || '00';
  const m = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

function dayLabel(dateStr) {
  const [y, mo, d] = dateStr.split('-');
  return `${mo}/${d}/${y}`;
}

function pad(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

// Totals for footer
const totalOz = events.reduce((s, e) => {
  const m = e.feed.match(/^([\d.]+)$/);
  return s + (m ? parseFloat(m[1]) : 0);
}, 0);
// Total sleep: sum the overlap of every nap's [start, start+duration)
// interval with this day's [midnight, nextMidnight) window — so naps
// that span midnight contribute the right minute-count to each day,
// not 100% to the start day. Naps that started before midnight but
// extended into today are intentionally NOT shown as timeline rows
// (the timeline filters by start time); the total reflects them
// regardless.
let totalSleep = 0;
for (const r of sleeps) {
  const start = parseTime(r['Start time'] || r['Start'] || r['Feed time']);
  if (!start) continue;
  const dur = parseFloat(r['Duration (minutes)'] || r['Duration'] || '0');
  if (dur <= 0) continue;
  const napStart = start.ts;
  const napEnd = napStart + dur * 60_000;
  const overlapStart = Math.max(napStart, midnight);
  const overlapEnd = Math.min(napEnd, nextMidnight);
  if (overlapEnd > overlapStart) {
    totalSleep += (overlapEnd - overlapStart) / 60_000;
  }
}
totalSleep = Math.round(totalSleep);
const feedCount = events.filter((e) => e.feed).length;
const poopCount = events.filter((e) => e.poop && e.poop !== 'wet').length;
const sleepHours = Math.floor(totalSleep / 60);
const sleepMins = totalSleep % 60;

// Column widths — match /emilio-week's accepted format style: keep the
// box-drawing chrome so the table reads as a table, but stay at 31 chars
// total so it fits Discord's mobile code-block width. Emoji-only poop
// column matches week's `💩` cell (2 chars, no padding).
//   `| ttttt | feeeeeee | sssss | PP |`
//    1+1+ 5 +1+1+ 8 +1+1+ 4 +1+1+ 2 +1 = 28? let me recount properly.
//   chrome breakdown: 5 vertical bars + 4 spaces left + 4 spaces right = 13
//   content: 5 + 8 + 4 + 2 = 19  → total 32 (within mobile cap).
const COL = { time: 5, feed: 3, sleep: 4, poop: 2 };
const divider = `+${'─'.repeat(COL.time + 2)}+${'─'.repeat(COL.feed + 2)}+${'─'.repeat(COL.sleep + 2)}+${'─'.repeat(COL.poop + 2)}+`;
const header = `| ${pad('Time', COL.time)} | ${pad('🍼', COL.feed)} | ${pad('😴', COL.sleep)} | 💩 |`;

// Map textual poop label → 2-char emoji cell. Empty rows get spaces so
// the column stays aligned with the header.
function poopGlyph(label) {
  if (label === 'wet') return '💧';
  if (label === 'poop') return '💩';
  if (label === 'both') return '⚠️';
  return '  ';
}

const tableRows = mergedEvents.length === 0
  ? [`| ${pad('— no events —', COL.time + COL.feed + COL.sleep + COL.poop + 9)} |`]
  : mergedEvents.map((e) =>
      `| ${pad(fmtTime(e.ts), COL.time)} | ${pad(e.feed, COL.feed)} | ${pad(e.sleep, COL.sleep)} | ${poopGlyph(e.poop)} |`,
    );

const summary = events.length === 0
  ? ''
  : `\n${feedCount} feeds (${totalOz % 1 === 0 ? totalOz.toFixed(0) : totalOz.toFixed(1)}oz) · ${poopCount} poop · ${sleepHours}h ${sleepMins}m sleep`;

const heading = targetDate === today ? 'today' : targetDate === addDays(today, -1) ? 'yesterday' : dayLabel(targetDate);

const table =
  `\`\`\`\n` +
  `Emilio — ${heading}\n\n` +
  `${divider}\n${header}\n${divider}\n` +
  tableRows.join('\n') + '\n' +
  `${divider}\n` +
  `\`\`\`` +
  summary;

emit({ ok: true, table });
