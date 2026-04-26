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

// Parse "YYYY-MM-DD HH:MM:SS" as America/Chicago wall-clock. Derives the
// active offset (CST/CDT) via Intl so DST is handled without a tz library.
function parseChicagoTs(str) {
  // Existing sheet rows use both zero-padded ("19:30:00") and single-digit
  // ("6:39:00") hours depending on which writer logged them. ISO 8601
  // requires 2-digit hours, so zero-pad before constructing the Date.
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`bad timestamp: ${str}`);
  const hh = m[4].padStart(2, '0');
  const probe = new Date(`${m[1]}-${m[2]}-${m[3]}T${hh}:${m[5]}:${m[6]}Z`);
  if (Number.isNaN(probe.getTime())) throw new Error(`bad timestamp: ${str}`);
  const utcStr = probe.toLocaleString('en-US', { timeZone: 'UTC' });
  const chiStr = probe.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const offsetMin = Math.round((new Date(utcStr) - new Date(chiStr)) / 60_000);
  return new Date(probe.getTime() + offsetMin * 60_000);
}

function findOpenNaps(rows) {
  if (!rows || rows.length < 2) return [];
  return rows
    .slice(1)
    .map((r, i) => ({ start: r[0] || '', duration: r[1] || '', sheetRow: i + 2 }))
    .filter((r) => r.start && !r.duration);
}

// emitFollowups — after every successful sheet write, fire the Emilio chime,
// post a Claudio confirmation visible to both parents, and refresh the pinned
// status card. Three IPC messages.
async function emitFollowups(deps, eventType, confirmText) {
  const token = await deps.getToken();

  // Chime first (Emilio webhook persona) — the cute reaction lands before the
  // data-bearing confirmation.
  const state = deps.loadChimeState();
  const { text: chimeText, newState } = deps.pickChime(eventType, state);
  await deps.writeIpcMessage(GROUP_FOLDER, {
    type: 'message',
    chatJid: CHAT_JID,
    sender: 'Emilio',
    text: chimeText,
  });
  deps.saveChimeState(newState);

  // Claudio confirmation — non-ephemeral, both parents see what got logged.
  if (confirmText) {
    await deps.writeIpcMessage(GROUP_FOLDER, {
      type: 'message',
      chatJid: CHAT_JID,
      text: confirmText,
    });
  }

  // Status card refresh (silent edit on the pinned label).
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
  const owner = ownerFor(userId);
  await emitFollowups(deps, 'asleep', `😴 ${owner}: nap started at ${parsed.displayLocal}.`);
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
  const owner = ownerFor(userId);
  await emitFollowups(
    deps,
    'awake',
    `☀️ ${owner}: awake at ${parsed.displayLocal} (nap was ${result.durationMin} min).`,
  );
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
  // The auto-close is a convenience — if it fails (bad sheet timestamp,
  // network blip, etc.), the feeding itself is already logged so we keep
  // the chime + confirm + card path instead of bubbling the error up.
  let napClosed = false;
  try {
    const sleepRows = await deps.readSleepLog(token);
    const open = findOpenNaps(sleepRows);
    if (open.length === 1) {
      const closeResult = await deps.closeSleep(parsed.iso);
      if (closeResult && closeResult.ok) napClosed = true;
    }
  } catch (err) {
    process.stderr.write(`auto-close failed (feeding still logged): ${err.message}\n`);
  }

  const owner = ownerFor(userId);
  const confirm = `🍼 ${owner}: ${n} oz ${src} at ${parsed.displayLocal}${napClosed ? ' (nap closed)' : ''}.`;
  await emitFollowups(deps, 'feeding', confirm);
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
  const owner = ownerFor(userId);
  const tsLabel = target.timestamp.slice(11, 16);
  await emitFollowups(
    deps,
    'feeding_update',
    `✏️ ${owner}: feeding at ${tsLabel} updated to ${n} oz (was ${target.amount} oz).`,
  );
  return {
    ok: true,
    reply: `Feeding at ${tsLabel} updated: ${target.amount}oz → ${n}oz.`,
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
      // Match "YYYY-MM-DD H:MM:SS" or "YYYY-MM-DD HH:MM:SS" — older sheet rows
      // were written with single-digit hours.
      const m = t.ts.match(/\s(\d{1,2}):(\d{2}):/);
      const hh = m ? parseInt(m[1], 10) : 0;
      const mm = m ? m[2] : '00';
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
  const sheetsLib = await import(
    path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
  );
  const { getAccessToken, readRange, appendRows, updateRange } = sheetsLib;
  const ipc = await import(path.join(ROOT, 'dist', 'ipc-writer.js'));
  const cardMod = await import(
    path.join(ROOT, 'groups', GROUP_FOLDER, 'build_status_card.mjs')
  );

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
      const token = await getAccessToken();
      const rows = await readRange(SHEET_ID, 'Sleep Log!A2:B2000', { token });
      const open = (rows || []).find((r) => r[0] && !r[1]);
      if (open) return { ok: false, error: `Open session at ${open[0]} — close first.` };
      await appendRows(SHEET_ID, 'Sleep Log!A:B', [[timestamp, '']], { token });
      return { ok: true, startTime: timestamp };
    },
    closeSleep: async (wakeTimestamp) => {
      const token = await getAccessToken();
      const rows = await readRange(SHEET_ID, 'Sleep Log!A2:B2000', { token });
      const openIdxs = [];
      (rows || []).forEach((r, i) => {
        if (r[0] && !r[1]) openIdxs.push(i);
      });
      if (openIdxs.length === 0) return { ok: false, error: 'No open sleep session to close.' };
      if (openIdxs.length > 1) {
        return {
          ok: false,
          error: `${openIdxs.length} open sessions — manual cleanup required.`,
        };
      }
      const idx = openIdxs[0];
      const startStr = rows[idx][0];
      const start = parseChicagoTs(startStr);
      const wake = parseChicagoTs(wakeTimestamp);
      const durationMin = Math.round((wake - start) / 60_000);
      if (durationMin < 0) {
        return { ok: false, error: `Wake time ${wakeTimestamp} is before start ${startStr}.` };
      }
      const sheetRow = idx + 2; // header is row 1; A2 starts at index 0
      await updateRange(SHEET_ID, `Sleep Log!B${sheetRow}`, [[durationMin]], { token });
      return {
        ok: true,
        row: sheetRow,
        startTime: startStr,
        wakeTime: wakeTimestamp,
        durationMin,
      };
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
