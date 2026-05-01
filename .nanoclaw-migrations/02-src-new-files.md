# New src/ Files

**Intent:** These files have no upstream equivalent. Copy them wholesale from the current tree into the v2 worktree after the Discord skill is applied.

**How to apply:**
```bash
# After /add-discord has been applied in the worktree:
for f in \
  src/chore-slash.ts \
  src/chore-slash.test.ts \
  src/ipc-writer.ts \
  src/ipc-writer.test.ts \
  src/qotd-status.ts \
  src/qotd-status.test.ts \
  src/state-card.ts \
  src/state-card.test.ts \
  src/wordle-keyboard.ts \
  src/wordle-keyboard.test.ts \
  src/compaction.ts \
  src/compaction-notify.ts \
  src/compaction-notify.test.ts; do
  cp "$OLD_TREE/$f" "$WORKTREE/$f"
done
```

Note: `src/channels/discord.ts` and its test are installed by `/add-discord`. Do NOT copy them from the old tree — use the v2 version and re-apply slash command additions (see `06-discord-slash.md`).

---

## src/chore-slash.ts

**What it is:** Host-side handler for the `/chore` slash command. Reads the Silverthorne chore list from Google Sheets for autocomplete, submits chore completion, awards XP, triggers pet voice. 261 lines. Used by `discord.ts` `handleChoreCommand`.

**Key exports:** `getChoreChoices(groupFolder)` (autocomplete), `submitChore(groupFolder, choreName, userId)`

---

## src/ipc-writer.ts

**What it is:** Host-side utility to drop IPC JSON files into `data/ipc/<group>/messages/` and `data/ipc/<group>/tasks/` without spawning a container. Used by slash commands to post pinned cards and fire one-off agent tasks programmatically from the host.

**Key exports:** `writeIpcMessage(groupFolder, payload)`, `writeIpcTask(groupFolder, task)`

---

## src/qotd-status.ts

**What it is:** Formatter for `/qotd-status` reply. Takes the open-questions payload from `scripts/qotd-status-slash.mjs` and formats it as a Discord ephemeral reply listing unanswered panda questions. 97 lines.

**Key exports:** `formatQotdStatusReply(result)`

---

## src/state-card.ts

**What it is:** Helpers for trimming agent status card output before sending to Discord.

**Key exports:**
- `stripCard(stdout: string): string` — strips the `═══ AGENT REF ═══` section and everything after it
- `fitDiscordReply(text: string): string` — truncates to Discord 2000-char limit with ellipsis

---

## src/wordle-keyboard.ts

**What it is:** Formatters for `/wordle` and `/wordle-status` slash command replies. Renders the colored guess grid and player status. 151 lines.

**Key exports:**
- `formatWordleReply(result)` — formats a guess result (grid + status) as Discord message
- `formatWordleStatusReply(result)` — formats the current-day status for a player

---

## src/compaction.ts + src/compaction-notify.ts

**What it is:** Custom session compaction for non-Claude models (Ollama/Gemini via Ollama Pro). When `peakInputTokens` exceeds `COMPACT_TOKEN_THRESHOLD`, triggers Claude SDK's built-in compaction. `compaction-notify.ts` posts a notification to `#discord_overmind` when a session is compacted, so the operator knows context was reset.

**Key exports from compaction.ts:** `shouldCompact(peakTokens): boolean`, `runCompaction(sessionId, groupFolder)`
**Key exports from compaction-notify.ts:** `notifyCompaction(groupFolder, sessionId, tokenCount)`

Config values used:
- `COMPACT_TOKEN_THRESHOLD` (default `100000`)
- `COMPACT_MODEL` (default `'gemma4:31b-cloud'`)
