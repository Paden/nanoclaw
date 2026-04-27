#!/usr/bin/env node
// resolve-day.mjs — resolve today's Saga Wordle.
//
// Reads Wordle Today + Wordle State + Cheat Log from Portillo Games,
// plus Pets from Silverthorne. Determines winner, computes XP stakes
// AND wordle HP deltas, then writes both to Pet Log + updates
// Pets.health (host-side) — unless a cheat review is pending.
//
// Returns JSON: { status, winner, word, entries, writes, hp_writes,
//                 transitions, stakes_held, reason }
//
// status: "resolved" | "stakes_held" | "no_puzzle"
//
// Pure logic lives in /workspace/global/scripts/lib/wordle.mjs.

import {
  getAccessToken,
  readRange,
  appendRows,
  updateRange,
} from '../../global/scripts/lib/sheets.mjs';
import {
  determineWinner,
  computeDayStakes,
  computeWordleHpDelta,
} from '../../global/scripts/lib/wordle.mjs';
import { PETS_COL, nowTsChicago } from '../../global/scripts/lib/pets-schema.mjs';

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { player: 'Paden', pet: 'Voss' },
  { player: 'Brenda', pet: 'Nyx' },
  { player: 'Danny', pet: 'Zima' },
];

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function clamp(lo, x, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function classifyTransition({ prev, next, max }) {
  // 0 / 20% / 40% bands. Death takes priority.
  if (next <= 0 && prev > 0) return 'died';
  // Pets at or below 0 don't generate transitions on heals — revival
  // is its own event, handled elsewhere. Prevents a phantom "recovered"
  // when a deceased pet's row is touched.
  if (prev <= 0) return null;
  const critThresh = 0.2 * max;
  const recoverThresh = 0.4 * max;
  if (prev > critThresh && next <= critThresh && next > 0) return 'entered_critical';
  if (prev <= recoverThresh && next > recoverThresh) return 'recovered';
  return null;
}

export async function resolveDay(deps = {}) {
  const {
    readRangeFn = readRange,
    appendRowsFn = appendRows,
    updateRangeFn = updateRange,
    today = todayCT(),
    now = nowTsChicago(),
    token: providedToken,
  } = deps;

  const token = providedToken ?? (await getAccessToken());

  // 1. Today's puzzle
  const todayRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Wordle Today!A2:C100', { token });
  const row = (todayRows || []).find((r) => r[0] === today);
  if (!row) {
    return { ok: false, status: 'no_puzzle', message: "Today's puzzle not published." };
  }
  const word = (row[1] || '').toLowerCase();
  let budgets = {};
  try {
    budgets = JSON.parse(row[2] || '{}');
  } catch {
    /* ignore */
  }

  // 2. Wordle State (all players' guesses today)
  const stateRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Wordle State!A2:F10000', { token });
  const todays = (stateRows || []).filter((r) => r[0] === today);

  // 3. Cheat Log (pending reviews today)
  let cheatRows = [];
  try {
    cheatRows = await readRangeFn(PORTILLO_GAMES_SHEET, 'Cheat Log!A2:I10000', { token });
  } catch {
    /* optional */
  }
  const pending = (cheatRows || []).filter(
    (r) => r[1] === today && String(r[6] || '').toLowerCase() === 'pending_review',
  );

  // 4. Pets (Silverthorne) — needed for HP deltas
  const petsRows = await readRangeFn(SILVERTHORNE_SHEET, 'Pets!A2:P10000', { token });
  const petsByOwner = new Map();
  (petsRows || []).forEach((r, i) => {
    const owner = String(r[PETS_COL.owner] || '').toLowerCase();
    if (owner) petsByOwner.set(owner, { row: r, rowNum: i + 2 });
  });

  // 5. Build per-player entries (existing logic, unchanged)
  const entries = PLAYERS.map(({ player, pet }) => {
    const mine = todays
      .filter((r) => String(r[1]).toLowerCase() === player.toLowerCase())
      .sort((a, b) => Number(a[2]) - Number(b[2]));
    const solvedRow = mine.find((r) => String(r[5]).toLowerCase() === 'true');
    const budget = budgets[player] || 6;
    const played = mine.length > 0;
    const solved = !!solvedRow;
    const guesses = mine.length;
    const solvedRowIndex = solvedRow ? todays.indexOf(solvedRow) : Number.MAX_SAFE_INTEGER;
    return {
      player, pet, played, solved, guesses, budget,
      solved_row_index: solvedRowIndex,
      solved_at: solvedRow ? `${today} guess${solvedRow[2]}` : null,
    };
  });

  const winner = determineWinner(entries);
  const writes = computeDayStakes({ entries, winner, word });

  // 6. Compute HP deltas (skip deceased pets and missing pet rows)
  const hp_writes = [];
  const transitions = [];
  for (const entry of entries) {
    const petInfo = petsByOwner.get(entry.player.toLowerCase());
    if (!petInfo) continue;
    const status = String(petInfo.row[PETS_COL.status] || 'alive').toLowerCase();
    if (status === 'deceased') continue;

    const stage_index = parseInt(petInfo.row[PETS_COL.stage_index], 10) || 0;
    const cur_health = parseInt(petInfo.row[PETS_COL.health], 10) || 0;
    const max_health = parseInt(petInfo.row[PETS_COL.max_health], 10) || 100;

    const delta = computeWordleHpDelta({ entry, winner, stage_index });
    if (!delta) continue; // Egg-stage returns null

    const new_health = clamp(0, cur_health + delta.delta, max_health);

    // Reason text mirrors XP rows for grep-ability
    let reason;
    if (entry.player === winner) reason = `Saga Wordle win — ${word}`;
    else if (entry.solved) reason = `Saga Wordle solve — ${word}`;
    else if (entry.played) reason = `Saga Wordle — failed to solve ${word}`;
    else reason = 'Saga Wordle — did not play';

    hp_writes.push({
      player: entry.player,
      pet: entry.pet,
      event_type: delta.event_type,
      delta: delta.delta,
      reason,
      prev_health: cur_health,
      new_health,
      max_health,
      rowNum: petInfo.rowNum,
    });

    const transition = classifyTransition({
      prev: cur_health, next: new_health, max: max_health,
    });
    if (transition) {
      transitions.push({
        player: entry.player, pet: entry.pet, kind: transition,
        new_health, max_health,
      });
    }
  }

  // 7. Hold stakes if any cheat is pending review — no XP, no HP writes
  if (pending.length > 0) {
    return {
      ok: true,
      status: 'stakes_held',
      winner, word, entries, writes,
      hp_writes: hp_writes.map(({ rowNum: _r, ...rest }) => rest),
      transitions,
      stakes_held: true,
      pending_suspects: pending.map((r) => r[2]),
      reason: 'cheat review pending',
    };
  }

  // 8. Write XP rows (existing behavior)
  if (writes.length > 0) {
    const rowsToAppend = writes.map((w) => [
      now, today, w.pet, w.event_type, String(w.delta), w.reason,
    ]);
    await appendRowsFn(SILVERTHORNE_SHEET, 'Pet Log!A:F', rowsToAppend, { token });
  }

  // 9. Write HP rows + update Pets.health cells
  if (hp_writes.length > 0) {
    const hpRowsToAppend = hp_writes.map((w) => [
      now, today, w.pet, w.event_type, String(w.delta), w.reason,
    ]);
    await appendRowsFn(SILVERTHORNE_SHEET, 'Pet Log!A:F', hpRowsToAppend, { token });

    for (const w of hp_writes) {
      await updateRangeFn(
        SILVERTHORNE_SHEET,
        `Pets!H${w.rowNum}`,
        [[String(w.new_health)]],
        { token },
      );
    }
  }

  return {
    ok: true,
    status: 'resolved',
    winner, word, entries, writes,
    hp_writes: hp_writes.map(({ rowNum: _r, ...rest }) => rest),
    transitions,
    stakes_held: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveDay()
    .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
    .catch((err) => {
      process.stdout.write(
        JSON.stringify({ ok: false, status: 'error', message: err.message }) + '\n',
      );
      process.exit(1);
    });
}
