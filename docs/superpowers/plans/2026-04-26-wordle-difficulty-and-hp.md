# Wordle Stage-Driven Difficulty + HP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lifetime-XP guess-budget tiers with a function of pet `stage_index`, and feed Wordle outcomes back into the existing `Pets.health` column with stage-scaled deltas. Extend pet stages beyond Deity (+3) and bump max HP on evolution.

**Architecture:** Pure logic in `groups/global/scripts/lib/wordle.mjs`. Two scripts call it: `compute-tiers.mjs` at start-of-day, `resolve-day.mjs` at end-of-day. `award_xp.mjs` (Silverthorne) gets the extended stage table and applies the evolution HP bump. A one-shot migration script seeds `max_health` and resets everyone to fresh max HP.

**Tech Stack:** Node.js (`*.mjs`), vitest, Google Sheets v4 via `groups/global/scripts/lib/sheets.mjs`.

**Spec:** `docs/superpowers/specs/2026-04-26-wordle-difficulty-and-hp-design.md`

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `groups/global/scripts/lib/wordle.mjs` | modify | Pure logic: add `stageToBudget`, `computeWordleHpDelta`. Remove `tierForXp`, `lifetimeXp` (dead after compute-tiers switches over). |
| `groups/global/scripts/lib/wordle.test.mjs` | modify | Add tests for new functions; drop tests for removed functions. |
| `groups/discord_family-fun/scripts/compute-tiers.mjs` | modify | Read `Pets!A2:P10000`; call `stageToBudget(stage_index)` per player. |
| `groups/discord_family-fun/scripts/compute-tiers.test.mjs` | modify | Mock Pets-tab rows instead of Pet Log XP rows. |
| `groups/discord_family-fun/scripts/resolve-day.mjs` | modify | After XP writes, compute HP deltas, write `wordle_heal`/`wordle_damage` rows to Pet Log AND update `Pets.health` directly. Detect critical/recovered/death transitions. |
| `groups/discord_family-fun/scripts/resolve-day.test.mjs` | modify | Add fixture covering won/solved/failed/no_show outcomes; assert HP rows + transition flags. |
| `groups/discord_silverthorne/award_xp.mjs` | modify | Extend `STAGES` to 15. On `evolved`: `max_health += 20`, `health += 20`. Read `Pets!A1:P100`. |
| `groups/discord_family-fun/scripts/migrate-wordle-hp.mjs` | create | One-shot: backfill `max_health = 100 + 20×stage_index`, reset `health = max_health`, append Pet Log rollout rows, print Claudio-prompt for the rules announcement. |
| `groups/discord_silverthorne/chore_pet_spec.md` | modify | §2 stage table extended to 15 entries; add Max HP column; percentage-based critical thresholds. |

---

## Task 1: Add `stageToBudget` to `wordle.mjs`

**Files:**
- Modify: `groups/global/scripts/lib/wordle.mjs`
- Test: `groups/global/scripts/lib/wordle.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add this block at the top of `groups/global/scripts/lib/wordle.test.mjs` (right after the `import { ... }` line — we'll update the import in Step 3):

```js
describe('stageToBudget', () => {
  it('maps Egg and Hatchling to 7 guesses', () => {
    expect(stageToBudget(0)).toBe(7);
    expect(stageToBudget(1)).toBe(7);
  });
  it('maps Critter and Beast to 6 guesses', () => {
    expect(stageToBudget(2)).toBe(6);
    expect(stageToBudget(3)).toBe(6);
  });
  it('maps Spirit and Elemental to 5 guesses', () => {
    expect(stageToBudget(4)).toBe(5);
    expect(stageToBudget(5)).toBe(5);
  });
  it('maps Chimera and Wyrm to 4 guesses', () => {
    expect(stageToBudget(6)).toBe(4);
    expect(stageToBudget(7)).toBe(4);
  });
  it('maps Celestial through Deity to 3 guesses', () => {
    expect(stageToBudget(8)).toBe(3);
    expect(stageToBudget(9)).toBe(3);
    expect(stageToBudget(10)).toBe(3);
    expect(stageToBudget(11)).toBe(3);
  });
  it('maps Pantheon through Source to 2 guesses', () => {
    expect(stageToBudget(12)).toBe(2);
    expect(stageToBudget(13)).toBe(2);
    expect(stageToBudget(14)).toBe(2);
  });
});
```

Then update the named imports at the top of the test file to include `stageToBudget`:

```js
import {
  tierForXp,
  lifetimeXp,
  scoreGuess,
  isValidGuessShape,
  determineWinner,
  computeDayStakes,
  renderCard,
  stageToBudget,
} from './wordle.mjs';
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run groups/global/scripts/lib/wordle.test.mjs
```

Expected: FAIL — `stageToBudget` is not a function (undefined export).

- [ ] **Step 3: Add the implementation**

Append to `groups/global/scripts/lib/wordle.mjs` (at the end, after `renderCard`):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run groups/global/scripts/lib/wordle.test.mjs
```

