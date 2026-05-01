#!/usr/bin/env node
// chore-slash.mjs — host-side runner for the /chore Discord slash command
// (and its autocomplete). Two actions:
//
//   node scripts/chore-slash.mjs autocomplete <user_id> <query>
//     → emits { ok, options: [{ value, label }] } on stdout
//
//   node scripts/chore-slash.mjs submit <user_id> <value>
//     → logs to Chore Log, awards XP, picks a pet-voice line.
//       emits { ok, doneBy, petName, category, fact, voice, xpAwarded, chores: [{chore_id,name,xp}] }
//
// Value shape: either a raw chore_id ("eni_water_1530") or "group:<group_id>"
// to expand a Chore Groups row.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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

const SHEET_ID = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const TZ = 'America/Chicago';

const USER_TO_OWNER = {
  '181867944404320256': 'Paden',
  '350815183804825600': 'Brenda',
  '280744944358916097': 'Danny',
};

const OWNER_TO_PET = {
  Paden: 'Voss',
  Brenda: 'Nyx',
  Danny: 'Zima',
};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function sheetsGet(token, range) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (j.error) throw new Error(`sheets read ${range}: ${j.error.message}`);
  return j.values || [];
}

async function sheetsAppend(token, tab, row) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!r.ok) throw new Error(`append ${tab}: ${r.status} ${await r.text()}`);
}

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : parseInt(p.hour);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    dow: weekdayMap[p.weekday] ?? 0,
    hour,
    minute: parseInt(p.minute),
    second: parseInt(p.second),
    minutesSinceMidnight: hour * 60 + parseInt(p.minute),
    timestamp: `${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`,
  };
}

function rowsToObjs(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])),
  );
}

function parseChoreRow(r) {
  return {
    chore_id: r.chore_id || '',
    name: r.name || '',
    duration_min: parseInt(r.duration_min) || 0,
    cadence: r.cadence || '',
    schedule: r.schedule || '',
    assigned_to: r.assigned_to || 'anyone',
    nag_after_min: parseInt(r.nag_after_min) || 0,
    nag_interval_min: parseInt(r.nag_interval_min) || 0,
    active: String(r.active).toUpperCase() === 'TRUE',
  };
}

