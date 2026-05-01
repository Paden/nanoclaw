# Groups Tree

**Intent:** The entire `groups/` directory is user-created content with no upstream equivalent. Copy it wholesale into the v2 worktree. The overlay system (`data/group-global-overlay/`) is also user-created and must be preserved.

**How to apply:**

```bash
cp -r "$OLD_TREE/groups" "$WORKTREE/groups"
cp -r "$OLD_TREE/data/group-global-overlay" "$WORKTREE/data/group-global-overlay"
```

Data directories (`data/`, `store/`, `groups/` runtime JSON state files) are never touched by the migration — only the code/config files within groups need copying. The runtime state (saga_state.json, wordle_state.json, etc.) lives in the same group dirs and comes along automatically with the above copy.

---

## groups/global — Claudio identity + shared libraries

**What it is:** Base identity and shared code mounted into every container. Every group inherits this.

**Key files (copy as-is):**
- `soul.md` — Claudio's identity/values document. Critical — present in every container.
- `CLAUDE.md` — Top-level persona and family overview (Paden, Brenda, Danny, baby Emilio, vizsla Eni)
- `communication.md`, `mcp_tools.md`, `message_formatting.md`, `cron_defaults.md`, `date_time_convention.md` — structured reference docs loaded into every container
- `claudio-journal.md` — running journal Claudio maintains
- `portillo_games_sheet_id.txt` — shared Google Sheet ID for Portillo Games
- `skills/agent-browser.md` — browser skill for containers

**Shared script libraries (groups/global/scripts/):**
- `lib/sheets.mjs` + tests — Google Sheets OAuth access layer (used by every group's scripts)
- `lib/wordle.mjs` + tests — pure Wordle scoring + tier math
- `lib/pets-schema.mjs` + tests — Silverthorne Pets sheet column map + timestamp helpers
- `score-guess.mjs` + tests — Wordle guess scoring entry point
- `calendar-render.mjs` — calendar card renderer
- `wordle_wordlist.txt` — full Wordle word list (5-letter words)

---

## groups/discord_general — Main/admin channel (#general)

Elevated privileges, cross-group task scheduling. Contains `claudio-journal.md`, `soul.md`, reference docs, and backups.

---

## groups/discord_family-fun — Saga Wordle game (#family-fun)

**What it is:** Daily competitive family Wordle with a rolling pirate space opera story. Players: Paden (Voss 🌋), Brenda (Nyx 🌙), Danny (Zima ❄️). Pet XP/HP stakes tie into Silverthorne.

**Key scripts (groups/discord_family-fun/scripts/ and root):**
- `compute-tiers.mjs` + tests — maps pet stage → guess budget per player
- `resolve-day.mjs` + tests — resolves a Wordle day (reads sheet, winner, writes XP/HP to Pet Log). Flags: `--yesterday`, `--date YYYY-MM-DD`
- `wordle_card.mjs` + tests — renders pinned status card
- `wordle_poll.mjs` + tests — detects new guesses, updates card
- `migrate-wordle-hp.mjs` — one-shot HP migration script (idempotent with `--force`)
- `leaderboard.mjs` — leaderboard builder
- `build_status_card.mjs` — status card builder

**Key data files:** `saga_state.json` (25 chapters of pirate space opera), `wordle_state.json`, `wordle_used_words.json`, `wordle_leaderboard.json`, `wordle_rules.md`, `saga_rules.md`, `sheets.md`

**Scheduled tasks (in store DB):**
- `task-wordle-midnight-close-1` — cron `55 23 * * *` — resolves day, posts saga chapter
- `task-1775536922840-6xn4hd` — cron `0 6 * * *` — 6am rollover: resolve yesterday, pick new word, publish to sheet, announce

---

## groups/discord_emilio-care — Baby care tracking (#emilio-care)

**What it is:** Feed/diaper/nap logging for parents. Claudio logs to Emilio Tracking Google Sheet. Sends webhook chimes in Emilio's baby voice. Wind-down reminders.

Sheet ID: `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`
Tabs: `Feedings` (Feed time, Amount (oz), Source), `Diaper Changes` (Feed time, Diaper Status), `Sleep Log`

**Key scripts:**
- `build_status_card.mjs` — today's card. Supports `--date YYYY-MM-DD` for historical days
- `open_sleep.mjs` / `close_sleep.mjs` — append/close Sleep Log rows via script (direct Sheets MCP caused wrong-row bugs)
- `log_feeding.mjs` — append feeding row
- `check_diapers.mjs`, `check_state.mjs`, `find_last_poop.mjs` — state checkers
- `winddown_check.mjs` + tests — wind-down reminder logic (event-driven, no cron)
- `winddown_advance_check.mjs` + tests — advance wind-down check

**Shared script libraries (groups/discord_emilio-care/scripts/):**
- `parse_time.mjs` + tests — flexible time parser (relative: "5m ago", absolute: "2:30pm", ISO)
- `feeding_log.mjs` + tests — append/update/recent feeding rows
- `emilio_chime.mjs` + tests — chime selector with pool + no-repeat logic

**Key data/config:** `emilio_voice.md` (chime pools), `emilio_sheet.md`, `sheets.md`, `emilio_chime_state.json`, `sleep_state.json`, `winddown_state.json`, `winddown_advance_state.json`

---

## groups/discord_liquid-gold — Pumping tracking (#liquid-gold)

**What it is:** Pump session logging for Brenda. Logs to `Milk Pump` tab of Emilio Tracking sheet. Celebrates sessions.

**Key files:** `build_status_card.mjs`, `pump_rules.md`, `sheets.md`, `pump_milestones.json`, `emilio_voice_pool.json`

---

## groups/discord_parents — Panda Romance Game (#panda)

**What it is:** Private couple space (Paden + Brenda only). Runs daily question-of-the-day panda game, calendar card, couple logistics.

Sheet: Portillo Games sheet, `Panda Submissions!` tab

**Key scripts:**
- `panda_card.mjs` + tests — renders Panda game status card
- `panda_poll.mjs` + tests — polls for new question responses, updates card

**Key data files:** `panda_game_spec.md`, `panda_game_state.json`, `panda_questions.json`, `panda_processed.json`, `sheets.md`

---

## groups/discord_silverthorne — Chore tracking + pets (#silverthorne)

**What it is:** Shared family space. Chore completion → XP/HP for pets (Voss/Nyx/Zima). Dog feeding reminders (Eni the vizsla).

Sheet ID: `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`
Tabs: Chores, Chore Log, Announcements, Pets, Pet Log

**Key scripts:**
- `build_status_card.mjs` — renders chore + pet status card
- `build_todo_card.mjs` — renders todo card
- `award_xp.mjs` — awards XP to a pet
- `chore_sweeper.mjs` — sweeps overdue chores
- `nag_check.mjs` + tests — nag logic

**XP formula:** duration × 1.5 (on-time) / × 1.0 (late) / × 0.5 (very late). Evolution triggers art-prompt sequence + webhook persona avatar update.

**Key data files:** `chore_pet_spec.md`, `sheets.md`, `webhook_personas.json`

---

## groups/discord_overmind — Ops/monitoring (#overmind)

Internal ops workspace. Contains DB check scripts (Python), `sheets_doc_watch.mjs`, patch files, `token_alert_state.json`, `webhook_personas.json`. No CLAUDE.md — not a real agent group, used as an ops scratchpad/monitoring workspace.
