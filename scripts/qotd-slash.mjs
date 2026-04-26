#!/usr/bin/env node
// qotd-slash.mjs — host-side panda-question intake for the /qotd Discord slash command.
//
// Two modes:
//   1. Default: reads state + submissions, figures out which Qs are open for
//      the user. 0 → caught_up. 1 → append. 2+ → needs_choice (return candidates).
//   2. Explicit q:<N>: skip discovery and append to that Q directly (used after
//      the user picks from the select menu).
//
// Usage:
//   node scripts/qotd-slash.mjs <player> <user_id> <answer>           # discovery
//   node scripts/qotd-slash.mjs <player> <user_id> <answer> <qNum>    # forced Q
//
// Emits one JSON line on stdout.

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

const { readRange, appendRows, getAccessToken } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
);

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const PARENTS_GROUP = 'discord_parents';
const PARENTS_DIR = path.join(ROOT, 'groups', PARENTS_GROUP);
const STATE_PATH = path.join(PARENTS_DIR, 'panda_game_state.json');
const QUESTIONS_PATH = path.join(PARENTS_DIR, 'panda_questions.json');
const PROCESSED_PATH = path.join(PARENTS_DIR, 'panda_processed.json');
const FINGERPRINT_PATH = path.join(PARENTS_DIR, 'panda_last_partial.json');
// The pinned panda_heart card lives in #panda regardless of where /qotd was
// invoked. Today /qotd is panda-only so this matches interaction.channelId in
// practice, but pin to the constant so future DM-invoked answers still update
// the public card.
const PANDA_CHANNEL_JID = 'dc:1490784303662239894';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function nowChicagoIso() {
  return new Date()
    .toLocaleString('sv-SE', { timeZone: 'America/Chicago' })
    .replace(' ', 'T');
}

function todayChicago() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
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

async function appendSubmission({ token, userId, player, qNum, answer }) {
  const ts = nowChicagoIso();
  const today = todayChicago();
  await appendRows(
    PORTILLO_GAMES_SHEET,
    'Panda Submissions!A:F',
    [[ts, today, userId, player, String(qNum), answer]],
    { token },
  );
}

function loadProcessed() {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
  } catch {
    return { processed_days: [], card_acked: [] };
  }
}

// runPandaHook — after a /qotd answer is recorded, gate-check the sheet state and:
//   - if only one partner has answered (or partial state changed) →
//     drop a templated panda_heart edit_message IPC
//   - if both have answered and the current Q hasn't been processed yet →
//     drop a schedule_task IPC for the agent to author the full reveal
//   - if no change → noop
//
// Returns a structured result for tests / logging. Never throws — wraps every
// failure in an { ok: false, reason } object so the caller's primary
// /qotd reply isn't affected.
export async function runPandaHook({
  token,
  // Injectable deps for tests:
  pollFn,
  cardBuilder,
  writeIpcMessageFn,
  writeIpcTaskFn,
  stateLoader,
  processedLoader,
  questionsLoader,
  gameStatePath = STATE_PATH,
  processedPath = PROCESSED_PATH,
  fingerprintPath = FINGERPRINT_PATH,
  sheetId = PORTILLO_GAMES_SHEET,
  channelJid = PANDA_CHANNEL_JID,
  groupFolder = PARENTS_GROUP,
} = {}) {
  // Resolve injectable deps — pull from sibling group scripts on first call.
  if (!pollFn || !cardBuilder) {
    const pollMod = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'panda_poll.mjs')
    );
    const cardMod = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'panda_card.mjs')
    );
    pollFn = pollFn || pollMod.pollPandaState;
    cardBuilder = cardBuilder || cardMod.buildPandaPartialCard;
    if (!writeIpcMessageFn || !writeIpcTaskFn) {
      // Compiled-only path: tsc emits to dist/. The slash command runs as a
      // subprocess after `npm run build`, so this matches deployed shape.
      const ipcMod = await import(path.join(ROOT, 'dist', 'ipc-writer.js'));
      writeIpcMessageFn = writeIpcMessageFn || ipcMod.writeIpcMessage;
      writeIpcTaskFn = writeIpcTaskFn || ipcMod.writeIpcTask;
    }
  }

  const loadStateFn = stateLoader || loadState;
  const loadProcFn = processedLoader || loadProcessed;
  void questionsLoader; // reserved for future use

  let poll;
  try {
    poll = await pollFn({
      readRangeFn: readRange,
      token,
      sheetId,
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
  } catch (err) {
    return { ok: false, reason: 'poll_threw', error: String(err.message || err) };
  }
  if (!poll || !poll.wakeAgent) {
    return { ok: true, action: 'noop', reason: poll?.reason };
  }

  const { type } = poll.data;

  if (type === 'full_reveal') {
    // Both partners have answered — fire the agent to author the reveal.
    const { PANDA_REVEAL_PROMPT } = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'panda_poll.mjs')
    );
    try {
      await writeIpcTaskFn(groupFolder, {
        type: 'schedule_task',
        prompt: PANDA_REVEAL_PROMPT,
        targetJid: channelJid,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 5000).toISOString(),
      });
      return { ok: true, action: 'scheduled_reveal', day: poll.data.day };
    } catch (err) {
      return { ok: false, reason: 'schedule_task_failed', error: String(err.message || err) };
    }
  }

  // Partial state — render and ship the card directly, no agent.
  const state = loadStateFn();
  const processed = loadProcFn();
  const cardText = cardBuilder({
    qNum: poll.data.question_number,
    question: poll.data.question,
    padenAnswered: poll.data.paden_answered,
    brendaAnswered: poll.data.brenda_answered,
    day: poll.data.day,
    phase: state?.phase,
    loveMapCount: (processed.processed_days || []).length,
    lastRevealAt: state?.last_revealed_at,
  });
  try {
    await writeIpcMessageFn(groupFolder, {
      type: 'edit_message',
      chatJid: channelJid,
      label: 'panda_heart',
      pin: true,
      upsert: true,
      text: cardText,
    });
    return { ok: true, action: 'updated_card', day: poll.data.day };
  } catch (err) {
    return { ok: false, reason: 'write_card_failed', error: String(err.message || err) };
  }
}

