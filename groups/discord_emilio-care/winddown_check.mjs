// winddown_check.mjs — emilio-care wind-down (post-wake) reminder gate.
//
// Runs on the host every 15 min between 7am–8pm Chicago. Computes the current
// wind-down/sleep target via build_status_card.mjs and, when we're inside the
// 0–15 min window AFTER the wind-down time, posts a warm reminder directly
// via IPC and dedupes via winddown_state.json.
//
// ALWAYS returns wakeAgent: false — the agent never fires from this cron.
// Phase 6 of the emilio-care reminder dedup migration.

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TZ = 'America/Chicago';
const EMILIO_JID = 'dc:1490781468182577172';
const GROUP_FOLDER = 'discord_emilio-care';

// Three rotating reminder templates. Pick by hash of windDownMin so consecutive
// nap cycles don't repeat the same line.
const TEMPLATES = [
  (sleepTime) => `It's wind-down time — sleep target ${sleepTime}.`,
  (sleepTime) => `Time to wind down. Aiming for sleep around ${sleepTime}.`,
  (sleepTime) => `Wind-down window's open. Sleep by ${sleepTime} ⏳`,
];

export function composeReminder({ sleepTime, shortNap, windDownMin }) {
  const idx = Math.abs(windDownMin | 0) % TEMPLATES.length;
  let line = TEMPLATES[idx](sleepTime);
  if (shortNap) line += ' (short nap — tighter window)';
  return line;
}

function chicagoNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .reduce(
      (o, p) => (p.type !== 'literal' ? { ...o, [p.type]: p.value } : o),
      {},
    );
  const hour = parts.hour === '24' ? 0 : parseInt(parts.hour);
  const minute = parseInt(parts.minute);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
  };
}

function parseHM(str) {
  const m = str.trim().match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// Default card builder runs the existing script. Tests inject a stub.
function defaultCardBuilder() {
  return execSync('node ' + path.join(__dirname, 'build_status_card.mjs'), {
    timeout: 25000,
  }).toString();
}

// Default IPC writer pulls from dist/ipc-writer.js. Tests inject a stub.
async function defaultIpcWriter() {
  const projectRoot =
    process.env.WORKSPACE_PROJECT || path.resolve(__dirname, '..', '..');
  const ipcMod = await import(path.join(projectRoot, 'dist', 'ipc-writer.js'));
  return (group, msg) =>
    ipcMod.writeIpcMessage(group, msg, { rootDir: projectRoot });
}

// Run the wind-down check. Always resolves `wakeAgent: false`.
//
// Injectable deps:
//   nowFn()          -> Date (for deterministic tests)
//   cardBuilder()    -> raw status card string
//   writeIpcMessageFn(group, msg) -> any
//   statePath        persistent dedup state file
export async function runWindDownCheck({
  nowFn = () => new Date(),
  cardBuilder = defaultCardBuilder,
  writeIpcMessageFn,
  statePath: statePathArg,
} = {}) {
  const now = nowFn();
  const cp = chicagoNowParts(now);

  // Only fire 7am–8pm Chicago.
  if (cp.hour < 7 || cp.hour >= 20) {
    return { wakeAgent: false };
  }

  let card;
  try {
    card = cardBuilder();
  } catch {
    return { wakeAgent: false };
  }

  const wdMatch = card.match(
    /⏰ Wind-down: (\d+:\d+\s*[AP]M) · 💤 Sleep by: (\d+:\d+\s*[AP]M)/,
  );
  if (!wdMatch) return { wakeAgent: false };

  const windDownStr = wdMatch[1].trim();
  const sleepTimeStr = wdMatch[2].trim();
  const windDownMin = parseHM(windDownStr);
  if (windDownMin === null) return { wakeAgent: false };

  const nowMin = cp.hour * 60 + cp.minute;

  // Wake if we're within 15 min AFTER wind-down time (handles cron jitter).
  const diff = (nowMin - windDownMin + 1440) % 1440;
  if (diff > 15) return { wakeAgent: false };

  const statePath =
    statePathArg ||
    path.join(
      process.env.WORKSPACE_GROUP || __dirname,
      'winddown_state.json',
    );

  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    /* fresh */
  }

  const key = `${cp.year}-${cp.month}-${cp.day}_${windDownMin}`;
  if (state.lastKey === key) return { wakeAgent: false };

  const shortNap = card.includes('⚡ (short nap)');
  const text = composeReminder({
    sleepTime: sleepTimeStr,
    shortNap,
    windDownMin,
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

  // Persist state only if the post succeeded — otherwise let the next tick retry.
  if (posted) {
    try {
      writeFileSync(statePath, JSON.stringify({ lastKey: key }));
    } catch {
      /* best effort */
    }
  }

  return {
    wakeAgent: false,
    data: {
      posted,
      windDownTime: windDownStr,
      sleepTime: sleepTimeStr,
      shortNap,
      ...(postError ? { post_error: postError } : {}),
    },
  };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runWindDownCheck();
  console.log(JSON.stringify(out));
}
