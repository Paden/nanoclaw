#!/usr/bin/env node
// scripts/emilio-slash.mjs — host-side runner for /asleep, /awake, /feeding,
// /update-feeding. Dispatches by first CLI arg. Each action returns a JSON
// envelope on stdout consumed by src/channels/discord.ts.
//
// Architecture: every handler accepts (args, deps) so tests can mock IO.
// The CLI builds default deps via defaultDeps() which dynamically imports the
// real modules.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Route sheets.mjs at the host-local OAuth artifacts before any helper that
// calls getAccessToken() reads these env vars at call time.
process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const TZ = 'America/Chicago';
const GROUP_FOLDER = 'discord_emilio-care';
const GROUP_DIR = path.join(ROOT, 'groups', GROUP_FOLDER);
const CHAT_JID = 'dc:1490781468182577172';
const CHIME_STATE_PATH = path.join(GROUP_DIR, 'emilio_chime_state.json');
const VOICE_MD_PATH = path.join(GROUP_DIR, 'emilio_voice.md');
const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';

const USER_TO_OWNER = {
  '181867944404320256': 'Paden',
  '350815183804825600': 'Brenda',
  '280744944358916097': 'Danny',
};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function chicagoDateStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(
    parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function ownerFor(userId) {
  return USER_TO_OWNER[userId] || null;
}

function findOpenNaps(rows) {
  if (!rows || rows.length < 2) return [];
  return rows
    .slice(1)
    .map((r, i) => ({ start: r[0] || '', duration: r[1] || '', sheetRow: i + 2 }))
    .filter((r) => r.start && !r.duration);
}

// emitFollowups — after every successful sheet write, refresh the pinned
// status card and fire an Emilio chime via two IPC messages.
async function emitFollowups(deps, eventType) {
  const token = await deps.getToken();
  let cardText;
  try {
    const card = await deps.buildStatusCard({ token });
    cardText = typeof card === 'string' ? card : (card.discord ?? card.full ?? '');
  } catch (err) {
    process.stderr.write(`status_card rebuild failed: ${err.message}\n`);
  }
  if (cardText) {
    await deps.writeIpcMessage(GROUP_FOLDER, {
      type: 'edit_message',
      chatJid: CHAT_JID,
      label: 'status_card',
      text: cardText,
    });
  }
  const state = deps.loadChimeState();
  const { text, newState } = deps.pickChime(eventType, state);
  await deps.writeIpcMessage(GROUP_FOLDER, {
    type: 'message',
    chatJid: CHAT_JID,
    sender: 'Emilio',
    text,
  });
  deps.saveChimeState(newState);
}

// --- Action handlers (exported for tests) ---

export async function runAsleep({ userId, time }, deps) {
  if (!ownerFor(userId)) {
    return { ok: false, error: 'You are not registered for emilio-care logging.' };
  }
  const token = await deps.getToken();
  const rows = await deps.readSleepLog(token);
  const open = findOpenNaps(rows);
  if (open.length > 0) {
    return {
      ok: false,
      error: `Open nap from ${open[0].start}. Run /awake first or update the row directly.`,
    };
  }
  const parsed = deps.parseTime(time, deps.now);
  const result = await deps.openSleep(parsed.iso);
  if (!result.ok) return { ok: false, error: result.error || 'open_sleep failed' };
  await emitFollowups(deps, 'asleep');
  return { ok: true, reply: `Nap opened at ${parsed.displayLocal}.` };
}

export async function runAwake({ userId, time }, deps) {
  if (!ownerFor(userId)) {
    return { ok: false, error: 'You are not registered for emilio-care logging.' };
  }
  const token = await deps.getToken();
  const rows = await deps.readSleepLog(token);
  const open = findOpenNaps(rows);
  if (open.length === 0) return { ok: false, error: 'No open nap to close.' };
  if (open.length > 1) {
    return { ok: false, error: 'Multiple open naps — please clean up the sheet first.' };
  }
  const parsed = deps.parseTime(time, deps.now);
  const result = await deps.closeSleep(parsed.iso);
  if (!result.ok) return { ok: false, error: result.error || 'close_sleep failed' };
  await emitFollowups(deps, 'awake');
  return {
    ok: true,
    reply: `Nap closed at ${parsed.displayLocal}, ${result.durationMin} min.`,
  };
}

export async function runFeeding({ userId, amount, time, source }, deps) {
  if (!ownerFor(userId)) {
    return { ok: false, error: 'You are not registered for emilio-care logging.' };
  }
  let n;
  try {
    n = deps.validateAmount(amount);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const parsed = deps.parseTime(time, deps.now);
  const src = source || 'Formula';
  const token = await deps.getToken();
  await deps.appendFeeding(token, { timestamp: parsed.iso, amount: n, source: src });

  // Implicit wake-up: re-read sleep log AFTER appending and auto-close iff
  // exactly one nap is open. Zero or 2+ → no auto-close, no error.
  let napClosed = false;
  const sleepRows = await deps.readSleepLog(token);
  const open = findOpenNaps(sleepRows);
  if (open.length === 1) {
    const closeResult = await deps.closeSleep(parsed.iso);
    if (closeResult && closeResult.ok) napClosed = true;
  }

  await emitFollowups(deps, 'feeding');
  const reply = `Logged ${n}oz ${src} at ${parsed.displayLocal}.${napClosed ? ' Closed open nap.' : ''}`;
  return { ok: true, reply, napClosed };
}

export async function runUpdateFeeding({ userId, amount, row }, deps) {
  if (!ownerFor(userId)) {
    return { ok: false, error: 'You are not registered for emilio-care logging.' };
  }
  let n;
  try {
    n = deps.validateAmount(amount);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const today = chicagoDateStr(deps.now);
  const token = await deps.getToken();
  const allRows = await deps.readFeedings(token);

  let target;
  if (row) {
    if (!row.startsWith(today)) {
      return {
        ok: false,
        error: 'Today only — older rows must be edited via the agent or sheet.',
      };
    }
    const idx = allRows.findIndex((r) => r[0] === row);
    if (idx === -1) return { ok: false, error: `No feeding row matches ${row}.` };
    target = { timestamp: row, amount: allRows[idx][1], sheetRow: idx + 1 };
  } else {
    const todays = [];
    for (let i = 1; i < allRows.length; i++) {
      const ts = allRows[i][0] || '';
      if (ts.startsWith(today)) {
        todays.push({ timestamp: ts, amount: allRows[i][1], sheetRow: i + 1 });
      }
    }
    if (todays.length === 0) return { ok: false, error: 'No feedings logged today.' };
    todays.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    target = todays[0];
  }

  await deps.updateFeedingAmount(token, { sheetRow: target.sheetRow, amount: n });
  await emitFollowups(deps, 'feeding_update');
  return {
    ok: true,
    reply: `Feeding at ${target.timestamp.slice(11, 16)} updated: ${target.amount}oz → ${n}oz.`,
  };
}

export async function runAutocompleteFeedingRow(_args, deps) {
  const token = await deps.getToken();
  const today = chicagoDateStr(deps.now);
  const allRows = await deps.readFeedings(token);
  const todays = [];
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    const ts = r[0] || '';
    if (ts.startsWith(today)) {
      todays.push({ ts, amount: r[1] || '', source: r[2] || '' });
    }
  }
  todays.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const top = todays.slice(0, 5);
  return {
    ok: true,
    options: top.map((t) => {
      const hh = parseInt(t.ts.slice(11, 13), 10);
      const mm = t.ts.slice(14, 16);
      const ampm = hh < 12 ? 'AM' : 'PM';
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return {
        value: t.ts,
        label: `${h12}:${mm} ${ampm} · ${t.amount}oz ${t.source}`,
      };
    }),
  };
}

// --- Default deps factory (live IO, used by the CLI) ---

export async function defaultDeps() {
  const { parseTime } = await import(
    path.join(ROOT, 'groups', GROUP_FOLDER, 'scripts', 'parse_time.mjs')
  );
  const { appendFeeding, updateFeedingAmount, readFeedings, validateAmount } = await import(
    path.join(ROOT, 'groups', GROUP_FOLDER, 'scripts', 'feeding_log.mjs')
  );
  const { parsePools, pickChime } = await import(
    path.join(ROOT, 'groups', GROUP_FOLDER, 'scripts', 'emilio_chime.mjs')
  );
  const { getAccessToken } = await import(
    path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
  );
  const ipc = await import(path.join(ROOT, 'dist', 'ipc-writer.js'));
  const cardMod = await import(
    path.join(ROOT, 'groups', GROUP_FOLDER, 'build_status_card.mjs')
  );
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);

  const voice = fs.existsSync(VOICE_MD_PATH) ? fs.readFileSync(VOICE_MD_PATH, 'utf8') : '';
  const pools = parsePools(voice);

  return {
    getToken: () => getAccessToken(),
    readSleepLog: async (token) => {
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Sleep Log!A:B')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      return j.values || [];
    },
    openSleep: async (timestamp) => {
      const { stdout } = await execFileP(
        'node',
        [path.join(GROUP_DIR, 'open_sleep.mjs'), timestamp],
        {
          env: {
            ...process.env,
            WORKSPACE_GROUP: GROUP_DIR,
            WORKSPACE_GLOBAL: path.join(ROOT, 'groups', 'global'),
          },
        },
      );
      return JSON.parse(stdout.trim().split('\n').pop());
    },
    closeSleep: async (timestamp) => {
      const { stdout } = await execFileP(
        'node',
        [path.join(GROUP_DIR, 'close_sleep.mjs'), timestamp],
        {
          env: {
            ...process.env,
            WORKSPACE_GROUP: GROUP_DIR,
            WORKSPACE_GLOBAL: path.join(ROOT, 'groups', 'global'),
          },
        },
      );
      return JSON.parse(stdout.trim().split('\n').pop());
    },
    appendFeeding,
    updateFeedingAmount,
    readFeedings,
    validateAmount,
    buildStatusCard: cardMod.buildStatusCard,
    writeIpcMessage: ipc.writeIpcMessage,
    pickChime: (evt, state) => pickChime(evt, pools, state),
    loadChimeState: () => {
      try {
        return JSON.parse(fs.readFileSync(CHIME_STATE_PATH, 'utf8'));
      } catch {
        return { last: {} };
      }
    },
    saveChimeState: (s) => fs.writeFileSync(CHIME_STATE_PATH, JSON.stringify(s, null, 2)),
    parseTime,
    now: new Date(),
  };
}

// --- CLI ---

async function main() {
  const [, , action, userId, ...rest] = process.argv;
  if (!action) {
    process.stderr.write('usage: emilio-slash.mjs <action> [userId] [args...]\n');
    process.exit(2);
  }
  const deps = await defaultDeps();
  try {
    let out;
    switch (action) {
      case 'asleep':
        out = await runAsleep({ userId, time: rest[0] || '' }, deps);
        break;
      case 'awake':
        out = await runAwake({ userId, time: rest[0] || '' }, deps);
        break;
      case 'feeding':
        out = await runFeeding(
          { userId, amount: rest[0], time: rest[1] || '', source: rest[2] || '' },
          deps,
        );
        break;
      case 'update-feeding':
        out = await runUpdateFeeding(
          { userId, amount: rest[0], row: rest[1] || '' },
          deps,
        );
        break;
      case 'autocomplete-feeding-row':
        out = await runAutocompleteFeedingRow({}, deps);
        break;
      default:
        out = { ok: false, error: `unknown action: ${action}` };
    }
    emit(out);
  } catch (err) {
    emit({ ok: false, error: err.message, stack: err.stack });
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
