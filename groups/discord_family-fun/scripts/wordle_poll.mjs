// wordle_poll.mjs — gate logic for Saga Wordle.
//
// Reads the Portillo Games "Wordle State" tab, computes per-player progress
// for today, and emits a poll result indicating whether the host should wake
// any downstream consumer (post a card update, fire the reveal agent, ...).
//
// Persists a fingerprint + resolved flag to a JSON file so identical polls
// don't re-trigger work and the reveal can only fire once per day.
//
// Used by:
//   - scripts/wordle-slash.mjs after each successful guess submission (host)
//   - the legacy cron task (going away in this commit)
//
// All Sheets I/O is injected via deps so tests can run against fixtures.

import fs from 'fs';
import { createHash } from 'crypto';

const PLAYERS = ['Paden', 'Brenda', 'Danny'];

export const WORDLE_REVEAL_PROMPT = `You are Claudio, the Saga Wordle game-master for #family-fun. All three players are now done — run the final reveal NOW.

⛔ ABSOLUTE PRIVACY RULE while in progress is OVER. You may now post grids, letters, and the day's word.

FLOW:
1. Read the Portillo Games sheet (1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY), Wordle State tab. Filter rows where date = today (America/Chicago, YYYY-MM-DD). Group by player, sort by guess_num.
2. Determine winner: fewest guesses among solvers. Tie → earliest final-row timestamp. All unsolved → no winner.
3. Apply Silverthorne sheet pet effects: winner +20 xp, losers -10 health, all unsolved -5/-5.
4. Write today's saga chapter (pirate space opera, today's word used naturally, no bold). Append to /workspace/group/saga_state.json. Update /workspace/group/wordle_leaderboard.json.
5. Post to #family-fun ONE message with: 📖 Day {N} chapter header, every player's full grid (colored tiles + letters), winner announcement, pet consequences. Theatrical.
6. Read Portillo Games sheet Cheat Log tab. For each row where date=today AND status=pending_review, post a SECOND message: 🚨 Cheat Review per the Jury review section in CLAUDE.md. Pull suspect DMs from /workspace/project/store/messages.db. Update each row to status=awaiting_verdict. Do NOT apply penalties — that happens after both jurors vote.
7. Mark /workspace/group/wordle_state.json resolved=true so we don't double-post.

OUTPUT RULE: Wrap all status/log/recap text in <internal>...</internal> tags. The reveal post itself is the only un-tagged channel output.`;

export function computeFingerprint(today, summary) {
  return createHash('sha1').update(JSON.stringify({ today, summary })).digest('hex');
}

function readPollerState(pollerStatePath) {
  try {
    if (fs.existsSync(pollerStatePath)) {
      return JSON.parse(fs.readFileSync(pollerStatePath, 'utf8'));
    }
  } catch {
    // ignore — corrupt file means we treat it as fresh
  }
  return { fingerprint: null, resolved: false };
}

function writePollerState(pollerStatePath, state) {
  fs.writeFileSync(pollerStatePath, JSON.stringify(state));
}

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// pollWordleState({ readRangeFn, token, sheetId, pollerStatePath, today? })
// → { wakeAgent: boolean, reason?: string, data?: { today, summary, all_done, needs_resolve } }
export async function pollWordleState({
  readRangeFn,
  token,
  sheetId,
  pollerStatePath,
  today = todayCT(),
} = {}) {
  if (!readRangeFn) throw new Error('readRangeFn required');
  if (!sheetId) throw new Error('sheetId required');
  if (!pollerStatePath) throw new Error('pollerStatePath required');

  let rows;
  try {
    rows = await readRangeFn(sheetId, 'Wordle State', { token });
  } catch (err) {
    return { wakeAgent: false, reason: 'error', error: String(err.message || err).slice(0, 200) };
  }
  if (!Array.isArray(rows) || rows.length <= 1) {
    return { wakeAgent: false, reason: 'no_state_rows' };
  }

  const headers = rows[0];
  const dateIdx = headers.indexOf('date');
  const playerIdx = headers.indexOf('player');
  const solvedIdx = headers.indexOf('solved');
  if (dateIdx < 0 || playerIdx < 0) {
    return { wakeAgent: false, reason: 'bad_headers' };
  }

  const todayRows = rows.slice(1).filter((r) => r[dateIdx] === today);

  const summary = {};
  for (const p of PLAYERS) {
    const playerRows = todayRows.filter(
      (r) => String(r[playerIdx] || '').toLowerCase() === p.toLowerCase(),
    );
    const guessCount = playerRows.length;
    const solved = playerRows.some(
      (r) => String(r[solvedIdx]).toLowerCase() === 'true',
    );
    summary[p] = { guesses: guessCount, solved, done: solved || guessCount >= 6 };
  }

  const allDone = PLAYERS.every((p) => summary[p].done);
  const fingerprint = computeFingerprint(today, summary);
  const prev = readPollerState(pollerStatePath);
  const stateChanged = prev.fingerprint !== fingerprint;
  const needsResolve = allDone && !prev.resolved;

  if (!stateChanged && !needsResolve) {
    return { wakeAgent: false, reason: 'no_change' };
  }

  writePollerState(pollerStatePath, {
    fingerprint,
    resolved: prev.resolved || needsResolve,
    last_poll: new Date().toISOString(),
  });

  return {
    wakeAgent: true,
    data: { today, summary, all_done: allDone, needs_resolve: needsResolve },
  };
}
