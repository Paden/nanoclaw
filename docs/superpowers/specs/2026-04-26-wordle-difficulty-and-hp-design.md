# Saga Wordle — Stage-Driven Difficulty + HP Design

**Date:** 2026-04-26
**Channel:** `#family-fun` (Discord)
**Status:** Approved (pending spec review)

## Summary

Today every player has 7 Wordle guesses because the existing tier function uses lifetime XP and nobody has crossed the 500 XP band. Replace that with a system where guess budget tracks the player's actual Silverthorne pet `stage_index`, and where Wordle outcomes feed back into pet `health` (HP). All math lives in deterministic scripts; no LLM inference computes budget, damage, heal, or state transitions. Also extend the pet stage table beyond Deity (3 new stages) to keep evolution open-ended.

## Why this exists

- Current 4-band tier (`tierForXp`) is decoupled from the pet's actual evolution. The "harder Wordle as your pet evolves" intent isn't realized.
- Wordle outcomes only touch XP today. HP — already a real, decaying number from the chore system — is invisible to Wordle, which mutes the stakes.
- All three pets already have names (Voss / Nyx / Zima), so they're past Egg and ready to feel a stage-tied difficulty curve.
- Code is the right home for this: the rules are arithmetic, must be reproducible, and the agent shouldn't be inferring damage values game to game.

## Decisions

| # | Choice | Decision |
|---|---|---|
| 1 | Difficulty source | Pet `stage_index` (smoothed: 5 bands across 15 stages) |
| 2 | HP scope | Existing `Pets.health` column |
| 3 | HP rule shape | Stage-scaled deltas |
| 4 | Death floor | Wordle damage applies normally; can kill |
| 5 | Evolution heal | Max HP grows; current HP grows with it |
| 6 | Stages beyond Deity | +3 stages (Pantheon, Concept, Source) |
| 7 | Wordle floor | 2 guesses at stages 12+ |
| 8 | Rollout announcement | Claudio-voiced, rules embedded in script-emitted prompt |
| 9 | Architecture | Approach A — extend `wordle.mjs` + existing scripts in place |

## Data model changes

### `Pets` tab (Silverthorne sheet `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`)

Current columns are A–O (`owner` … `last_updated`). Add one new column at the **end** (column P) so existing column indices in `award_xp.mjs` and elsewhere don't shift:

| Column | Type | Default | Notes |
|---|---|---|---|
| P: `max_health` | integer | `100 + 20 × stage_index` | Per-pet HP ceiling. Bumped on evolution. |

Existing `health` column (H) unchanged in semantics; it just no longer assumes a 100-cap.

### `Pet Log` tab

Two new `event_type` values (additive, no schema change):

- `wordle_damage` — `delta` is negative; applied to `Pets.health`. Reason format: `Saga Wordle — failed to solve <WORD>` or `... — did not play`.
- `wordle_heal` — `delta` is positive; applied to `Pets.health`. Reason format: `Saga Wordle win — <WORD>` or `Saga Wordle solve — <WORD>`.

The existing `xp_gain` / `decay` events for Wordle XP keep firing; HP events are emitted alongside them in the same `resolve-day` pass.

## Stage table (extends `chore_pet_spec.md` §2)

| # | Stage | XP threshold | Daily upkeep (min) | Max HP | Wordle guesses | Vibe |
|---|---|---|---|---|---|---|
| 0 | Egg | 0 | 0 | 100 | 7 | immortal, inert |
| 1 | Hatchling | 50 | 5 | 120 | 7 | innocent |
| 2 | Critter | 150 | 12 | 140 | 6 | curious |
| 3 | Beast | 350 | 25 | 160 | 6 | rowdy |
| 4 | Spirit | 750 | 40 | 180 | 5 | ethereal |
| 5 | Elemental | 1500 | 60 | 200 | 5 | awakened |
| 6 | Chimera | 3000 | 85 | 220 | 4 | hybrid, unpredictable |
| 7 | Wyrm | 5500 | 115 | 240 | 4 | ancient |
| 8 | Celestial | 9500 | 150 | 260 | 3 | divine |
| 9 | Eldritch | 16000 | 200 | 280 | 3 | unknowable |
| 10 | Cosmic Horror | 28000 | 270 | 300 | 3 | reality bends |
| 11 | Deity | 50000 | 360 | 320 | 3 | a god |
| 12 | Pantheon | 85000 | 470 | 340 | 2 | assembly of selves |
| 13 | Concept | 145000 | 600 | 360 | 2 | the pet IS a concept (entropy, color, regret) |
| 14 | Source | 245000 | 760 | 380 | 2 | the thing creation springs from |

`chore_pet_spec.md` §2 stage table is updated to include stages 12–14.

## Guess budget formula

