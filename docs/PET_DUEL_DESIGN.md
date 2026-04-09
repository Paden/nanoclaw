# Pet Duel System — Design Notes

Status: **design, not built**. Captured from a brainstorm session. This is the shape of the game we want to build, not the current state of the code.

## Context

The household already has three pets (Voss 🌋, Nyx 🌙, Zima ❄️) tracked in the Portillo Games sheet with HP + XP, written by `discord_family-fun` from Wordle outcomes. The goal is to evolve that from passive stat tracking into a real battle game — without falling into the trap of building Pokémon-in-text (which fails because Pokémon's fun is visual).

## Design principles (what we rejected and why)

- **Not Pokémon in text.** Stripping the visuals leaves a spreadsheet fight. HP bars + damage formulas are boring without the animations carrying them.
- **Not "daily encounter" story games.** Scrapbooks, persistent narrative callbacks, saga progression — rejected. "No one cares about scrapbooks."
- **Not real-time turn-by-turn in the channel.** Two people trading `!attack` for 15 minutes is miserable and everyone else mutes the channel.
- **Not LLM-as-rules-engine.** The LLM can't be trusted with fairness, math, or consistent rule enforcement. It must only narrate, never decide.

## The format: loadout-and-reveal duels

Inspired by MUDs, roguelikes, and PBBG games like Kingdom of Loathing — formats that proved text combat works when **the decision is the game and the resolution is a shareable reveal**.

### Core loop

1. `!duel @user` in #family-fun
2. Claudio DMs both players: "Pick 3 techniques in order — opener, mid, finisher. 1 hour."
3. Each player picks privately from their pet's technique pool. **Neither sees the other's picks.**
4. When both lock in (or 1h passes), Claudio resolves deterministically and posts the reveal as a single dramatic message in #family-fun.
5. One duel per pet per 24h (stamina via `MAX(resolved_at)` lookup).

### Why it fits Discord

- **Async.** Lock in over an hour while doing other things.
- **Shareable reveal.** One post, big payoff, like a Wordle grid but a story.
- **Social.** Spectators can speculate during the lock-in window.
- **LLM used correctly.** Narration only, never resolution.
- **Meta-game rewards knowing your opponent** — the household-specific edge no Game Boy game can replicate.

## Schema

New file: `store/games.db` (separate from `messages.db` so game state backs up / wipes independently).

```sql
CREATE TABLE pets (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE,  -- one pet per person in v1
  name TEXT NOT NULL,
  type1 TEXT NOT NULL,
  type2 TEXT
);

CREATE TABLE techniques (
  id TEXT PRIMARY KEY,           -- 'ember_rush'
  name TEXT NOT NULL,            -- 'Ember Rush'
  type TEXT NOT NULL,            -- 'ember'
  shape TEXT NOT NULL            -- 'aggressive' | 'defensive' | 'counter' | 'finisher'
);

CREATE TABLE pet_techniques (
  pet_id INTEGER NOT NULL,
  technique_id TEXT NOT NULL,
  PRIMARY KEY (pet_id, technique_id)
);

CREATE TABLE duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_pet_id INTEGER NOT NULL,
  defender_pet_id INTEGER NOT NULL,
  status TEXT NOT NULL,          -- 'awaiting_picks' | 'resolved' | 'expired'
  challenger_picks TEXT,         -- JSON array of 3 technique IDs
  defender_picks TEXT,
  winner_pet_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

No scrapbook, no events, no XP table. A duel resolves, writes a winner, and that's it.

## Techniques (v1 — 12 total, 4 shapes × 3 types)

| Type | Aggressive | Defensive | Counter | Finisher |
|---|---|---|---|---|
| 🔥 Ember | Ember Rush | Cinder Skin | Backdraft | Magma Slam |
| 🌙 Astral | Silver Bite | Moonshroud | Mirror Phase | Lunar Veil |
| ❄️ Frost | Frost Fang | Ice Wall | Glacier Step | Avalanche |

Each pet starts with all 4 of their own type (pick 3 of 4, ordered). Placeholder type names — confirm before build.

- Voss → Ember (4)
- Nyx → Astral (4)
- Zima → Frost (4)

## Resolution rules

**Shape matchup matrix:**

|  | vs Aggressive | vs Defensive | vs Counter | vs Finisher |
|---|---|---|---|---|
| **Aggressive** | tie | win | lose | tie |
| **Defensive** | lose | tie | tie | lose |
| **Counter** | win | tie | tie | lose |
| **Finisher** | tie | win | win | tie |

RPS-with-two-extra-cards. Defensive stalls (lots of ties). Finisher is strong late vs. protectors but only ties aggressive — so *when* you play your finisher matters.

**Type triangle:**
- Ember > Frost
- Frost > Astral
- Astral > Ember

**Per turn scoring:**
- Shape win = +2 ground, tie = 0, loss = -2 (relative)
- Type bonus: +1 if super-effective
- Sum 3 turns. Higher total wins. Tie → defender.

**Determinism:** No RNG in v1. Every loss is post-mortem-able. Add RNG only if games feel too solvable.

Whole resolver ≈ 60 lines of JS. Pure function: `(p1_picks, p2_picks, p1_type, p2_type) → { winner, turns: [...] }`.

## Flow

1. `!duel @user` → INSERT duel row, `status='awaiting_picks'`
2. Claudio DMs both players via existing per-person DM channels
3. Each DM reply → UPDATE duel row with picks
4. When both non-null OR 1h elapsed → run `duel.mjs resolve <duel_id>`
5. Resolver returns structured JSON per turn
6. LLM in #family-fun reads JSON, writes the 3-paragraph reveal. **Winner already written to DB; LLM cannot change it.**
7. Done.

**Stamina check:** before accepting a challenge, `SELECT MAX(resolved_at) FROM duels WHERE (challenger_pet_id=? OR defender_pet_id=?) AND status='resolved'`. If <24h, reject with remaining cooldown.

## Migration from existing state

Pets already exist in the Portillo Games sheet's `Pets` tab. Migration is lightweight because we're dropping HP/XP/levels entirely in v1 — only names, owners, and types carry over.

1. Read `Pets` tab once → `groups/global/games/pets/seed.json`
2. Insert 3 rows into `pets` table (owner_id from `sheets.md` user IDs)
3. Insert 12 rows into `techniques`
4. Insert 12 rows into `pet_techniques` (4 per pet, same-type)
5. Sheet stays as read-only projection. Old HP/XP columns ignored by the engine but not deleted — family-fun can still render them for nostalgia until we decide otherwise.

Migration script is idempotent (check by `owner_id` uniqueness).

## Milestone 1 scope

~400 lines, one weekend:

1. Schema + `store/games.db`
2. Seed the 12 techniques + 3 pets
3. `scripts/games/duel.mjs` — pure resolver, fully tested
4. Discord flow handler: challenge → DM picks → resolve → reveal post
5. Container MCP tool: `pets.resolve_duel(duel_id)` returns structured turn log for LLM narration
6. Cooldown enforcement
7. 1h timeout cron (expire un-locked duels)

Out of scope for v1: multi-pet, cross-type learning, tournaments, XP progression, RNG, items, status effects, scrapbook/titles.

## Open questions before build

1. **Type names.** Ember/Astral/Frost are placeholders. Confirm or replace.
2. **Confirm 1 pet per person.** Simplifies challenge flow (no "which pet" prompt).
3. **Confirm #family-fun as the duel arena.** Challenge + reveal post there; picks happen in DMs.
4. **Wordle integration** (post-v1): should Wordle wins unlock new techniques? Feels like the right progression hook since it uses the existing daily-ritual channel, but defer until v1 is playable.

## Anti-patterns to avoid

- Don't let the LLM decide the winner. Ever. Resolver is pure JS, LLM narrates from structured input.
- Don't add HP bars. "Ground" abstraction is the whole point — it sidesteps the "watching numbers tick" failure mode.
- Don't add RNG until the meta feels stale. Deterministic games are post-mortem-able, which teaches the meta faster.
- Don't balance-tune before playtesting. 12 techniques + 3 types is small enough to fix by hand after 5 real games.
- Don't build tournaments/XP/items before the core duel feels fun. If one duel doesn't get the household asking for a second, no amount of progression will save it.
