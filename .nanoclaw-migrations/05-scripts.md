# Host Scripts

**Intent:** All scripts in `scripts/` are user-authored (no upstream equivalent). Copy new files wholesale. Modified existing scripts should be diffed and re-applied.

**New files — copy wholesale:**
```bash
for f in \
  scripts/wordle-slash.mjs \
  scripts/wordle-status-slash.mjs \
  scripts/qotd-slash.mjs \
  scripts/qotd-status-slash.mjs \
  scripts/chore-slash.mjs \
  scripts/chore-slash.test.mjs \
  scripts/emilio-slash.mjs \
  scripts/emilio-slash.test.mjs \
  scripts/emilio-week-slash.mjs \
  scripts/calendar-slash.mjs; do
  cp "$OLD_TREE/$f" "$WORKTREE/$f"
done
```

**Modified existing scripts** — diff and re-apply:
```bash
git diff a81e1651b5e48c9194162ffa2c50a22283d5ecd3..HEAD -- \
  scripts/think-proxy.mjs \
  scripts/auth-google.mjs \
  scripts/cleanup-sessions.sh \
  scripts/weekly-review.mjs
```

---

## scripts/wordle-slash.mjs

**Purpose:** Host-side `/wordle` guess scorer. No container spawn.

**Key details:**
- Args: `<player> <guess> <group_folder>`
- Calls `scoreGuessForPlayer()` from `groups/global/scripts/score-guess.mjs`
- Writes guess to Portillo Games sheet (`1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY`), `Wordle State` tab
- Hard-coded family-fun channel JID: `dc:1490924818869260328`
- OAuth: sets `GOOGLE_OAUTH_CREDENTIALS` and `GOOGLE_CALENDAR_MCP_TOKEN_PATH` before importing sheets.mjs

---

## scripts/wordle-status-slash.mjs

**Purpose:** Read-only `/wordle-status`. Calls `getStatusForPlayer()` from `score-guess.mjs`. Same OAuth pattern.

---

## scripts/qotd-slash.mjs

**Purpose:** `/qotd` panda question intake. Two modes: discovery (finds open questions) or forced-Q (post-menu pick).

**Key details:**
- Reads/writes Portillo Games sheet, `Panda Submissions!` tab
- Reads `groups/discord_parents/panda_game_state.json`, `panda_questions.json`, `panda_processed.json`
- Player Discord ID map: `'181867944404320256': 'Paden'`, `'350815183804825600': 'Brenda'`

---

## scripts/qotd-status-slash.mjs

**Purpose:** Read-only `/qotd-status`. Shows unanswered panda Qs for a user. Reads Panda Submissions sheet + `panda_game_state.json`.

---

## scripts/chore-slash.mjs

**Purpose:** `/chore` slash: autocomplete list + submission handler.

**Key details:**
- Sheet: Silverthorne sheet `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`
- Awards XP, picks pet-voice line via `groups/discord_silverthorne/award_xp.mjs`
- Same Discord user ID map as above

---

## scripts/emilio-slash.mjs

**Purpose:** Dispatcher for `/asleep`, `/awake`, `/feeding`, `/update-feeding`, `/diaper`.

**Key details:**
- Sheet: Emilio Tracking `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`
- Reads chime pool from `groups/discord_emilio-care/emilio_voice.md`
- Tracks chime rotation in `groups/discord_emilio-care/emilio_chime_state.json` (no-repeat logic)
- Parent role map: `Paden → 'dad'`, `Brenda → 'mom'`, `Danny → sibling (no chime)`
- Uses helper modules from `groups/discord_emilio-care/scripts/`: `parse_time.mjs`, `feeding_log.mjs`, `emilio_chime.mjs`

---

## scripts/emilio-week-slash.mjs

**Purpose:** `/emilio-week` — 7-day ASCII table of feeds, sleep, poop.

**Key details:**
- Reads Feedings, Diaper Changes, Sleep Log tabs from Emilio sheet
- Output: code-block ASCII table with columns: Date (MM/DD), Feeds (Xoz/N), Sleep (HH:MM), Poop (💩 or empty)
- Rounds oz to nearest integer, poop detected by `Diaper Status` containing "poop" (case-insensitive)
- Emits one JSON line: `{ ok: true, table: "..." }`

---

## scripts/calendar-slash.mjs

**Purpose:** `/calendar` for #panda. Delegates to `groups/global/scripts/calendar-render.mjs`.

**Key details:**
- Mints OAuth token inline (not via sheets.mjs import) using `normal` key from `tokens.json` (not the `calendar` sub-key)
- Reads Google Calendar via MCP-equivalent direct API call
