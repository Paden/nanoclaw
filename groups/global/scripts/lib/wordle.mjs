// Pure functions for Saga Wordle scoring + tier math.
//
// No I/O — fully unit-testable. Scripts in family-fun and dms import these
// for the deterministic logic and handle the I/O themselves.

/**
 * Compute the tier + guess budget for a given lifetime XP value.
 */
export function tierForXp(lifetimeXp) {
  if (lifetimeXp >= 3000) return { tier: 'Apex', guesses: 4 };
  if (lifetimeXp >= 1500) return { tier: 'Adept', guesses: 5 };
  if (lifetimeXp >= 500) return { tier: 'Fledgling', guesses: 6 };
  return { tier: 'Hatchling', guesses: 7 };
}

/**
 * Sum lifetime XP from Pet Log rows for a given pet name.
 *
 * `petLogRows` is an array of arrays as returned from sheets:
 *   [timestamp, date, pet, event_type, delta, reason, ...]
 *
 * We only count `xp_gain` events — decay/loss never reduces lifetime XP,
 * so dying is a soft reset to easier mode rather than double punishment.
 */
export function lifetimeXp(petLogRows, petName) {
  let total = 0;
  for (const row of petLogRows) {
    const [, , pet, eventType, delta] = row;
    if (pet !== petName) continue;
    if (eventType !== 'xp_gain') continue;
    const n = Number(delta);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;
  }
  return total;
}

/**
 * Score a Wordle guess against the answer. Handles duplicate letters
 * correctly: a yellow only fires for letters not already accounted for
 * by greens.
 *
 * Returns the 5-emoji grid string. Inputs are case-insensitive.
 */
export function scoreGuess(guess, answer) {
  if (guess.length !== answer.length) {
    throw new Error(`Guess length ${guess.length} != answer length ${answer.length}`);
  }
  const g = guess.toLowerCase().split('');
  const a = answer.toLowerCase().split('');
  const result = new Array(g.length).fill('⬜');
  const remaining = {};

  // First pass: greens
  for (let i = 0; i < g.length; i++) {
    if (g[i] === a[i]) {
      result[i] = '🟩';
    } else {
      remaining[a[i]] = (remaining[a[i]] || 0) + 1;
    }
  }
  // Second pass: yellows (only consume from remaining counts)
  for (let i = 0; i < g.length; i++) {
    if (result[i] === '🟩') continue;
    if (remaining[g[i]] > 0) {
      result[i] = '🟨';
      remaining[g[i]]--;
    }
  }
  return result.join('');
}

/**
 * Validate a guess shape. Does not check the wordlist — caller does that.
 */
export function isValidGuessShape(guess, length) {
  if (typeof guess !== 'string') return false;
  if (guess.length !== length) return false;
  return /^[a-zA-Z]+$/.test(guess);
}

/**
 * Determine the winner of the day. Entries:
 *   [{ player, guesses, solved, solved_row_index?, solved_at? }]
 * Rules: fewest guesses among solvers wins. Tie → earliest solved_row_index
 * (append order in Wordle State, which reflects real submission order), then
 * solved_at as a fallback. Nobody solved → null. Disqualified players should
 * be filtered out before calling.
 */
export function determineWinner(entries) {
  const solvers = entries.filter((e) => e.solved);
  if (solvers.length === 0) return null;
  solvers.sort((a, b) => {
    if (a.guesses !== b.guesses) return a.guesses - b.guesses;
    const ia = Number.isFinite(a.solved_row_index) ? a.solved_row_index : Number.MAX_SAFE_INTEGER;
    const ib = Number.isFinite(b.solved_row_index) ? b.solved_row_index : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    const ta = a.solved_at || '';
    const tb = b.solved_at || '';
    return ta.localeCompare(tb);
  });
  return solvers[0].player;
}

/**
 * Compute Pet Log event rows to write for a resolved day.
 * Returns array of `{ player, pet, event_type, delta, reason }`.
 *
 *  - winner: +20 xp_gain
 *  - solved non-winner: nothing
 *  - failed or no-show: -10 decay
 */