```
function stageToBudget(stage_index) {
  if (stage_index >= 12) return 2;
  if (stage_index >= 8)  return 3;
  if (stage_index >= 6)  return 4;
  if (stage_index >= 4)  return 5;
  if (stage_index >= 2)  return 6;
  return 7;
}
```

Pure function. Replaces `tierForXp` in `groups/global/scripts/lib/wordle.mjs`. `tierForXp` is removed — there is no caller other than `compute-tiers.mjs`, which switches to `stageToBudget`.

## HP delta formula

```
function computeWordleHpDelta({ outcome, stage_index }) {
  if (stage_index === 0) return null;  // Egg is inert
  switch (outcome) {
    case 'won':    return { event_type: 'wordle_heal',   delta:  5 + Math.floor(stage_index / 2) };
    case 'solved': return { event_type: 'wordle_heal',   delta:  2 + Math.floor(stage_index / 4) };
    case 'failed': return { event_type: 'wordle_damage', delta: -(5 + stage_index) };
    case 'no_show':return { event_type: 'wordle_damage', delta: -(8 + stage_index) };
  }
}
```

Outcome semantics (single source: `resolve-day.mjs`):
- `won` — solved with the fewest guesses (tie broken by submission order — same logic as `determineWinner`).
- `solved` — solved but didn't win.
- `failed` — submitted at least one guess; budget exhausted without solving.
- `no_show` — never invoked `/wordle` that day.

| Stage | won | solved | failed | no-show |
|---|---|---|---|---|
| 0 (Egg) | 0 | 0 | 0 | 0 |
| 1 (Hatchling) | +5 | +2 | −6 | −9 |
| 7 (Wyrm) | +8 | +3 | −12 | −15 |
| 11 (Deity) | +10 | +4 | −16 | −19 |
| 14 (Source) | +12 | +5 | −19 | −22 |

## Critical / death thresholds (percentage-based)

Existing rules are absolute (`health ≤ 20` → critical). With `max_health` varying by stage, switch to percentages:

- Critical: `health ≤ 0.20 × max_health`
- Recovered: `health > 0.40 × max_health`
- Death: `health ≤ 0` (unchanged)

`chore_pet_spec.md` §2 "Critical state" section is updated to reflect the percentage thresholds.

## Triggers

### Start hook — `groups/discord_family-fun/scripts/compute-tiers.mjs`

Already runs at 6am rollover and on publish-today. Modified to:

1. Read `Pets!A2:P10000` from the Silverthorne sheet (was: `Pet Log!A2:F10000`)
2. Find each player's row by `owner` column
3. Call `stageToBudget(stage_index)` per player. Deceased pets keep their normal budget here — `/wordle` doesn't need to know about pet status; the `resolve-day` HP step is where deceased pets are skipped.
4. Output JSON: `{"Paden":N,"Brenda":N,"Danny":N}` — schema unchanged

### Finish hook — `groups/discord_family-fun/scripts/resolve-day.mjs`

Existing flow: read Wordle State → compute winner → write Pet Log XP rows. Extended to also:

1. For each player, classify outcome (`won` / `solved` / `failed` / `no_show`)
2. Read fresh `Pets!stage_index`, `health`, `max_health`, and `status` per player (single batch read)
3. Skip pets where `status === 'deceased'` — no HP delta, no Pet Log row (they're not playing)
4. Call `computeWordleHpDelta({ outcome, stage_index })`
5. Write the HP event row to Pet Log (alongside the XP row)
6. Update `Pets.health` directly: `new_health = clamp(0, current_health + delta, max_health)`
7. Detect critical / recovered / death transitions per pet by comparing `prev` vs `new` health against `0.20 × max_health` / `0.40 × max_health` / `0` — include any transition in the script's stdout JSON so the agent can post the existing flavor messages (same handoff pattern as `award_xp.mjs`'s `evolved` flag)

Wordle HP changes happen at resolve time (immediate), not deferred.

### Evolution hook — `groups/discord_silverthorne/award_xp.mjs`

(Note: the "midnight tick" described in `chore_pet_spec.md` §5 was never implemented; evolution is detected at chore-completion time inside `award_xp.mjs` instead. This is the script we modify.)

When `evolved === true` (line 88 of `award_xp.mjs`):

- `max_health += 20` (write to column P)
- `health += 20` (write to column H, clamped at `new_max_health`)

Applied alongside the existing stage_index/stage_name update in the same write batch.

The `STAGES` constant at the top of `award_xp.mjs` (lines 47–60, currently 12 entries) must also be extended to 15 entries with the Pantheon / Concept / Source thresholds — otherwise XP can climb past Deity but `newStageIndex` never advances.

## Rollout

### Step 1 — Sheet schema

Add `max_health` column at column **P** of the `Pets` tab (immediately after `last_updated` in column O). Appended at end so existing column indices in `award_xp.mjs` are not shifted. Header row only — values come from migration.

