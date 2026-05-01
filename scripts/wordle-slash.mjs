#!/usr/bin/env node
// wordle-slash.mjs — host-side Wordle scorer for the /wordle Discord slash command.
//
// Invoked as a subprocess by src/channels/discord.ts. Reuses
// scoreGuessForPlayer() from groups/global/scripts/score-guess.mjs, but
// sets Google OAuth paths to the host-local copies and points the wordlist
// loader at the guesser's group folder.
//
// Usage:
//   node scripts/wordle-slash.mjs <player> <guess> <group_folder>
//
// Example:
//   node scripts/wordle-slash.mjs Paden CAMPS discord_family-fun
//
// Emits one JSON line on stdout. See score-guess.mjs for the shape.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Route sheets.mjs at the host-local OAuth artifacts before importing anything
// that calls getAccessToken() — the module reads these env vars at call time.
process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const { scoreGuessForPlayer } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'score-guess.mjs')
);
const { appendRows, readRange, getAccessToken } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
);

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
// The pinned card lives in #family-fun regardless of where the slash was invoked.
// Today /wordle is family-fun-only so this matches interaction.channelId in
// practice, but pin to the constant so future DM-invoked guesses still update
// the public card.
const SAGA_WORDLE_CHANNEL = 'dc:1490924818869260328';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function nowChicagoIso() {
  // Audit timestamps match the conventions used elsewhere: local CT with offset.
  const d = new Date();
  const y = d.toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).replace(' ', 'T');
  // sv-SE gives "YYYY-MM-DD HH:MM:SS" — add Chicago offset best-effort.
  // We don't resolve DST here; it's an audit trail, exact offset isn't load-bearing.
  return y;
}

async function appendSubmission({ player, userId, guess, gameChannel, token }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const ts = nowChicagoIso();
  await appendRows(
    PORTILLO_GAMES_SHEET,
    'Wordle Submissions!A:F',
    [[ts, today, userId || '', player, guess.toUpperCase(), gameChannel || '']],
    { token },
  );
}

// Read the family-fun saga state to learn the current day number and genre.
// Falls back gracefully — if the file is missing or corrupt, return defaults
// so the card still renders.
function readSagaState(groupFolder) {
  try {
    const sagaPath = path.join(ROOT, 'groups', groupFolder, 'saga_state.json');
    const raw = JSON.parse(fs.readFileSync(sagaPath, 'utf8'));
    return { day: raw.day ?? null, genre: raw.genre ?? null };
  } catch {
    return { day: null, genre: null };
  }
}

function readLeaderboard(groupFolder) {
  try {
    const lbPath = path.join(ROOT, 'groups', groupFolder, 'wordle_leaderboard.json');
    return JSON.parse(fs.readFileSync(lbPath, 'utf8'));
  } catch {
    return null;
  }
}

// runWordleHook — after a guess is recorded, gate-check the sheet state and:
//   - if state changed mid-game, drop a templated wordle_card update IPC
//   - if all 3 players are now done and reveal hasn't fired, drop a
//     schedule_task IPC for the agent to author the saga reveal
//   - if no change, do nothing
//
// Returns a structured result for tests / logging. Never throws — wraps every
// failure in an { ok: false, reason } object so the caller's primary
// scoring reply isn't affected.
export async function runWordleHook({
  groupFolder,
  token,
  // Injectable deps for tests:
  pollFn,
  cardBuilder,
  writeIpcMessageFn,
  writeIpcTaskFn,
  sagaStateLoader,
  leaderboardLoader,
  pollerStatePath,
  sheetId = PORTILLO_GAMES_SHEET,
  channelJid = SAGA_WORDLE_CHANNEL,
} = {}) {
  if (!groupFolder) return { ok: false, reason: 'missing_group_folder' };

  // Resolve injectable deps — pull from sibling group scripts on first call.
  if (!pollFn || !cardBuilder) {
    const pollMod = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'wordle_poll.mjs')
    );
    const cardMod = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'wordle_card.mjs')
    );
    pollFn = pollFn || pollMod.pollWordleState;
    cardBuilder = cardBuilder || cardMod.buildWordleCardText;
    if (!writeIpcMessageFn || !writeIpcTaskFn) {
      // Compiled-only path: tsc emits to dist/. The slash command runs as a
      // subprocess after `npm run build`, so this matches deployed shape.
      const ipcMod = await import(path.join(ROOT, 'dist', 'ipc-writer.js'));
      writeIpcMessageFn = writeIpcMessageFn || ipcMod.writeIpcMessage;
      writeIpcTaskFn = writeIpcTaskFn || ipcMod.writeIpcTask;
    }
  }

  const statePath =
    pollerStatePath ||
    path.join(ROOT, 'groups', groupFolder, 'wordle_poller_state.json');
  const loadSaga = sagaStateLoader || (() => readSagaState(groupFolder));
  const loadLeaderboard = leaderboardLoader || (() => readLeaderboard(groupFolder));

  let poll;
  try {
    poll = await pollFn({
      readRangeFn: readRange,
      token,
      sheetId,
      pollerStatePath: statePath,
    });
  } catch (err) {
    return { ok: false, reason: 'poll_threw', error: String(err.message || err) };
  }
  if (!poll || !poll.wakeAgent) {
    return { ok: true, action: 'noop', reason: poll?.reason };
  }

  const { needs_resolve: needsResolve, summary, today } = poll.data;
  const { day, genre } = loadSaga();

  if (needsResolve) {
    // All three players done — fire the agent to author the saga reveal.
    const { WORDLE_REVEAL_PROMPT } = await import(
      path.join(ROOT, 'groups', groupFolder, 'scripts', 'wordle_poll.mjs')
    );
    try {
      await writeIpcTaskFn(groupFolder, {
        type: 'schedule_task',
        prompt: WORDLE_REVEAL_PROMPT,
        targetJid: channelJid,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 5000).toISOString(),
      });
      return { ok: true, action: 'scheduled_reveal', today };
    } catch (err) {
      return { ok: false, reason: 'schedule_task_failed', error: String(err.message || err) };
    }
  }

  // Mid-game state change — update the pinned card directly, no agent.
  const leaderboard = loadLeaderboard();
  const cardText = cardBuilder({
    summary,
    day,
    genre,
    leaderboard,
    dateStr: today,
  });
  try {
    await writeIpcMessageFn(groupFolder, {
      type: 'message',
      chatJid: channelJid,
      label: 'wordle_card',
      pin: true,
      upsert: true,
      text: cardText,
    });
    return { ok: true, action: 'updated_card', today };
  } catch (err) {
    return { ok: false, reason: 'write_card_failed', error: String(err.message || err) };
  }
}

