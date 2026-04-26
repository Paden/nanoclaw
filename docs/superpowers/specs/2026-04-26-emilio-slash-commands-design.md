# Emilio-care Slash Commands — Design

## Goal

Four Discord slash commands for #emilio-care that bypass the agent entirely: `/asleep`, `/awake`, `/feeding`, `/update-feeding`. Each runs host-side, writes to the existing Emilio Tracking sheet, fires the Emilio chime via IPC webhook, and rebuilds the pinned `status_card` via IPC. **Zero Sonnet tokens per call. Sub-second response.**

Free-text logging in #emilio-care continues to work as today (agent parses messy multi-event messages like "Awake 30 min ago, 2oz, diaper change"). Slash commands are an additional, faster path for the common cases.

## Non-goals

- Replacing free-text logging.
- Adding `/diaper` (out of scope; user did not request).
- Migrating existing log rows.
- Changing the sheet schema.

## Commands

### `/asleep`
Open a new sleep session.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `time` | string | no | Defaults to now. Accepts `5m`, `5 min ago`, `2:30pm`, `14:30`, `now`. |

**Behavior:**
1. Parse `time` → ISO timestamp in America/Chicago.
2. Read Sleep Log; check for any row with non-empty Start and empty Duration.
3. If one exists → reply ephemeral: `"Open nap from {start}. Run /awake first or update the row directly."` Stop. Do NOT modify the sheet.
4. Otherwise → reuse `groups/discord_emilio-care/open_sleep.mjs` to append `[ts]` to Sleep Log.
5. Rebuild status card → IPC `edit_message label:"status_card"`.
6. Fire Emilio chime → IPC `message sender:"Emilio"` from the `nap_start` pool.
7. Reply ephemeral: `"Nap opened at {time-formatted}."`

### `/awake`
Close the open sleep session.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `time` | string | no | Defaults to now. Same parser as /asleep. |

**Behavior:**
1. Parse `time`.
2. Read Sleep Log; find rows with Start non-empty and Duration empty.
3. Zero open → reply ephemeral: `"No open nap to close."` Stop.
4. 2+ open → reply ephemeral: `"Multiple open naps — please clean up the sheet first."` Stop.
5. One open → reuse `groups/discord_emilio-care/close_sleep.mjs` to compute duration in minutes (RAW int) and write to that row's Duration cell.
6. Rebuild status card via IPC.
7. Fire Emilio chime from `wake_up` pool.
8. Reply ephemeral: `"Nap closed: {start} → {time}, {duration} min."`

### `/feeding`
Log a feeding.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `amount` | number | yes | Decimal oz (e.g. `2.5`). Validate >0 and ≤20. |
| `time` | string | no | Defaults to now. |
| `source` | choice | no | `Formula` (default) or `Breast`. Discord choice arg. |

**Behavior:**
1. Parse `time` and validate `amount`.
2. Append `[ts, amount, source]` to Feedings tab via `feeding_log.mjs#appendFeeding`.
3. **Implicit wake-up rule**: if there's exactly one open nap (Start non-empty, Duration empty), close it with `time` as the wake. This matches the existing CLAUDE.md rule ("if Emilio is being fed, he's awake"). If 2+ open or 0 open, do nothing extra.
4. Rebuild status card via IPC.
5. Fire Emilio chime from `feeding` pool.
6. Reply ephemeral: `"Logged {amount}oz {source} at {time}."` (mention if a nap was auto-closed).

### `/update-feeding`
Correct a recent feeding's amount.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `amount` | number | yes | New amount in oz. |
| `row` | string (autocomplete) | no | Picker shows last 5 feedings; default = most recent. Value = the feeding's timestamp (column A) so the lookup stays stable if the sheet is edited between autocomplete and submit. |

**Behavior:**
1. If `row` is not provided, target the most recent feeding (any user, today).
2. Validate the target row's date is today (refuse cross-day edits via slash; force agent for older).
3. Update only the Amount cell. Source/time untouched.
4. Rebuild status card via IPC.
5. Fire Emilio chime from `feeding_update` pool (or fall back to `feeding` pool if `feeding_update` is empty).
6. Reply ephemeral: `"Feeding at {time} updated: {oldAmount}oz → {newAmount}oz."`

