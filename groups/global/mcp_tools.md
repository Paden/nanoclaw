# MCP tools — what's available and when to use it

These MCP servers are mounted into every group's container (unless noted). Prefer these over bash/web-scraping whenever a dedicated tool exists.

## `mcp__google-sheets__*` — Google Sheets

Authenticated as padenportillo@gmail.com via OAuth tokens shared with calendar-mcp. Read and write the three family sheets whose IDs and tab schemas are already inlined in your system prompt.

**Use for:** reading rows, appending rows, overwriting ranges.
**Don't use for:** creating new spreadsheets or tabs — the canonical three already exist; never duplicate them. If you need a new tab, ask a human.
**Timestamp rule:** every timestamp value follows the date/time convention already inlined in your system prompt (`YYYY-MM-DD HH:MM:SS` in America/Chicago, no `T`, no `Z`).

**Exact call shapes — don't guess:**

- `read_range({ sheet_id, range, offset?, limit? })` — read a range with pagination.
  - `sheet_id`: spreadsheet ID (from the URL).
  - `range`: A1 notation with tab prefix, e.g. `"Feedings!A:C"` or `"Diaper Changes!A500:B600"`.
  - `offset`: row offset into the returned range (0-based). Default `0`.
  - `limit`: max rows to return. Default `100`, max `500`.
  - Returns `{ rows, totalRows, offset, limit, truncated, nextOffset? }`. Response is hard-capped at ~50KB — if `truncated: true`, paginate via `nextOffset` or narrow the A1 range.
  - **Large tabs:** narrow the A1 range (`"Feedings!A500:C600"`) rather than pulling the whole column and paginating. Fewer rows per call = less context.

- `append_rows({ sheet_id, range, values })` — append rows to the bottom of a range.
  - `values`: 2D array, e.g. `[["2026-04-20 09:00:00", "wet"]]`.
  - `range`: A1 like `"Diaper Changes!A:B"`.

- `update_range({ sheet_id, range, values })` — overwrite a range with the given 2D array.

If a call returns an arg-shape error, **stop and re-read this list** before retrying. Do not guess parameter names. The params are `sheet_id` (not `spreadsheet_id`), `range` includes the tab prefix (not a separate `sheet` arg), and the values arg is `values` (not `data`).

**NEVER** use `node -e` / `node --input-type=module` to call `sheets.mjs` directly — it dumps unbounded JSON through tool output and bloats context. Use these MCP tools instead.

## `mcp__claude_ai_Google_Calendar__*` — Google Calendar

Paden's calendars (personal + shared work). Mounted in #panda for the `calendar_card`. List, create, update, delete events.

**Use for:** scheduling, checking availability, managing family events, building the `calendar_card` in #panda.
**Timezone:** events are displayed in America/Chicago on the card.

## `mcp__nanoclaw__*` — NanoClaw channel tools

Host-side tools for talking back to the Discord channel your container is running in.

- `send_message({ text, label?, pin? })` — send a message. Pass `label` to anchor a message for later editing; pass `pin: true` to pin on creation.
- `edit_message({ label, text })` — edit a previously-labeled message in place. Use this for all status cards — never re-post.
- `delete_message({ label })` — delete a labeled message.
- `pin_message({ label })` / `unpin_message({ label })` — toggle pin.

**Use for:** pinned status cards (`status_card`, `calendar_card`, `panda_heart`, `wordle_card`), ack pings, progress updates during long work.

## `agent-browser` (shell tool, not MCP)

Headless browser for scraping and form-filling. `agent-browser open <url>` to start, `agent-browser snapshot -i` to see interactive elements, then click/fill/submit.

**Use for:** things behind web UIs that don't have a clean API.
**Don't use for:** anything a real API or MCP tool can handle.

## Host shell (`Bash` tool)

For anything not covered above. The container has node, bash, curl, jq, sqlite3. Use it for:
- Script-gated task scripts (see `/workspace/global/task_scripts.md`)
- Minting ADC tokens for direct Sheets API calls from scripts
- Local file manipulation in `/workspace/group/`

## Rules

1. **Try the tool before reporting "offline."** If a tool fails, retry once, then paste the literal error. Never tell a user "I'll do that later" when a tool is available right now.
2. **Prefer MCP over shell.** Shell is a last resort.
3. **Never create duplicate resources.** Sheet already exists? Use it. Event already on calendar? Update it.
