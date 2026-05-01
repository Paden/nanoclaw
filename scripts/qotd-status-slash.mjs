#!/usr/bin/env node
// qotd-status-slash.mjs — host-side read-only status for /qotd-status.
//
// Reports which panda questions the invoking user still owes answers for,
// with the calendar date each question was posted on. Same OAuth routing as
// qotd-slash.mjs.
//
// Usage:
//   node scripts/qotd-status-slash.mjs <user_id>
//
// Emits one JSON line on stdout:
//   {
//     ok, status,             // 'status' | 'error'
//     currentQNum,            // the most recent question the game has posted
//     today,                  // YYYY-MM-DD America/Chicago
//     open: [ { qNum, day, date, question } ],   // ascending by qNum
//     totalAnswered,          // for flavor text
//   }
//
// Day/date mapping: day 1 is back-calculated from state.current_day assuming
// a continuous daily cadence. If the game was paused for a day this will
// drift — the qNum is still authoritative.

import fs from 'fs';
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

const { readRange, getAccessToken } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
);

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const STATE_PATH = path.join(ROOT, 'groups', 'discord_parents', 'panda_game_state.json');
const QUESTIONS_PATH = path.join(ROOT, 'groups', 'discord_parents', 'panda_questions.json');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function todayChicago() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function questionText(questions, qNum) {
  const entry = questions.find((q) => Number(q.n) === Number(qNum));
  return entry?.text || `Question ${qNum}`;
}

// Given today's YYYY-MM-DD (CT) and current_day, return the date a given day
// number maps to, assuming continuous daily cadence. Returns YYYY-MM-DD.
function dateForDay(today, currentDay, day) {
  const [y, m, d] = today.split('-').map(Number);
  // Use UTC arithmetic to avoid host-tz DST weirdness, then format as ISO date.
  const base = Date.UTC(y, m - 1, d);
  const offsetDays = day - currentDay;
  const then = new Date(base + offsetDays * 24 * 60 * 60 * 1000);
  const yy = then.getUTCFullYear();
  const mm = String(then.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(then.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function main() {
  const [, , userId] = process.argv;
  if (!userId) {
    process.stderr.write('usage: qotd-status-slash.mjs <user_id>\n');
    process.exit(2);
  }

  const state = loadState();
  if (!state || typeof state.current_question_number !== 'number') {
    emit({ ok: false, status: 'error', message: 'panda_game_state.json missing or unreadable' });
    return;
  }
  const currentQNum = state.current_question_number;
  const currentDay = typeof state.current_day === 'number' ? state.current_day : currentQNum;
  const skipped = new Set(Array.isArray(state.skipped_days) ? state.skipped_days : []);
  const today = todayChicago();
  const questions = loadQuestions();

  let rows;
  try {
    const token = await getAccessToken();
    rows = await readRange(PORTILLO_GAMES_SHEET, 'Panda Submissions!A:F', { token });
  } catch (err) {
    emit({ ok: false, status: 'error', message: err.message });
    return;
  }
  const data = (rows || []).slice(1);
  // Column layout: [ts, date, user_id, name, qNum, answer]
  const answered = new Set(
    data
      .filter((r) => r[2] === userId)
      .map((r) => parseInt(r[4], 10))
      .filter((n) => Number.isFinite(n)),
  );

  const open = [];
  const skippedOpen = [];
  for (let q = 1; q <= currentQNum; q++) {
    if (answered.has(q)) continue;
    const entry = {
      qNum: q,
      day: q, // day number = question number in 36_questions phase; still monotonic in daily_pulse
      date: dateForDay(today, currentDay, q),
      question: questionText(questions, q),
    };
    if (skipped.has(q)) {
      skippedOpen.push(entry);
    } else {
      open.push(entry);
    }
  }

  emit({
    ok: true,
    status: 'status',
    currentQNum,
    currentDay,
    skippedOpen,
    today,
    open,
    totalAnswered: answered.size,
  });
}

main().catch((err) => {
  emit({ ok: false, status: 'error', message: err.message, stack: err.stack });
  process.exit(1);
});