async function main() {
  const [, , player, guess, groupFolder, userId, gameChannel] = process.argv;
  if (!player || !guess || !groupFolder) {
    process.stderr.write('usage: wordle-slash.mjs <player> <guess> <group_folder> [user_id] [game_channel]\n');
    process.exit(2);
  }

  // Per-group wordlists are symlinks into /workspace/... which only resolves
  // inside the container. Resolve symlinks; if the target is missing, fall
  // back to the canonical host path in groups/global/scripts/.
  let wordlistPath = path.join(ROOT, 'groups', groupFolder, 'wordle_wordlist.txt');
  try {
    wordlistPath = fs.realpathSync(wordlistPath);
  } catch {
    wordlistPath = '';
  }
  if (!wordlistPath || !fs.existsSync(wordlistPath)) {
    wordlistPath = path.join(ROOT, 'groups', 'global', 'scripts', 'wordle_wordlist.txt');
  }
  if (!fs.existsSync(wordlistPath)) {
    emit({ ok: false, status: 'error', message: `wordlist not found at ${wordlistPath}` });
    return;
  }

  const wordlist = new Set(
    fs.readFileSync(wordlistPath, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  const result = await scoreGuessForPlayer(player, guess, {
    wordlistLoader: () => wordlist,
  });

  // Audit append: on solve, or when budget exhausts unsolved. Script's own
  // Wordle State row is already written; this secondary tab is the cross-channel
  // submission log the family-fun flow reads.
  let hookToken = null;
  if (result.ok && result.status === 'scored') {
    const budgetHit = !result.solved && result.guess_num >= result.budget;
    if (result.solved || budgetHit) {
      try {
        hookToken = await getAccessToken();
        await appendSubmission({
          player,
          userId,
          guess,
          gameChannel,
          token: hookToken,
        });
      } catch (err) {
        // Don't fail the whole turn — the user's primary score row already
        // landed in Wordle State. Surface the audit gap in the JSON so the
        // caller can log it.
        result.submission_audit_error = err.message;
      }
    }
  }

  // Event-driven Wordle hook: poll the sheet state and either update the
  // pinned card directly (no agent) or schedule the saga reveal (agent).
  // Replaces the every-2-min cron poller. Wrapped in try/catch — the user's
  // scoring reply must never fail because of hook errors.
  if (result.ok && result.status === 'scored') {
    try {
      const hookResult = await runWordleHook({
        groupFolder,
        token: hookToken,
      });
      if (!hookResult.ok) {
        result.wordle_hook_error = hookResult.reason || 'unknown';
      } else if (hookResult.action && hookResult.action !== 'noop') {
        result.wordle_hook_action = hookResult.action;
      }
    } catch (err) {
      result.wordle_hook_error = err.message;
    }
  }

  emit(result);
}

// Only run as CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    emit({ ok: false, status: 'error', message: err.message, stack: err.stack });
    process.exit(1);
  });
}
