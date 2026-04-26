// winddown_advance_check.mjs — emilio-care wind-down (advance) reminder gate.
//
// Runs on the host every 10 min between 7am–9pm Chicago. Reads the latest
// closed nap from the Sleep Log, computes the wind-down/sleep target window,
// and when we're 0–10 min BEFORE the wind-down time, posts a short reminder
// directly via IPC and dedupes via winddown_advance_state.json.
//
// ALWAYS returns wakeAgent: false — the agent never fires from this cron.
// Phase 6 of the emilio-care reminder dedup migration. Replaces the inline
// JS heredoc that previously lived in scheduled_tasks.script.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TZ = 'America/Chicago';
const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';
const EMILIO_JID = 'dc:1490781468182577172';
const GROUP_FOLDER = 'discord_emilio-care';

function fmtClock(minOfDay) {
  const h24 = Math.floor(minOfDay / 60) % 24;
  const mm = minOfDay % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

export function composeAdvanceReminder({ windDownTime, sleepByTime, shortNap }) {
  let line = `😴 Wind-down coming up at ${windDownTime} — sleep by ${sleepByTime}`;
  if (shortNap) line += ' ⚡';
  return line;
}

function chicagoParts(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(d)
    .reduce(
      (o, p) => (p.type !== 'literal' ? { ...o, [p.type]: p.value } : o),
      {},
    );
}

// Pure: derive window data from the last sleep-log row + current time.
// Returns null when nothing should fire.
//   { windDownMin, sleepByMin, shortNap, diff, todayKey }
export function computeWindow({ lastRow, now }) {
  if (!lastRow || !lastRow[0]) return null;
  const startStr = lastRow[0];
  const dur = lastRow[1] || '';
  if (!dur || !(parseFloat(dur) > 0)) return null;
  const durMin = parseFloat(dur);

  const sleepDate = new Date(startStr);
  if (isNaN(sleepDate.getTime())) return null;

  const cp = chicagoParts(now);
  const sp = chicagoParts(sleepDate);

  const hour = cp.hour === '24' ? 0 : parseInt(cp.hour);
  const minute = parseInt(cp.minute);
  const nowMin = hour * 60 + minute;
  const todayStr = `${cp.year}-${cp.month}-${cp.day}`;

  const sleepHour = sp.hour === '24' ? 0 : parseInt(sp.hour);
  const sleepMin = parseInt(sp.minute);
  const sleepMinOfDay = sleepHour * 60 + sleepMin;
  const sleepDateStr = `${sp.year}-${sp.month}-${sp.day}`;

  // The nap being measured must have started today (same Chicago calendar day).
  if (sleepDateStr !== todayStr) return null;

  const wakeMin = sleepMinOfDay + durMin;
  const shortNap = durMin < 45;
  const windDownMin = wakeMin + (shortNap ? 45 : 70);
  const sleepByMin = wakeMin + (shortNap ? 60 : 90);
  const diff = windDownMin - nowMin;

  return {
    windDownMin,
    sleepByMin,
    shortNap,
    diff,
    todayKey: `${todayStr}_${windDownMin}`,
  };
}

// Default sheets reader: last row of Sleep Log col A:B.
async function defaultSheetsReader() {
  const sheetsLibPath = path.join(
    __dirname,
    '..',
    'global',
    'scripts',
    'lib',
    'sheets.mjs',
  );
  const { getAccessToken } = await import(sheetsLibPath);
  const token = await getAccessToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Sleep Log!A:B')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  const rows = j.values || [];
  return rows[rows.length - 1] || null;
}

async function defaultIpcWriter() {
  const projectRoot =
    process.env.WORKSPACE_PROJECT || path.resolve(__dirname, '..', '..');
  const ipcMod = await import(path.join(projectRoot, 'dist', 'ipc-writer.js'));
  return (group, msg) =>
    ipcMod.writeIpcMessage(group, msg, { rootDir: projectRoot });
}

// Run the advance wind-down check. Always resolves `wakeAgent: false`.
//
// Injectable deps:
//   nowFn()                       -> Date
//   sheetsReader()                -> last Sleep Log row [start, dur]
//   writeIpcMessageFn(group, msg) -> any
//   statePath                     persistent dedup state file
export async function runAdvanceCheck({
  nowFn = () => new Date(),
  sheetsReader = defaultSheetsReader,
  writeIpcMessageFn,
  statePath: statePathArg,
} = {}) {
  const now = nowFn();

  let lastRow;
  try {
    lastRow = await sheetsReader();
  } catch {
    return { wakeAgent: false };
  }

  const win = computeWindow({ lastRow, now });
  if (!win) return { wakeAgent: false };

  // Fire only in the 0–10 min lead-up window.
  if (win.diff < 0 || win.diff > 10) return { wakeAgent: false };

  const statePath =
    statePathArg ||
    path.join(
      process.env.WORKSPACE_GROUP || __dirname,
      'winddown_advance_state.json',
    );

  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    /* fresh */
  }

  if (state.lastKey === win.todayKey) return { wakeAgent: false };

  const windDownTime = fmtClock(win.windDownMin);
  const sleepByTime = fmtClock(win.sleepByMin);
  const text = composeAdvanceReminder({
    windDownTime,
    sleepByTime,
    shortNap: win.shortNap,
  });

  let writeFn = writeIpcMessageFn;
  if (!writeFn) writeFn = await defaultIpcWriter();

  let posted = false;
  let postError;
  try {
    await writeFn(GROUP_FOLDER, {
      type: 'message',
      chatJid: EMILIO_JID,
      text,
    });
    posted = true;
  } catch (err) {
    postError = String(err.message || err);
  }

  if (posted) {
    try {
      writeFileSync(statePath, JSON.stringify({ lastKey: win.todayKey }));
    } catch {
      /* best effort */
    }
  }

  return {
    wakeAgent: false,
    data: {
      posted,
      windDownTime,
      sleepByTime,
      shortNap: win.shortNap,
      diff: win.diff,
      ...(postError ? { post_error: postError } : {}),
    },
  };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runAdvanceCheck();
  console.log(JSON.stringify(out));
}