const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseSchedule(cadence, schedule) {
  if (!schedule) return null;
  if (cadence === 'daily') {
    const m = schedule.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = parseInt(m[1]);
    const min = parseInt(m[2]);
    return { hour, min, minutes: hour * 60 + min };
  }
  if (cadence === 'weekly') {
    const m = schedule.match(/^(\w+)\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dow = DAY_NAMES[m[1].toLowerCase()];
    if (dow === undefined) return null;
    const hour = parseInt(m[2]);
    const min = parseInt(m[3]);
    return { hour, min, minutes: hour * 60 + min, dow };
  }
  return null;
}

function xpForChore(chore, status) {
  const mult = status === 'very_late' ? 0.5 : status === 'late' ? 1.0 : 1.5;
  return Math.round((chore.duration_min || 0) * mult);
}

function submitStatusFor(chore, now) {
  const parsed = parseSchedule(chore.cadence, chore.schedule);
  if (!parsed) return 'on-time';
  if (chore.cadence === 'weekly' && parsed.dow !== now.dow) return 'on-time';
  const sinceDue = now.minutesSinceMidnight - parsed.minutes;
  if (sinceDue <= (chore.nag_after_min || 0)) return 'on-time';
  const nagMinutes = chore.nag_interval_min || chore.nag_after_min || 0;
  if (nagMinutes > 0 && sinceDue >= chore.nag_after_min + nagMinutes * 2) return 'very_late';
  return 'late';
}

function categoryForChore(chore) {
  const name = (chore.name || '').toLowerCase();
  if (/water/.test(name)) return 'water';
  if (/feed|breakfast|dinner|lunch|meal/.test(name)) return 'feed';
  if (/bottle/.test(name)) return 'feed';
  if (/trash|bins?\b/.test(name)) return 'trash';
  if (/reservoir/.test(name)) return 'reservoir';
  if (/\bgear\b/.test(name)) return 'gear';
  if (/clean|wash|wipe|vacuum|bathroom|dishes|counter|roomba/.test(name)) return 'clean';
  return 'default';
}

function classifyChore(chore, now, todayLog) {
  const loggedToday = todayLog.some(
    (l) => l.chore_id === chore.chore_id && l.status !== 'auto_skipped',
  );
  if (loggedToday) return 'done';
  const parsed = parseSchedule(chore.cadence, chore.schedule);
  if (!parsed) return 'todo';
  if (chore.cadence === 'daily') {
    return parsed.minutes <= now.minutesSinceMidnight ? 'overdue' : 'upcoming_today';
  }
  if (chore.cadence === 'weekly') {
    if (parsed.dow === now.dow) {
      return parsed.minutes <= now.minutesSinceMidnight ? 'overdue' : 'upcoming_today';
    }
    return 'this_week';
  }
  return 'todo';
}

const BUCKET_RANK = { overdue: 0, upcoming_today: 1, this_week: 2, todo: 3, done: 4 };

function fmt12mins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function choreLabel(chore, bucket, xp) {
  const parsed = parseSchedule(chore.cadence, chore.schedule);
  const time = parsed ? ` · ${fmt12mins(parsed.minutes)}` : '';
  const tag = {
    overdue: 'OVERDUE',
    upcoming_today: 'later today',
    this_week: 'this week',
    todo: 'to-do',
    done: 'done today',
  }[bucket];
  const xpTag = xp > 0 ? ` · +${xp} XP` : '';
  return `${chore.name}${time} (${tag}${xpTag})`;
}

function filterStaleRepeating(chores, now, todayLog) {
  // For a repeating series (multiple chores sharing a name), show ONE entry
  // representing the current interval: the latest passed-and-undone slot if
  // anything is overdue, otherwise the next upcoming slot today. Everything
  // else is noise in the picker.
  const byName = new Map();
  for (const c of chores) {
    const k = c.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const loggedToday = new Set(
    (todayLog || []).filter((l) => l.status !== 'auto_skipped').map((l) => l.chore_id),
  );
  const out = [];
  for (const [, group] of byName) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const passedUndone = [];
    const future = [];
    for (const c of group) {
      const p = parseSchedule(c.cadence, c.schedule);
      if (!p) continue;
      if (p.minutes <= now.minutesSinceMidnight) {
        if (!loggedToday.has(c.chore_id)) passedUndone.push(c);
      } else {
        future.push(c);
      }
    }
    if (passedUndone.length > 0) {
      // Latest overdue only — earlier missed slots are effectively replaced.
      passedUndone.sort((a, b) =>
        parseSchedule(b.cadence, b.schedule).minutes -
        parseSchedule(a.cadence, a.schedule).minutes,
      );
      out.push(passedUndone[0]);
    } else if (future.length > 0) {
      // No overdue → show the next upcoming slot.
      future.sort((a, b) =>
        parseSchedule(a.cadence, a.schedule).minutes -
        parseSchedule(b.cadence, b.schedule).minutes,
      );
      out.push(future[0]);
    }
  }
  return out;
}

async function loadState(token) {
  const now = chicagoNow();
  const [choresRaw, logRaw, groupsRaw] = await Promise.all([
    sheetsGet(token, 'Chores!A1:I100'),
    sheetsGet(token, 'Chore Log!A1:G2000'),
    sheetsGet(token, 'Chore Groups!A1:D50'),
  ]);
  const chores = rowsToObjs(choresRaw).map(parseChoreRow).filter((c) => c.active);
  const log = rowsToObjs(logRaw).map((r) => ({
    timestamp: r.timestamp || '',
    chore_id: r.chore_id || '',
    done_by: r.done_by || '',
    status: r.status || '',
  }));
  const todayLog = log.filter((l) => (l.timestamp || '').startsWith(now.dateStr));

  const groups = rowsToObjs(groupsRaw).map((g) => ({
    group_id: g.group_id || '',
    label: g.label || '',
    chore_ids: String(g.chore_ids || '').split(',').map((s) => s.trim()).filter(Boolean),
    notes: g.notes || '',
  })).filter((g) => g.group_id && g.chore_ids.length);

  return { now, chores, log, todayLog, groups };
}

// Compute the autocomplete option for a Chore Groups bundle. Pure: no I/O,
// no token, just chore + log data. Returns null when:
//   - the group has no resolvable members,
//   - every member is already done today, or
//   - no remaining member is overdue / upcoming_today (i.e. nothing
//     actionable to surface in the picker).
// XP and label reflect ONLY the not-yet-done members, so users see the XP
// they will actually earn — not the full-bundle prize. When some members
// have already been logged, the label switches from "bundle (+XP)" to
// "X of N left, +XP" to make the partial state explicit.
export function computeBundleOption(group, chores, now, todayLog) {
  const memberChores = group.chore_ids
    .map((id) => chores.find((c) => c.chore_id === id))
    .filter(Boolean);
  if (memberChores.length === 0) return null;

  const remaining = memberChores.filter(
    (c) => classifyChore(c, now, todayLog) !== 'done',
  );
  if (remaining.length === 0) return null;

  const anyActionable = remaining.some((c) => {
    const b = classifyChore(c, now, todayLog);
    return b === 'overdue' || b === 'upcoming_today';
  });
  if (!anyActionable) return null;

  const xp = remaining.reduce(
    (sum, c) => sum + xpForChore(c, submitStatusFor(c, now)),
    0,
  );
  const isPartial = remaining.length < memberChores.length;
  const label = isPartial
    ? `${group.label} (${remaining.length} of ${memberChores.length} left, +${xp} XP)`
    : `${group.label} · bundle (+${xp} XP)`;
  return {
    value: `group:${group.group_id}`,
    label,
    xp,
    rank: -1, // surface above singles
  };
}

// Build the fact line for the submit response. Signals partial bundle
// completion ("X of N: ...") so the user understands what got logged when
// some members of a bundle were already done.
export function buildFactLine(doneBy, results) {
  const newlyDone = results.filter((r) => r.xp && !r.skipped);
  const skipped = results.filter((r) => r.skipped === 'already_done');
  if (newlyDone.length === 0) {
    return 'Nothing new to log — already done today.';
  }
  const names = newlyDone.map((r) => r.name).join(' & ');
  if (skipped.length === 0) {
    return `${doneBy} did: ${names}`;
  }
  // Partial bundle: some members were already done.
  const total = newlyDone.length + skipped.length;
  return `${doneBy} did ${newlyDone.length} of ${total}: ${names}`;
}

// --- autocomplete ---
async function runAutocomplete(userId, rawQuery) {
  const query = (rawQuery || '').toLowerCase().trim();
  const token = await getAccessToken();
  const { now, chores, todayLog, groups } = await loadState(token);

  const visible = filterStaleRepeating(chores, now, todayLog);
  const enriched = visible.map((c) => {
    const bucket = classifyChore(c, now, todayLog);
    const xp = xpForChore(c, submitStatusFor(c, now));
    return { chore: c, bucket, xp, label: choreLabel(c, bucket, xp) };
  }).filter((o) => o.bucket !== 'done'); // don't re-offer already-done chores

  // Sort: bucket rank, then scheduled time (if any)
  enriched.sort((a, b) => {
    const r = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    if (r !== 0) return r;
    const pa = parseSchedule(a.chore.cadence, a.chore.schedule)?.minutes ?? 9999;
    const pb = parseSchedule(b.chore.cadence, b.chore.schedule)?.minutes ?? 9999;
    return pa - pb;
  });

  // Groups: show near the top if any not-yet-done member is overdue/upcoming today
  const groupOptions = groups
    .map((g) => computeBundleOption(g, chores, now, todayLog))
    .filter(Boolean);

  const singleOptions = enriched.map((o) => ({
    value: o.chore.chore_id,
    label: o.label,
    rank: BUCKET_RANK[o.bucket],
  }));

  const merged = [...groupOptions, ...singleOptions];

  // Apply query filter (case-insensitive substring on label)
  const filtered = query
    ? merged.filter((o) => o.label.toLowerCase().includes(query))
    : merged;

  // Discord caps at 25 choices per autocomplete response
  emit({ ok: true, options: filtered.slice(0, 25) });
}

// --- submit ---
const PET_LINES_PATH = path.join(ROOT, 'groups', 'discord_silverthorne', 'chore_pet_lines.json');
const PET_LINE_STATE_PATH = path.join(ROOT, 'groups', 'discord_silverthorne', 'chore_pet_line_state.json');

function pickPetLine(petName, category) {
  let pools;
  try { pools = JSON.parse(fs.readFileSync(PET_LINES_PATH, 'utf8')); } catch { return null; }
  const categoryPool = pools?.categories?.[category] || pools?.categories?.default;
  const petPool = categoryPool?.[petName] || pools?.categories?.default?.[petName];
  if (!petPool || petPool.length === 0) return null;

  let state = {};
  try { state = JSON.parse(fs.readFileSync(PET_LINE_STATE_PATH, 'utf8')); } catch {}
  const lastLine = state[petName]?.last || '';
  const candidates = petPool.length > 1 ? petPool.filter((l) => l !== lastLine) : petPool;
  const picked = candidates[Math.floor(Math.random() * candidates.length)];

  state[petName] = { last: picked, updated_at: new Date().toISOString() };
  try { fs.writeFileSync(PET_LINE_STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
  return picked;
}

async function runSubmit(userId, value) {
  const doneBy = USER_TO_OWNER[userId];
  if (!doneBy) {
    emit({ ok: false, error: 'unregistered_user' });
    return;
  }
  const petName = OWNER_TO_PET[doneBy];

  const token = await getAccessToken();
  const { now, chores, todayLog, groups } = await loadState(token);

  let targetChoreIds;
  let isGroup = false;
  if (value.startsWith('group:')) {
    const gid = value.slice('group:'.length);
    const g = groups.find((gg) => gg.group_id === gid);
    if (!g) { emit({ ok: false, error: `unknown group: ${gid}` }); return; }
    targetChoreIds = g.chore_ids;
    isGroup = true;
  } else {
    targetChoreIds = [value];
  }

  const results = [];
  let totalXp = 0;
  const earnedByOwner = new Map();
  const categoriesSeen = new Set();

  for (const cid of targetChoreIds) {
    const chore = chores.find((c) => c.chore_id === cid);
    if (!chore) {
      results.push({ chore_id: cid, error: 'unknown' });
      continue;
    }
    // Skip if already done today (guards against picker stale-ness)
    const already = todayLog.find(
      (l) => l.chore_id === cid && l.status !== 'auto_skipped',
    );
    if (already) {
      results.push({ chore_id: cid, name: chore.name, skipped: 'already_done' });
      continue;
    }

    const status = submitStatusFor(chore, now);
    // Assisted-helper rule: non-owner doing an owner-assigned chore.
    const assigned = chore.assigned_to;
    const isAssisted = assigned && assigned !== 'anyone' && assigned !== doneBy;
    const logStatus = isAssisted ? 'assisted' : status;
    const xpEarner = isAssisted ? doneBy : doneBy; // helper gets base XP, owner gets 0
    const xpAmount = isAssisted
      ? chore.duration_min || 0 // helper: base XP only, no multiplier
      : xpForChore(chore, status);

    // Append Chore Log row: [timestamp, chore_id, name, done_by, duration_min, status, notes]
    await sheetsAppend(token, 'Chore Log', [
      now.timestamp,
      chore.chore_id,
      '',
      doneBy,
      String(chore.duration_min || ''),
      logStatus,
      '',
    ]);

    totalXp += xpAmount;
    earnedByOwner.set(xpEarner, (earnedByOwner.get(xpEarner) || 0) + xpAmount);
    categoriesSeen.add(categoryForChore(chore));
    results.push({
      chore_id: cid,
      name: chore.name,
      status: logStatus,
      xp: xpAmount,
    });
  }

  // Award XP via the existing script. Batched by owner so multi-chore groups
  // don't double-evolve.
  const awards = [];
  const awardScript = path.join(ROOT, 'groups', 'discord_silverthorne', 'award_xp.mjs');
  for (const [owner, xp] of earnedByOwner) {
    if (xp <= 0) continue;
    try {
      const out = execFileSync('node', [awardScript, owner, String(xp), `/chore ${isGroup ? value : targetChoreIds.join(',')}`], {
        env: process.env,
        maxBuffer: 1_000_000,
      }).toString();
      const lastLine = out.trim().split('\n').pop() || '{}';
      awards.push({ owner, xp, award: JSON.parse(lastLine) });
    } catch (err) {
      awards.push({ owner, xp, error: err.message });
    }
  }

  // Build fact line: plural-aware, signals partial bundle completion
  const fact = buildFactLine(doneBy, results);

  // Pet line: pick category (use single chore's category, or 'default' for mixed)
  const category = categoriesSeen.size === 1 ? [...categoriesSeen][0] : 'default';
  const voice = pickPetLine(petName, category);

  // Event-driven status_card rebuild — Phase 4.1 of nag-cron migration.
  // After every successful submit, rebuild the pinned card and emit an IPC
  // edit_message. Don't fail the slash if either hop blows up.
  const hookResult = await runChoreCardHook({ token, results });
  if (hookResult.error) {
    process.stderr.write(`status_card rebuild failed: ${hookResult.error}\n`);
  }

  emit({
    ok: true,
    doneBy,
    petName,
    category,
    fact,
    voice,
    totalXp,
    awards,
    chores: results,
    statusCardUpdated: hookResult.updated,
  });
}

// Rebuild the silverthorne status_card and post via IPC edit_message. Pure
// of side effects on the slash response — every failure is captured into the
// returned shape so the caller can decide how to log.
//
// Returns:
//   { skipped: 'no_newly_done' }              when no chore was newly logged
//   { updated: true }                         on success
//   { updated: false, error: <string> }       on any failure
//
// Injectable deps for tests:
//   buildStatusCardFn({ token })  -> { discord, ... }
//   writeIpcMessageFn(group, msg, opts) -> any
export async function runChoreCardHook({
  token,
  results,
  buildStatusCardFn,
  writeIpcMessageFn,
} = {}) {
  const newlyDone = (results || []).some((r) => r.xp && !r.skipped);
  if (!newlyDone) return { skipped: 'no_newly_done' };

  try {
    if (!buildStatusCardFn) {
      const mod = await import(
        path.join(ROOT, 'groups', 'discord_silverthorne', 'build_status_card.mjs')
      );
      buildStatusCardFn = mod.buildStatusCard;
    }
    if (!writeIpcMessageFn) {
      const ipcMod = await import(path.join(ROOT, 'dist', 'ipc-writer.js'));
      writeIpcMessageFn = ipcMod.writeIpcMessage;
    }

    const { discord } = await buildStatusCardFn({ token });
    await writeIpcMessageFn(
      'discord_silverthorne',
      {
        type: 'edit_message',
        chatJid: 'dc:1490895684789075968',
        label: 'status_card',
        text: discord,
      },
      { rootDir: ROOT },
    );
    return { updated: true };
  } catch (err) {
    return { updated: false, error: String(err.message || err) };
  }
}

// --- main ---
async function main() {
  const [, , action, userId, ...rest] = process.argv;
  if (!action || !userId) {
    process.stderr.write('usage: chore-slash.mjs <action> <user_id> [args...]\n');
    process.exit(2);
  }
  if (action === 'autocomplete') {
    await runAutocomplete(userId, rest.join(' '));
  } else if (action === 'submit') {
    const value = rest[0];
    if (!value) {
      emit({ ok: false, error: 'missing value' });
      process.exit(2);
    }
    await runSubmit(userId, value);
  } else {
    emit({ ok: false, error: `unknown action: ${action}` });
    process.exit(2);
  }
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    emit({ ok: false, error: err.message, stack: err.stack });
    process.exit(1);
  });
}