Expected: PASS — all `stageToBudget` cases pass; existing tests still pass.

- [ ] **Step 5: Commit**

```
git add groups/global/scripts/lib/wordle.mjs groups/global/scripts/lib/wordle.test.mjs
git commit -m "feat(wordle): add stageToBudget — pet stage → guess count"
```

---

## Task 2: Add `computeWordleHpDelta` to `wordle.mjs`

**Files:**
- Modify: `groups/global/scripts/lib/wordle.mjs`
- Test: `groups/global/scripts/lib/wordle.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add this block to `groups/global/scripts/lib/wordle.test.mjs` (after the `stageToBudget` block):

```js
describe('computeWordleHpDelta', () => {
  const W = (player) => ({ player, played: true, solved: true });
  const S = (player) => ({ player, played: true, solved: true });
  const F = (player) => ({ player, played: true, solved: false });
  const N = (player) => ({ player, played: false, solved: false });

  it('returns null at Egg (stage 0) for every outcome', () => {
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
  });

  it('won (winner) heals 5 + floor(stage/2)', () => {
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_heal', delta: 5 });
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_heal', delta: 8 });
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_heal', delta: 12 });
  });

  it('solved-non-winner heals 2 + floor(stage/4)', () => {
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_heal', delta: 2 });
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_heal', delta: 3 });
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_heal', delta: 5 });
  });

  it('failed (played, did not solve) damages 5 + stage', () => {
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_damage', delta: -6 });
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_damage', delta: -12 });
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_damage', delta: -19 });
  });

  it('no-show (did not play) damages 8 + stage', () => {
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_damage', delta: -9 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_damage', delta: -15 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_damage', delta: -22 });
  });

  it('handles winner === null (nobody solved): all players who played are failed', () => {
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: null, stage_index: 5 }))
      .toEqual({ event_type: 'wordle_damage', delta: -10 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: null, stage_index: 5 }))
      .toEqual({ event_type: 'wordle_damage', delta: -13 });
  });
});
```

Update the test-file imports to include `computeWordleHpDelta`:

```js
import {
  tierForXp,
  lifetimeXp,
  scoreGuess,
  isValidGuessShape,
  determineWinner,
  computeDayStakes,
  renderCard,
  stageToBudget,
  computeWordleHpDelta,
} from './wordle.mjs';
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run groups/global/scripts/lib/wordle.test.mjs
```

Expected: FAIL — `computeWordleHpDelta` is not a function.

- [ ] **Step 3: Add the implementation**

Append to `groups/global/scripts/lib/wordle.mjs` (after `stageToBudget`):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run groups/global/scripts/lib/wordle.test.mjs
```

Expected: PASS — all `computeWordleHpDelta` cases.

- [ ] **Step 5: Commit**

```
git add groups/global/scripts/lib/wordle.mjs groups/global/scripts/lib/wordle.test.mjs
git commit -m "feat(wordle): add computeWordleHpDelta — stage-scaled HP"
```

---

## Task 3: Switch `compute-tiers.mjs` to read `Pets.stage_index`

**Files:**
- Modify: `groups/discord_family-fun/scripts/compute-tiers.mjs`
- Test: `groups/discord_family-fun/scripts/compute-tiers.test.mjs`

- [ ] **Step 1: Replace the test contents**

Overwrite `groups/discord_family-fun/scripts/compute-tiers.test.mjs` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { computeBudgets } from './compute-tiers.mjs';

// Pets tab columns A–P:
// A=owner B=name C=species D=avatar E=stage_index F=stage_name G=flavor_modifier
// H=health I=happiness J=xp K=streak_days L=last_completion_date M=status
// N=legacy_xp O=last_updated P=max_health
function petRow({ owner, stage_index }) {
  return [
    owner, '', '', '', String(stage_index), '', '',
    '', '', '', '', '', '', '', '', '',
  ];
}