**Autocomplete (`/update-feeding row` arg):**
- Read Feedings, filter to today's rows, sort newest-first, take top 5.
- Each option's label: `"{HH:MM AM/PM} · {amount}oz {source}"` (e.g. `"5:34 PM · 1.5 oz Formula"`).
- Each option's value: the row number (1-indexed in the sheet).

## Time parser

Shared helper at `groups/discord_emilio-care/scripts/parse_time.mjs`. Pure function: `parseTime(input: string, now: Date) → { iso: string, displayLocal: string }`.

Accepted forms:
- empty / `now` / `n` → current time
- `5`, `5m`, `5min`, `5 min ago`, `5mins ago`, `5 minutes ago` → N minutes before now
- `1h`, `1hr`, `1 hour ago`, `1.5h` → N hours before now (decimal allowed)
- `2:30`, `2:30pm`, `2:30 pm`, `14:30`, `2:30 PM` → today at that time. If `:00` is omitted, e.g. `8pm`, also accepted.
- If parsed absolute time is more than 1 hour in the future, treat as yesterday (midnight wrap).

Rejects: malformed input → throws with the offending input quoted in the error message.

Test cases (vitest):
- "now" → now
- "" → now
- "5" → 5 min ago
- "5m" → 5 min ago
- "5 min ago" → 5 min ago
- "2:30pm" → today 14:30 CT
- Bare integer (e.g. "8", "45", "90"): treat as minutes-ago. Bare integer >120 is rejected with "ambiguous — use 5m or 2h or 14:30". This avoids users typing "8" intending 8pm.
- "yesterday" → not supported (use absolute time and confirm with user)
- Future time (e.g. "23:30" at 22:00) → today at 23:30 still; only wrap if >1h future.

## Architecture

### New files

| Path | Purpose |
|---|---|
| `scripts/emilio-slash.mjs` | Host-side dispatcher. CLI: `node scripts/emilio-slash.mjs <action> <user_id> [args...]`. Actions: `asleep`, `awake`, `feeding`, `update-feeding`, `autocomplete-feeding-row`. Same pattern as `chore-slash.mjs`. |
| `groups/discord_emilio-care/scripts/parse_time.mjs` | Shared time parser. Exports `parseTime(input, now)`. |
| `groups/discord_emilio-care/scripts/feeding_log.mjs` | Helpers: `appendFeeding(token, {ts, amount, source})`, `updateFeedingAmount(token, {row, amount})`, `recentFeedingsToday(token, {limit})`. Wraps the Sheets API calls for the Feedings tab. |
| `groups/discord_emilio-care/scripts/emilio_chime.mjs` | Reads `emilio_voice.md` pools, picks a non-repeating baby-sound for a given event type. Tracks last-pick state to dedupe. Exports `pickChime(eventType, state)` returning `{ text, newState }`. |
| `src/emilio-slash.test.ts` | Vitest unit tests for time parsing, /asleep/ /awake validation, /feeding append, /update-feeding row resolution, autocomplete. |

### Modified files

| Path | Change |
|---|---|
| `src/channels/discord.ts` | Register the 4 slash commands (with their args + choices for source). Wire autocomplete handler for `/update-feeding row`. Map command invocations to `node scripts/emilio-slash.mjs <action> <user_id> [args]`. |
| `groups/discord_emilio-care/CLAUDE.md` | Add a section: "Slash commands available — `/asleep`, `/awake`, `/feeding`, `/update-feeding`. When a parent's free-text message is fully covered by a slash, you can mention the slash form in your reply (e.g. ack the log, then add 'next time you can also use /feeding amount:3'). Don't refuse to log free-text — both paths coexist." |
| `groups/discord_emilio-care/emilio_voice.md` | Verify it has pools for `nap_start`, `wake_up`, `feeding`, `feeding_update`. If `feeding_update` doesn't exist, add a small pool (5–8 lines). |

### Reused files (no changes)

- `groups/discord_emilio-care/open_sleep.mjs` — already accepts an ISO timestamp arg.
- `groups/discord_emilio-care/close_sleep.mjs` — already accepts an ISO timestamp arg, validates single-open invariant.
- `groups/discord_emilio-care/build_status_card.mjs` — already host-runnable from this session's earlier work.
- `src/ipc-writer.ts` — already exports `writeIpcMessage`.