// Event-driven panda hook: poll the sheet state and either update the
// pinned card directly (no agent) or schedule the reveal (agent). Replaces
// the every-10-min cron poller. Wrapped in try/catch — the user's primary
// /qotd reply must never fail because of hook errors. Annotates `out` with
// hook diagnostics so the caller's logs surface partial failures.
async function fireHook(out, token) {
  try {
    const hookResult = await runPandaHook({ token });
    if (!hookResult.ok) {
      out.panda_hook_error = hookResult.reason || 'unknown';
    } else if (hookResult.action && hookResult.action !== 'noop') {
      out.panda_hook_action = hookResult.action;
    }
  } catch (err) {
    out.panda_hook_error = err.message;
  }
}

async function main() {
  const [, , player, userId, answer, qNumArg] = process.argv;
  if (!player || !userId || answer === undefined) {
    process.stderr.write('usage: qotd-slash.mjs <player> <user_id> <answer> [qNum]\n');
    process.exit(2);
  }

  const token = await getAccessToken();

  // Forced-Q path (post-select-menu): append directly, return confirmation.
  if (qNumArg) {
    const qNum = parseInt(qNumArg, 10);
    if (!Number.isFinite(qNum) || qNum < 1) {
      emit({ ok: false, status: 'error', message: `bad qNum: ${qNumArg}` });
      return;
    }
    await appendSubmission({ token, userId, player, qNum, answer });
    const questions = loadQuestions();
    const out = {
      ok: true,
      status: 'appended',
      qNum,
      question: questionText(questions, qNum),
    };
    await fireHook(out, token);
    emit(out);
    return;
  }

  // Discovery path.
  const state = loadState();
  if (!state || typeof state.current_question_number !== 'number') {
    emit({ ok: false, status: 'error', message: 'panda_game_state.json missing or unreadable' });
    return;
  }
  const currentQNum = state.current_question_number;

  const rows = await readRange(PORTILLO_GAMES_SHEET, 'Panda Submissions!A:F', { token });
  const data = (rows || []).slice(1);
  // Column layout: [ts, date, user_id, name, qNum, answer]
  const userAnswered = new Set(
    data.filter((r) => r[2] === userId).map((r) => parseInt(r[4], 10)).filter((n) => Number.isFinite(n)),
  );

  const open = [];
  for (let q = 1; q <= currentQNum; q++) {
    if (!userAnswered.has(q)) open.push(q);
  }

  if (open.length === 0) {
    emit({
      ok: true,
      status: 'caught_up',
      message: "You're all caught up — no open panda Qs for you right now.",
    });
    return;
  }

  if (open.length === 1) {
    const qNum = open[0];
    await appendSubmission({ token, userId, player, qNum, answer });
    const questions = loadQuestions();
    const out = {
      ok: true,
      status: 'appended',
      qNum,
      question: questionText(questions, qNum),
    };
    await fireHook(out, token);
    emit(out);
    return;
  }

  // 2+ open → let the caller surface a picker. Include question text so the
  // select menu shows "Q7 — Would you like to be famous?".
  const questions = loadQuestions();
  // Cap at 25 (Discord StringSelectMenu max). Show most recent first so the
  // day's question is at the top.
  const sortedDesc = [...open].sort((a, b) => b - a).slice(0, 25);
  const candidates = sortedDesc.map((qNum) => ({
    qNum,
    question: questionText(questions, qNum),
  }));
  emit({ ok: true, status: 'needs_choice', candidates });
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    emit({ ok: false, status: 'error', message: err.message, stack: err.stack });
    process.exit(1);
  });
}