export function computeDayStakes({ entries, winner, word }) {
  const writes = [];
  for (const e of entries) {
    if (e.player === winner) {
      writes.push({
        player: e.player,
        pet: e.pet,
        event_type: 'xp_gain',
        delta: 20,
        reason: `Saga Wordle win — ${word}`,
      });
    } else if (!e.solved) {
      writes.push({
        player: e.player,
        pet: e.pet,
        event_type: 'decay',
        delta: -10,
        reason: e.played ? 'Saga Wordle — failed to solve' : 'Saga Wordle — did not play',
      });
    }
  }
  return writes;
}

/**
 * Render the pinned wordle_card. Pure function.
 *
 * state = {
 *   day, date, genre, word, resolved,
 *   players: [{ player, pet, petEmoji, guessCount, solved, budget, grids? }],
 *   leaderboard: { [player]: { wins, streak, best, avg } },
 *   lastChapterOpening,
 * }
 */
export function renderCard(state) {
  const lines = [];
  lines.push(`🎯 SAGA WORDLE — Day ${state.day}`);
  lines.push(`${state.date} · Genre: ${state.genre}`);
  lines.push('');
  for (const p of state.players) {
    const status = state.resolved
      ? p.solved
        ? `solved in ${p.guessCount}/${p.budget}`
        : `failed (${p.guessCount}/${p.budget})`
      : p.guessCount === 0
        ? 'not started'
        : `${p.guessCount}/${p.budget} guesses`;
    lines.push(`  ${p.player.padEnd(7)} ${p.petEmoji} ${p.pet.padEnd(6)} ${status}`);
  }
  lines.push('');
  lines.push('─────────────────');
  lines.push('🏆 All-time');
  for (const p of state.players) {
    const lb = state.leaderboard?.[p.player];
    if (!lb) continue;
    lines.push(
      `  ${p.player}: ${lb.wins}W · 🔥 ${lb.streak} · best ${lb.best} · ${lb.avg} avg`,
    );
  }
  if (state.lastChapterOpening) {
    lines.push('');
    lines.push('─────────────────');
    lines.push(`📖 _"${state.lastChapterOpening}"_`);
  }
  return lines.join('\n');
}

/**
 * Map pet stage_index (0..14) to Saga Wordle guess budget.
 *
 * Smoothed bands: stages within a band share a budget. Replaces the
 * old XP-based `tierForXp` once compute-tiers switches over. See
 * docs/superpowers/specs/2026-04-26-wordle-difficulty-and-hp-design.md.
 */
export function stageToBudget(stage_index) {
  if (stage_index >= 12) return 2;
  if (stage_index >= 8) return 3;
  if (stage_index >= 6) return 4;
  if (stage_index >= 4) return 5;
  if (stage_index >= 2) return 6;
  return 7;
}

/**
 * Compute the wordle HP delta for one player on one day.
 *
 * Returns null at stage 0 (Egg = inert per chore_pet_spec). Otherwise
 * returns { event_type, delta } where event_type is 'wordle_heal' or
 * 'wordle_damage' and delta is the integer HP change to apply.
 *
 * Outcome derived from entry shape:
 *   entry.player === winner    → won
 *   entry.solved && !winner-of  → solved (non-winner)
 *   entry.played && !entry.solved → failed
 *   !entry.played              → no_show
 */
export function computeWordleHpDelta({ entry, winner, stage_index }) {
  if (stage_index === 0) return null;
  if (entry.player === winner) {
    return { event_type: 'wordle_heal', delta: 5 + Math.floor(stage_index / 2) };
  }
  if (entry.solved) {
    return { event_type: 'wordle_heal', delta: 2 + Math.floor(stage_index / 4) };
  }
  if (entry.played) {
    return { event_type: 'wordle_damage', delta: -(5 + stage_index) };
  }
  return { event_type: 'wordle_damage', delta: -(8 + stage_index) };
}