## Data flow per command

```
Discord interaction → src/channels/discord.ts
  → execFile('node', ['scripts/emilio-slash.mjs', action, userId, ...args])
  → emilio-slash.mjs:
      1. parse args
      2. validate against current sheet state (open-nap check, etc.)
      3. write to sheet (appendFeeding | open_sleep | close_sleep | updateFeedingAmount)
      4. await dist/ipc-writer.js writeIpcMessage(edit_message, label: "status_card", text: <fresh card>)
      5. await writeIpcMessage(message, sender: "Emilio", text: <chime>)
      6. emit { ok: true, reply: "..." } on stdout
  → discord.ts reads stdout JSON, sends ephemeral reply to invoker
```

## Errors and edge cases

- **Sheets API unreachable:** slash returns `{ ok: false, error: "sheets unreachable" }`. discord.ts replies ephemerally with the error. No partial state — IPC writes only fire on successful sheet write.
- **IPC write fails after sheet write succeeds:** log warning, but the slash still reports success. Card will catch up on next event.
- **User not in `USER_TO_OWNER` mapping:** ephemeral error: "You're not registered for emilio-care logging."
- **Concurrent /asleep races:** the open-nap check is read-then-write, not atomic. Acceptable risk — concurrent slashes from different parents within ~1 second are vanishingly rare. If it happens, two open rows result; /awake's "2+ open" guard surfaces it next call.
- **Time in the future (e.g. user types `2:30 AM` at 1am):** if >1h future, treat as yesterday. If ≤1h future (e.g. someone typing the wrong time), accept as-is and let it look weird in the sheet — the user can /update-feeding to fix.

## Permissions

- Reuse `USER_TO_OWNER` mapping from existing slash commands. Only Paden (`181867944404320256`), Brenda (`350815183804825600`), Danny (`280744944358916097`) can invoke. Other users see ephemeral "not registered" reply.
- `/update-feeding` does NOT enforce ownership of the feeding being edited (any registered user can correct any feeding). Matches current free-text behavior.

## Testing

### Unit (vitest)

- `parse_time.test.ts` — every case in the time-parser table.
- `emilio_chime.test.ts` — chime selection, no-repeat invariant, fallback when pool empty.
- `feeding_log.test.ts` — append + update + recentFeedingsToday with mocked Sheets API.
- `emilio-slash.test.ts` — end-to-end with mocked sheets + IPC writer:
  - /asleep with no open → success
  - /asleep with one open → error, no sheet write
  - /awake with one open → success, duration computed correctly
  - /awake with zero / 2+ open → errors
  - /feeding → appends row, fires chime, rebuilds card
  - /feeding with auto-close (one open nap exists) → closes nap and appends feeding
  - /update-feeding default row → updates most recent
  - /update-feeding with explicit row → updates that row
  - /update-feeding cross-day row → rejected
  - autocomplete returns last 5 today, sorted desc

### Manual smoke test

After deploy:
1. `/asleep` in #emilio-care, then check sheet + pinned card + chime.
2. `/awake`, verify duration math.
3. `/feeding amount:2.5`, check chime + card + auto-close behavior if a nap was open.
4. `/update-feeding amount:3.0` (no row arg), check the most recent row updates.
5. Test errors: `/asleep` twice in a row, `/awake` with nothing open, `/feeding amount:abc`.

## Out of scope (potential follow-ups)

- `/diaper` command for diaper changes.
- `/log-cluster` for combined wake+feed+diaper events.
- Cross-channel chime customization (chime currently posts in #emilio-care only).
- Sheet-side validation rules (e.g. preventing >20oz feedings via sheet data validation).

## Risks

- **`emilio_voice.md` may not have a `feeding_update` pool.** Mitigation: emilio_chime.mjs falls back to `feeding` pool if the requested category is empty.
- **Autocomplete value stability:** the autocomplete returns the feeding's timestamp (column A) as the value, so the lookup stays stable if the sheet is edited between picker open and submit. (Earlier draft used row numbers; switched to timestamps for stability.)
