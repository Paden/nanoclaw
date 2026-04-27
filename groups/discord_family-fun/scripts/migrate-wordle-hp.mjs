#!/usr/bin/env node
// migrate-wordle-hp.mjs — ONE-SHOT rollout of the Saga Wordle HP system.
//
// Run-once during rollout. Re-running is DESTRUCTIVE: it resets every pet's
// current health to its stage's max, erasing any in-flight damage from
// gameplay. The script refuses to run if max_health is already populated
// for all rows; pass --force to override (use only for re-rollout / dev).
//
// Steps:
//   1. Reads Pets!A2:P10000 (Silverthorne).
//   2. For each pet, computes max_health = 100 + 20 × stage_index.
//   3. Writes max_health to column P, resets health to max_health (column H).
//   4. Appends a 'revival' row to Pet Log per pet noting the rollout.
//   5. Prints a Claudio-voiced announcement prompt to stdout for the
//      operator to relay to #family-fun.
//
// Run: node groups/discord_family-fun/scripts/migrate-wordle-hp.mjs [--force]
//
// Pre-req: column P "max_health" header must be present on the Pets tab.

import {
  getAccessToken,
  readRange,
  appendRows,
  updateRange,
} from '../../global/scripts/lib/sheets.mjs';

const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';

const COL = { owner: 0, stage_index: 4, health: 7, max_health: 15 };

function nowTs() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}:${g.second}`;
}

const ANNOUNCEMENT_PROMPT = `Post this announcement to #family-fun in your voice. Keep the rules verbatim — they are the canonical mechanics. Add a short, characteristic Claudio intro and outro (snarky, dramatic, warm).

CANONICAL RULES TEXT (do not paraphrase):

🎯 SAGA WORDLE — NEW RULES (effective today)

Your guess budget now follows YOUR PET'S STAGE, not lifetime XP:
  • Egg / Hatchling   → 7 guesses
  • Critter / Beast   → 6 guesses
  • Spirit / Elemental → 5 guesses
  • Chimera / Wyrm    → 4 guesses
  • Celestial → Deity → 3 guesses
  • Pantheon / Concept / Source → 2 guesses (the endgame)

Wordle now affects PET HEALTH:
  • Win the day      → +HP (scales with stage)
  • Solve, didn't win → small +HP
  • Played, failed   → −HP (scales with stage)
  • No-show          → bigger −HP

Higher stages mean bigger HP totals AND bigger swings. A Wyrm losing a Wordle hurts more than a Hatchling losing — but a Wyrm has more HP to lose.

Every evolution: max HP +20, current HP +20. Pets grow.

Today: everyone's HP is reset to their stage's max — fresh start.

Critical (≤20% HP) and death (0 HP) rules from #silverthorne now apply to wordle damage too. Don't no-show.`;

export async function migrate({
  readRangeFn = readRange,
  appendRowsFn = appendRows,
  updateRangeFn = updateRange,
  token: providedToken,
  force = false,
} = {}) {
  const token = providedToken ?? (await getAccessToken());
  const rows = await readRangeFn(SILVERTHORNE_SHEET, 'Pets!A2:P10000', { token });
  const now = nowTs();

  // Safety: if every non-empty pet row already has a max_health value, the
  // migration has already run. Refuse unless force=true to prevent silent
  // destructive resets of mid-game HP.
  const populated = (rows || [])
    .filter((r) => String(r[COL.owner] || '').trim())
    .map((r) => String(r[COL.max_health] || '').trim());
  if (!force && populated.length > 0 && populated.every((v) => v !== '')) {
    throw new Error(
      'migrate-wordle-hp: max_health is already populated for all pets — ' +
        'this would silently reset current HP. Pass --force to override.',
    );
  }

  const updates = [];
  const logRows = [];

  (rows || []).forEach((r, i) => {
    const owner = String(r[COL.owner] || '').trim();
    if (!owner) return;
    const stage_index = parseInt(r[COL.stage_index], 10) || 0;
    const max_health = 100 + 20 * stage_index;
    const rowNum = i + 2;

    updates.push({ rowNum, owner, max_health });
    // We append to Pet Log indexed by the pet name. The Pet Log uses the
    // pet's NAME (column B of Pets), not owner. Look it up from the row.
    const petName = String(r[1] || owner);
    logRows.push([
      now, petName, 'revival', String(max_health),
      'Saga Wordle HP system rollout — restored to stage max', '',
    ]);
  });

  // Write updates one cell at a time (column H + column P) to mirror award_xp.mjs.
  for (const u of updates) {
    await updateRangeFn(
      SILVERTHORNE_SHEET,
      `Pets!H${u.rowNum}`,
      [[String(u.max_health)]],
      { token },
    );
    await updateRangeFn(
      SILVERTHORNE_SHEET,
      `Pets!P${u.rowNum}`,
      [[String(u.max_health)]],
      { token },
    );
  }

  if (logRows.length > 0) {
    await appendRowsFn(SILVERTHORNE_SHEET, 'Pet Log!A:F', logRows, { token });
  }

  return { updates, logRows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force');
  migrate({ force })
    .then((result) => {
      process.stdout.write(`\n✅ Migration complete: ${result.updates.length} pet(s) updated.\n\n`);
      for (const u of result.updates) {
        process.stdout.write(`  • ${u.owner.padEnd(8)} max_health=${u.max_health}, health=${u.max_health}\n`);
      }
      process.stdout.write('\n— — — — — — — — — — — — — — — — — — — — — —\n');
      process.stdout.write('NEXT: paste this prompt into #family-fun (or send via claw):\n');
      process.stdout.write('— — — — — — — — — — — — — — — — — — — — — —\n\n');
      process.stdout.write(ANNOUNCEMENT_PROMPT + '\n');
    })
    .catch((err) => {
      process.stderr.write(`migrate-wordle-hp failed: ${err.message}\n`);
      process.exit(1);
    });
}