### Step 2 — Pet spec doc

Update `groups/discord_silverthorne/chore_pet_spec.md`:
- §2 stage table: add Pantheon / Concept / Source rows; add `Max HP` column
- §2 "Critical state": percentage-based thresholds
- §2 "Health decay": note that wordle outcomes also change health (cross-reference this spec)

### Step 3 — Code changes

| File | Change |
|---|---|
| `groups/global/scripts/lib/wordle.mjs` | Add `stageToBudget`, `computeWordleHpDelta`. Remove `tierForXp`, `lifetimeXp` (no other callers). Existing `scoreGuess`, `isValidGuessShape`, `determineWinner`, `computeDayStakes`, `renderCard` unchanged. |
| `groups/global/scripts/lib/wordle.test.mjs` | Update tests: drop `tierForXp` cases; add `stageToBudget` boundary tests (1/2, 3/4, 5/6, 7/8, 11/12) and `computeWordleHpDelta` cases (each outcome × Egg / mid / Source). |
| `groups/discord_family-fun/scripts/compute-tiers.mjs` | Read `Pets` tab instead of `Pet Log`; call `stageToBudget`. |
| `groups/discord_family-fun/scripts/compute-tiers.test.mjs` | Update to mock `Pets!A2:P10000` instead of `Pet Log!A2:F10000`. |
| `groups/discord_family-fun/scripts/resolve-day.mjs` | Add HP delta pass; emit critical/death transitions in stdout. |
| `groups/discord_silverthorne/award_xp.mjs` | Extend `STAGES` to 15 entries (Pantheon / Concept / Source). On `evolved`: `max_health += 20`, `health += 20`. Update read range to `Pets!A1:P100`. |

### Step 4 — Migration script

New: `groups/discord_family-fun/scripts/migrate-wordle-hp.mjs`. One-shot.

1. Read all rows from `Pets` tab.
2. For each pet:
   - Compute `max_health = 100 + 20 × stage_index`
   - Set `health = max_health` (full restore — the "fresh start")
   - Append a Pet Log row: `event_type: revival`, `delta: max_health`, reason: `Saga Wordle HP system rollout — restored to stage max`
3. Write Pets and Pet Log updates.
4. Emit a `wakeAgent: true` payload with a deterministic prompt embedding the canonical rules text — the agent posts the rollout announcement to `#family-fun` in Claudio's voice. Prompt content is fixed in the script source.

The canonical rules text (embedded verbatim in the migration script):

```
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

Critical (≤20% HP) and death (0 HP) rules from #silverthorne now apply to wordle damage too. Don't no-show.
```

### Step 5 — Verification (manual)

After migration runs:
1. Check `Pets` tab — `max_health` populated, `health == max_health` for all 3 pets
2. Check `Pet Log` — 3 `revival` rows with rollout reason
3. Check `#family-fun` — Claudio's announcement is posted
4. Run next morning's `compute-tiers.mjs` manually — confirm budgets reflect each pet's stage
5. Force a `resolve-day.mjs` test run on a known fixture — confirm HP rows + Pets.health update + transition flag

## Tests

**Unit (`wordle.test.mjs`):**
- `stageToBudget` — every stage 0–14 (15 cases) verifying band boundaries
- `computeWordleHpDelta` — outcome × stage matrix covering Egg, Hatchling, Wyrm, Deity, Source (20 cases)
- Egg returns `null` for all outcomes

**Unit (`compute-tiers.test.mjs`):**
- Mock `readRange` for `Pets` tab; verify each player gets the correct budget
- Players at stages 0, 5, 14 — verify mapping
- Player missing from Pets tab — verify error path

**Integration (`resolve-day` test, new):**
- Fixture: 3 players, mixed outcomes (1 winner, 1 solver, 1 no-show)
- Stages 1 / 7 / 11
- Assert: 6 Pet Log rows written (3 XP + 3 HP); Pets.health updated correctly; critical flag set if any pet drops below threshold

## Out of scope / future

- Wordle "shield" tokens analogous to chore streak shields
- Per-pet HP regen between Wordle days (today, only chore completions and evolutions restore HP)
- Visual HP bar in the pinned `wordle_card` (currently shown only on Silverthorne status card)
- Recalibrating XP economy now that 245k is the new ceiling — leaving as-is; the Source endgame is meant to be effectively unreachable on a normal cadence
- Implementing the never-built daily decay/upkeep midnight tick from `chore_pet_spec.md` §5. Health currently changes only via `award_xp.mjs` (gains on completion) and now `resolve-day.mjs` (wordle outcomes). The percentage-based critical/death thresholds in this spec apply wherever transitions are detected; if/when the midnight tick is built later, it adopts the same thresholds.

## Open questions

None — all decisions captured above.