describe('computeBudgets', () => {
  it('maps each player to stageToBudget(stage_index)', async () => {
    const fakeRows = [
      petRow({ owner: 'Paden', stage_index: 3 }),   // Beast → 6
      petRow({ owner: 'Brenda', stage_index: 0 }),  // Egg → 7
      petRow({ owner: 'Danny', stage_index: 7 }),   // Wyrm → 4
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    const result = await computeBudgets({ readRangeFn, token: 'fake' });
    expect(result).toEqual({ Paden: 6, Brenda: 7, Danny: 4 });
    expect(readRangeFn).toHaveBeenCalledOnce();
    const [, range] = readRangeFn.mock.calls[0];
    expect(range).toBe('Pets!A2:P10000');
  });

  it('throws a clear error if a player has no Pets row', async () => {
    const fakeRows = [
      petRow({ owner: 'Paden', stage_index: 5 }),
      // Brenda missing
      petRow({ owner: 'Danny', stage_index: 1 }),
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    await expect(computeBudgets({ readRangeFn, token: 'fake' }))
      .rejects.toThrow(/Brenda/);
  });

  it('matches owner case-insensitively', async () => {
    const fakeRows = [
      petRow({ owner: 'paden', stage_index: 12 }),  // Pantheon → 2
      petRow({ owner: 'BRENDA', stage_index: 4 }),  // Spirit → 5
      petRow({ owner: 'Danny', stage_index: 9 }),   // Eldritch → 3
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    const result = await computeBudgets({ readRangeFn, token: 'fake' });
    expect(result).toEqual({ Paden: 2, Brenda: 5, Danny: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run groups/discord_family-fun/scripts/compute-tiers.test.mjs
```

Expected: FAIL — current `compute-tiers.mjs` calls `lifetimeXp` on Pet Log rows, doesn't match the new fixtures.

- [ ] **Step 3: Replace the implementation**

Overwrite `groups/discord_family-fun/scripts/compute-tiers.mjs` with:

```js
#!/usr/bin/env node
// compute-tiers.mjs — read Silverthorne Pets tab, compute each player's
// guess budget for the day from their pet's current stage_index.
// Prints JSON to stdout: {"Paden":6,"Brenda":7,"Danny":5}
//
// Used by the 6am rollover script and the publish-today flow.

import { getAccessToken, readRange } from '../../global/scripts/lib/sheets.mjs';
import { stageToBudget } from '../../global/scripts/lib/wordle.mjs';

const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { name: 'Paden', pet: 'Voss' },
  { name: 'Brenda', pet: 'Nyx' },
  { name: 'Danny', pet: 'Zima' },
];

// Pets columns A–P. stage_index is column E (index 4).
const STAGE_INDEX_COL = 4;
const OWNER_COL = 0;

export async function computeBudgets({ readRangeFn = readRange, token } = {}) {
  const t = token ?? (await getAccessToken());
  const rows = await readRangeFn(SILVERTHORNE_SHEET, 'Pets!A2:P10000', { token: t });
  const out = {};
  for (const { name } of PLAYERS) {
    const row = (rows || []).find(
      (r) => String(r[OWNER_COL] || '').toLowerCase() === name.toLowerCase(),
    );
    if (!row) {
      throw new Error(`No Pets row for owner "${name}"`);
    }
    const stageIndex = parseInt(row[STAGE_INDEX_COL], 10) || 0;
    out[name] = stageToBudget(stageIndex);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  computeBudgets()
    .then((b) => {
      process.stdout.write(JSON.stringify(b) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`compute-tiers failed: ${err.message}\n`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run groups/discord_family-fun/scripts/compute-tiers.test.mjs
```

Expected: PASS — all 3 cases.

Run the full suite to confirm nothing else broke:

```
npm test
```

Expected: PASS — no regressions. (`wordle.test.mjs` still tests `tierForXp`/`lifetimeXp` for now; those will be removed in Task 4.)

- [ ] **Step 5: Commit**

```
git add groups/discord_family-fun/scripts/compute-tiers.mjs groups/discord_family-fun/scripts/compute-tiers.test.mjs
git commit -m "refactor(family-fun): compute-tiers reads Pets.stage_index"
```

---

## Task 4: Remove dead `tierForXp` / `lifetimeXp` from `wordle.mjs`

**Files:**
- Modify: `groups/global/scripts/lib/wordle.mjs`
- Test: `groups/global/scripts/lib/wordle.test.mjs`

- [ ] **Step 1: Confirm there are no other callers**

```
grep -rn "tierForXp\|lifetimeXp" --include="*.mjs" --include="*.ts" .
```

Expected: only references inside `groups/global/scripts/lib/wordle.mjs` and `groups/global/scripts/lib/wordle.test.mjs` (the function definitions and their tests). If any other file shows up, stop and re-evaluate.

- [ ] **Step 2: Remove the test cases**

In `groups/global/scripts/lib/wordle.test.mjs`:

Drop the `tierForXp` import and the `lifetimeXp` import:

```js
import {
  scoreGuess,
  isValidGuessShape,
  determineWinner,
  computeDayStakes,
  renderCard,
  stageToBudget,
  computeWordleHpDelta,
} from './wordle.mjs';
```

Delete the entire `describe('tierForXp', ...)` block (the one with `Hatchling/7 for new pets`, `promotes at exact thresholds`, `Apex caps at 4 guesses`).

Delete the entire `describe('lifetimeXp', ...)` block (the one with the `rows` fixture and the three `it` cases).

- [ ] **Step 3: Remove the implementations**

In `groups/global/scripts/lib/wordle.mjs`, delete the `tierForXp` function (lines starting at the JSDoc above `export function tierForXp(lifetimeXp) {` through the closing `}`) and the `lifetimeXp` function (lines starting at `export function lifetimeXp(petLogRows, petName) {` through its closing `}`).

The file should still export: `scoreGuess`, `isValidGuessShape`, `determineWinner`, `computeDayStakes`, `renderCard`, `stageToBudget`, `computeWordleHpDelta`.

- [ ] **Step 4: Run tests**

```
npm test
```

Expected: PASS — full suite green. The dropped tests are gone, the new tests still pass, no other file imported the removed functions.

- [ ] **Step 5: Commit**

```
git add groups/global/scripts/lib/wordle.mjs groups/global/scripts/lib/wordle.test.mjs
git commit -m "refactor(wordle): drop tierForXp/lifetimeXp — replaced by stageToBudget"
```

---

## Task 5: Add HP delta pass to `resolve-day.mjs`

**Files:**
- Modify: `groups/discord_family-fun/scripts/resolve-day.mjs`
- Test: `groups/discord_family-fun/scripts/resolve-day.test.mjs`

This task does the most work: read pet stages + health + max_health, compute HP deltas, write Pet Log rows AND update the `health` cell, detect critical/recovered/death transitions, and skip deceased pets.

- [ ] **Step 1: Update the test fixture builder + add new assertions**

Overwrite `groups/discord_family-fun/scripts/resolve-day.test.mjs` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { resolveDay } from './resolve-day.mjs';

const TODAY = '2026-04-07';

// Pets columns A–P (16 cols).
// A=owner B=name C=species D=avatar E=stage_index F=stage_name G=flavor_modifier
// H=health I=happiness J=xp K=streak_days L=last_completion_date M=status
// N=legacy_xp O=last_updated P=max_health
function petRow({ owner, stage_index, health, max_health, status = 'alive', rowNum }) {
  const r = new Array(16).fill('');
  r[0] = owner;
  r[4] = String(stage_index);
  r[7] = String(health);
  r[12] = status;
  r[15] = String(max_health);
  r._rowNum = rowNum; // not part of sheet, but handy for asserting writes
  return r;
}

function makeDeps({ todayRows, stateRows, petsRows, cheatRows = [] }) {
  const appendRowsFn = vi.fn().mockResolvedValue({});
  const updateRangeFn = vi.fn().mockResolvedValue({});
  const readRangeFn = vi.fn().mockImplementation(async (_sheet, range) => {
    if (range.startsWith('Wordle Today')) return todayRows;
    if (range.startsWith('Wordle State')) return stateRows;
    if (range.startsWith('Cheat Log')) return cheatRows;
    if (range.startsWith('Pets!')) return petsRows;
    return [];
  });
  return {
    readRangeFn,
    appendRowsFn,
    updateRangeFn,
    token: 'fake',
    today: TODAY,
    now: '2026-04-07 18:00:00',
  };
}

describe('resolveDay', () => {
  it('writes XP rows + HP rows, updates Pets.health, and reports transitions', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    // Paden won (1 guess). Brenda solved on guess 2 (non-winner). Danny no-show.
    const stateRows = [
      [TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
      [TODAY, 'Brenda', '1', 'SLATE', '⬜⬜🟨⬜🟨', 'false'],
      [TODAY, 'Brenda', '2', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 5, health: 60, max_health: 200 }), // Spirit-ish, bigger pool
      petRow({ owner: 'Brenda', stage_index: 1, health: 30, max_health: 120 }), // Hatchling, near critical
      petRow({ owner: 'Danny',  stage_index: 7, health: 50, max_health: 240 }), // Wyrm
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('resolved');
    expect(result.winner).toBe('Paden');

    // Existing XP writes preserved (winner +20, no-show -10)
    expect(result.writes).toEqual([
      { player: 'Paden', pet: 'Voss', event_type: 'xp_gain', delta: 20, reason: 'Saga Wordle win — crane' },
      { player: 'Danny', pet: 'Zima', event_type: 'decay', delta: -10, reason: 'Saga Wordle — did not play' },
    ]);

    // HP writes: Paden won (+5+floor(5/2)=+7), Brenda solved (+2+floor(1/4)=+2), Danny no-show (−(8+7)=−15)
    expect(result.hp_writes).toEqual([
      { player: 'Paden', pet: 'Voss', event_type: 'wordle_heal', delta: 7,
        prev_health: 60, new_health: 67, max_health: 200 },
      { player: 'Brenda', pet: 'Nyx', event_type: 'wordle_heal', delta: 2,
        prev_health: 30, new_health: 32, max_health: 120 },
      { player: 'Danny', pet: 'Zima', event_type: 'wordle_damage', delta: -15,
        prev_health: 50, new_health: 35, max_health: 240 },
    ]);

    // appendRows called twice: XP block + HP block
    expect(deps.appendRowsFn).toHaveBeenCalledTimes(2);
    const xpAppended = deps.appendRowsFn.mock.calls[0][2];
    const hpAppended = deps.appendRowsFn.mock.calls[1][2];
    expect(xpAppended).toHaveLength(2); // Paden xp_gain + Danny decay
    expect(hpAppended).toHaveLength(3); // 3 HP rows
    expect(hpAppended[0]).toEqual([
      '2026-04-07 18:00:00', TODAY, 'Voss', 'wordle_heal', '7', 'Saga Wordle win — crane',
    ]);
    expect(hpAppended[2]).toEqual([
      '2026-04-07 18:00:00', TODAY, 'Zima', 'wordle_damage', '-15', 'Saga Wordle — did not play',
    ]);

    // Pets.health updated for each non-deceased pet via updateRange
    expect(deps.updateRangeFn).toHaveBeenCalledTimes(3);
    // Transitions: Paden 60→67 (no transition), Brenda 30→32 (still critical, no transition),
    //   Danny 50→35 (50/240=20.8% → above 20% threshold (48), 35/240=14.6% → below — entered critical)
    expect(result.transitions).toEqual([
      { player: 'Danny', pet: 'Zima', kind: 'entered_critical', new_health: 35, max_health: 240 },
    ]);
  });

  it('skips deceased pets entirely — no HP delta, no Pet Log row, no transition', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [
      [TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 3, health: 50, max_health: 160 }),
      petRow({ owner: 'Brenda', stage_index: 5, health: 0,  max_health: 200, status: 'deceased' }),
      petRow({ owner: 'Danny',  stage_index: 2, health: 80, max_health: 140 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    // Brenda is deceased — she's not in hp_writes
    expect(result.hp_writes.map((w) => w.player)).toEqual(['Paden', 'Danny']);
    // updateRange called twice (Paden + Danny) — Brenda's health cell never touched
    expect(deps.updateRangeFn).toHaveBeenCalledTimes(2);
  });

  it('detects death transitions when HP drops to 0 from wordle damage', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = []; // Everyone no-shows
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 14, health: 5, max_health: 380 }), // Source on the brink
      petRow({ owner: 'Brenda', stage_index: 1,  health: 50, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1,  health: 50, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    // Source no-show: -(8+14)=−22. 5 + (−22) = clamped to 0.
    const padenHp = result.hp_writes.find((w) => w.player === 'Paden');
    expect(padenHp.new_health).toBe(0);
    expect(result.transitions).toContainEqual(
      { player: 'Paden', pet: 'Voss', kind: 'died', new_health: 0, max_health: 380 },
    );
  });

  it('detects recovered transitions when HP climbs above 40%', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    // Paden wins
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      // Paden at 38/100 (38% — critical). Win at stage 5: +5+floor(5/2)=+7. 38+7=45 → 45% → recovered.
      petRow({ owner: 'Paden',  stage_index: 5, health: 38, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.transitions).toContainEqual(
      { player: 'Paden', pet: 'Voss', kind: 'recovered', new_health: 45, max_health: 100 },
    );
  });

  it('clamps health at max_health on heal', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      // Paden at 99/100, win heal +5 should clamp at 100 not overflow
      petRow({ owner: 'Paden',  stage_index: 1, health: 99, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    const paden = result.hp_writes.find((w) => w.player === 'Paden');
    expect(paden.new_health).toBe(100);
  });

  it('Egg-stage pets skip HP delta entirely', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 0, health: 50, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.hp_writes.map((w) => w.player)).not.toContain('Paden');
  });

  it('holds stakes when a cheat review is pending — no HP writes either', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const cheatRows = [
      ['2026-04-07 09:00:00', TODAY, 'Paden', 'one_guess_solve', 'crane', '1', 'pending_review', '', 'FALSE'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 5, health: 60, max_health: 200 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 7, health: 50, max_health: 240 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows, cheatRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('stakes_held');
    expect(deps.appendRowsFn).not.toHaveBeenCalled();
    expect(deps.updateRangeFn).not.toHaveBeenCalled();
  });

  it('returns no_puzzle when no row for today', async () => {
    const deps = makeDeps({ todayRows: [], stateRows: [], petsRows: [] });
    const result = await resolveDay(deps);
    expect(result.status).toBe('no_puzzle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run groups/discord_family-fun/scripts/resolve-day.test.mjs
```

Expected: FAIL — current `resolve-day.mjs` doesn't read Pets, doesn't accept `updateRangeFn` in deps, doesn't return `hp_writes` or `transitions`.

- [ ] **Step 3: Update `resolve-day.mjs`**

Overwrite `groups/discord_family-fun/scripts/resolve-day.mjs` with:

```js
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

const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { player: 'Paden', pet: 'Voss' },
  { player: 'Brenda', pet: 'Nyx' },
  { player: 'Danny', pet: 'Zima' },
];

// Pets columns (A-indexed): owner=A(0), stage_index=E(4), health=H(7),
//   status=M(12), max_health=P(15).
const COL = { owner: 0, stage_index: 4, health: 7, status: 12, max_health: 15 };

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

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

function clamp(lo, x, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function classifyTransition({ prev, next, max }) {
  // 0 / 20% / 40% bands. Death takes priority.
  if (next <= 0 && prev > 0) return 'died';
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
    now = nowTs(),
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
    const owner = String(r[COL.owner] || '').toLowerCase();
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
    const status = String(petInfo.row[COL.status] || 'alive').toLowerCase();
    if (status === 'deceased') continue;

    const stage_index = parseInt(petInfo.row[COL.stage_index], 10) || 0;
    const cur_health = parseInt(petInfo.row[COL.health], 10) || 0;
    const max_health = parseInt(petInfo.row[COL.max_health], 10) || 100;

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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run groups/discord_family-fun/scripts/resolve-day.test.mjs
```

Expected: PASS — all 8 cases.

Run the full suite to confirm nothing else broke:

```
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add groups/discord_family-fun/scripts/resolve-day.mjs groups/discord_family-fun/scripts/resolve-day.test.mjs
git commit -m "feat(family-fun): resolve-day writes wordle HP deltas + transitions"
```

---

## Task 6: Extend `STAGES` and bump max HP on evolution in `award_xp.mjs`

**Files:**
- Modify: `groups/discord_silverthorne/award_xp.mjs`

`award_xp.mjs` is a CLI script with no test file (it's a thin wrapper around live sheet calls). The change is small and surgical.

- [ ] **Step 1: Extend the STAGES constant**

In `groups/discord_silverthorne/award_xp.mjs`, replace the `STAGES` array (currently 12 entries on lines 47–60) with 15 entries:

```js
const STAGES = [
  { index: 0, name: 'Egg',           xpThreshold: 0  },
  { index: 1, name: 'Hatchling',     xpThreshold: 50 },
  { index: 2, name: 'Critter',       xpThreshold: 150 },
  { index: 3, name: 'Beast',         xpThreshold: 350 },
  { index: 4, name: 'Spirit',        xpThreshold: 750 },
  { index: 5, name: 'Elemental',     xpThreshold: 1500 },
  { index: 6, name: 'Chimera',       xpThreshold: 3000 },
  { index: 7, name: 'Wyrm',          xpThreshold: 5500 },
  { index: 8, name: 'Celestial',     xpThreshold: 9500 },
  { index: 9, name: 'Eldritch',      xpThreshold: 16000 },
  { index: 10, name: 'Cosmic Horror', xpThreshold: 28000 },
  { index: 11, name: 'Deity',        xpThreshold: 50000 },
  { index: 12, name: 'Pantheon',     xpThreshold: 85000 },
  { index: 13, name: 'Concept',      xpThreshold: 145000 },
  { index: 14, name: 'Source',       xpThreshold: 245000 },
];
```

- [ ] **Step 2: Update the read range and column doc comment**

Replace the comment block above STAGES (lines 45–46) and the read on line 63:

```js
// Cols: A=owner B=name C=species D=avatar E=stage_index F=stage_name G=flavor_modifier
//       H=health I=happiness J=xp K=streak_days L=last_completion_date M=status N=legacy_xp
//       O=last_updated P=max_health
```

```js
// Read Pets tab
const rows = await getValues('Pets!A1:P100');
```

- [ ] **Step 3: Apply the +20/+20 bump on evolution**

Find the block right after `if (evolved) { ... }` (currently lines 105–107). Replace it with:

```js
if (evolved) {
  // Stage evolution → max HP +20, current HP +20 (clamped at new max).
  const prevMaxHealth = parseInt(pet.max_health, 10) || 100;
  const prevHealth = parseInt(pet.health, 10) || prevMaxHealth;
  const newMaxHealth = prevMaxHealth + 20;
  const newHealth = Math.min(prevHealth + 20, newMaxHealth);
  // H=health (col 8), P=max_health (col 16) — write separately, no contiguous range.
  await putValues(`Pets!H${pet.rowNum}`, [[String(newHealth)]]);
  await putValues(`Pets!P${pet.rowNum}`, [[String(newMaxHealth)]]);

  await appendRow('Pet Log', [now, owner, 'evolution', '', `${prevStageName} → ${newStageName}`, 'species TBD by agent']);
  await appendRow('Pet Log', [now, owner, 'wordle_heal', '20', `Evolution bonus — ${prevStageName} → ${newStageName}`, '']);
}
```

(The new `wordle_heal` row makes the +20 visible in Pet Log audit even though the trigger is XP/evolution, not a wordle outcome. Same event_type so the family-fun rendering stays consistent.)

- [ ] **Step 4: Smoke-test by running the existing test suite**

`award_xp.mjs` has no direct unit tests, but it's imported by nothing (it's a CLI). Confirm the rest of the suite is unaffected:

```
npm test
```

Expected: PASS — 591+ tests still green.

- [ ] **Step 5: Commit**

```
git add groups/discord_silverthorne/award_xp.mjs
git commit -m "feat(silverthorne): extend STAGES to Pantheon/Concept/Source + max HP bump on evolution"
```

---

## Task 7: Create one-shot migration `migrate-wordle-hp.mjs`

**Files:**
- Create: `groups/discord_family-fun/scripts/migrate-wordle-hp.mjs`

This is a host-side, run-once script. It writes to live sheets and prints the Claudio prompt for the operator to paste. No unit test — manual verification per the spec's Step 5.

- [ ] **Step 1: Create the migration script**

Create `groups/discord_family-fun/scripts/migrate-wordle-hp.mjs`:

```js
#!/usr/bin/env node
// migrate-wordle-hp.mjs — one-shot rollout of the Saga Wordle HP system.
//
// Idempotent (re-runnable):
//   1. Reads Pets!A2:P10000 (Silverthorne).
//   2. For each pet, computes max_health = 100 + 20 × stage_index.
//   3. Writes max_health to column P, resets health to max_health (column H).
//   4. Appends a 'revival' row to Pet Log per pet noting the rollout.
//   5. Prints a Claudio-voiced announcement prompt to stdout for the
//      operator to relay to #family-fun.
//
// Run: node groups/discord_family-fun/scripts/migrate-wordle-hp.mjs
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
} = {}) {
  const token = providedToken ?? (await getAccessToken());
  const rows = await readRangeFn(SILVERTHORNE_SHEET, 'Pets!A2:P10000', { token });
  const now = nowTs();

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
  migrate()
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
```

- [ ] **Step 2: Smoke-test that the file parses + the existing suite still passes**

```
node --check groups/discord_family-fun/scripts/migrate-wordle-hp.mjs
npm test
```

Expected: no syntax error; test suite still green. (No new tests for the migration; manual verification per the spec.)

- [ ] **Step 3: Commit**

```
git add groups/discord_family-fun/scripts/migrate-wordle-hp.mjs
git commit -m "feat(family-fun): one-shot migrate-wordle-hp script + rollout prompt"
```

---

## Task 8: Update `chore_pet_spec.md` documentation

**Files:**
- Modify: `groups/discord_silverthorne/chore_pet_spec.md`

Pure docs change — keeps the Silverthorne canonical spec in sync with the implementation.

- [ ] **Step 1: Read the existing spec**

```
sed -n '74,135p' groups/discord_silverthorne/chore_pet_spec.md
```

This shows the §2 stage table and the Critical/Death sections. (Ranges may shift slightly — adjust by content if line numbers move.)

- [ ] **Step 2: Replace the stage table**

In `groups/discord_silverthorne/chore_pet_spec.md`, find the section starting `### Stages (12 total — basic → mythical → cosmic)` and replace through the end of the table with:

```markdown
### Stages (15 total — basic → mythical → cosmic → post-cosmic)

Each stage has a cumulative XP threshold, a `daily_upkeep_min` (minutes of chore-work per day to sustain health), and a `max_health` ceiling. Max HP grows by +20 per stage so high-tier pets feel bigger, not just more fragile.

| # | Stage | XP threshold | Upkeep (min/day) | Max HP | Vibe |
|---|---|---|---|---|---|
| 0 | Egg | 0 | 0 | 100 | immortal, inert |
| 1 | Hatchling | 50 | 5 | 120 | innocent |
| 2 | Critter | 150 | 12 | 140 | curious |
| 3 | Beast | 350 | 25 | 160 | rowdy |
| 4 | Spirit | 750 | 40 | 180 | ethereal |
| 5 | Elemental | 1500 | 60 | 200 | awakened |
| 6 | Chimera | 3000 | 85 | 220 | hybrid, unpredictable |
| 7 | Wyrm | 5500 | 115 | 240 | ancient |
| 8 | Celestial | 9500 | 150 | 260 | divine |
| 9 | Eldritch | 16000 | 200 | 280 | unknowable, probably shouldn't exist |
| 10 | Cosmic Horror | 28000 | 270 | 300 | reality bends around it |
| 11 | Deity | 50000 | 360 | 320 | you have created a god |
| 12 | Pantheon | 85000 | 470 | 340 | assembly of selves |
| 13 | Concept | 145000 | 600 | 360 | the pet IS a concept (entropy, color, regret) |
| 14 | Source | 245000 | 760 | 380 | the thing creation springs from |
```

- [ ] **Step 3: Replace the Critical state section with percentage thresholds**

Find the section starting `### Critical state` and replace its body with:

```markdown
### Critical state

Critical / recovered thresholds are now percentages of `max_health` (since `max_health` varies by stage):

- `health ≤ 0.20 × max_health` → pet enters `critical`. Status card renders the pet in red with a distress avatar. Nags become urgent and pet-voiced ("Milo's breathing is shallow…").
- `health > 0.40 × max_health` → status reverts to `alive`.

So a Deity at 60/320 and an Egg at 18/100 both read as critical.
```

- [ ] **Step 4: Add a cross-reference under Health decay**

Find the `### Health decay (scales with stage)` section. Append at the end:

```markdown

**Wordle outcomes also affect health.** See `docs/superpowers/specs/2026-04-26-wordle-difficulty-and-hp-design.md` for the per-game stage-scaled deltas applied at `resolve-day`. Evolution adds `+20` to both `max_health` and `health` (clamped at the new max).
```

- [ ] **Step 5: Smoke check**

```
git diff groups/discord_silverthorne/chore_pet_spec.md
```

Expected: clean diff matching the three replacements above. No test impact.

- [ ] **Step 6: Commit**

```
git add groups/discord_silverthorne/chore_pet_spec.md
git commit -m "docs(silverthorne): extend stage table to 15; percentage HP thresholds"
```

---

## Task 9: Manual rollout (post-merge, run-once)

This isn't a code task — it's the deployment runbook. Do this once after Tasks 1–8 are merged.

- [ ] **Step 1: Add the `max_health` column header to the Pets tab**

In Google Sheets, open the Silverthorne sheet (`1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`), navigate to the `Pets` tab, and put `max_health` in cell **P1**. No data values yet — the migration fills them.

- [ ] **Step 2: Run the migration**

```
node groups/discord_family-fun/scripts/migrate-wordle-hp.mjs
```

Expected stdout:
```
✅ Migration complete: 3 pet(s) updated.

  • Paden    max_health=<N>, health=<N>
  • Brenda   max_health=<N>, health=<N>
  • Danny    max_health=<N>, health=<N>

— — — ...
NEXT: paste this prompt into #family-fun ...
— — — ...

Post this announcement to #family-fun in your voice ...
```

- [ ] **Step 3: Verify the sheet**

In the Pets tab, confirm:
- Column P (`max_health`) is populated for all 3 pets — values are `100 + 20 × stage_index` for each.
- Column H (`health`) is now equal to `max_health` for each pet.

In the Pet Log tab, confirm:
- 3 new rows with `event_type = revival`, reason = `Saga Wordle HP system rollout — restored to stage max`.

- [ ] **Step 4: Relay the announcement**

Paste the printed prompt into #family-fun (or invoke Claudio with the prompt via your usual channel — the prompt is self-contained and addresses Claudio directly).

Confirm Claudio posts the announcement and the rules text inside it is verbatim.

- [ ] **Step 5: Verify next-day flow**

Wait for the next 6am rollover (or trigger `compute-tiers.mjs` manually). Confirm budgets in `Wordle Today` reflect each pet's current stage_index per the table in `wordle_rules.md` / this plan.

After the next day resolves, confirm:
- New `wordle_heal` / `wordle_damage` rows appear in Pet Log.
- `Pets.health` cell values change accordingly.
- If any transition (`entered_critical` / `recovered` / `died`) was returned by `resolve-day`, the agent surfaces it appropriately in #silverthorne.

---

## Self-review checklist

(Verified at plan-write time.)

- ✅ All 9 spec decisions covered: stage→budget (Task 1, 3), HP scope (Task 5), stage-scaled deltas (Task 2, 5), normal death rules (Task 5 transitions), evolution heal (Task 6), 3 new stages (Task 6, 8), 2-guess floor (Task 1), Claudio-voiced announcement (Task 7), Approach A (all tasks).
- ✅ Type/signature consistency: `stageToBudget(stage_index) → number`, `computeWordleHpDelta({entry, winner, stage_index}) → {event_type, delta} | null` is the same in tests, implementations, and callers (compute-tiers, resolve-day).
- ✅ No placeholders: all code blocks contain final code, all commands are runnable as written.
- ✅ Migration is idempotent (re-runnable safely — overwrites max_health to the same value, resets health, appends another revival row).
- ✅ Deceased-pet skip is handled in resolve-day Task 5 with a dedicated test.
- ✅ Egg-stage inertness handled in `computeWordleHpDelta` (Task 2, returns null) AND tested in Task 5.
