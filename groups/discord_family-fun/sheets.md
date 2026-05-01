# Google Sheets — #family-fun

This channel owns the **Wordle Today** and **Wordle State** reads/writes on Portillo Games, and appends Saga Wordle XP/HP to Silverthorne Household.

## How to access

Use `mcp__google-sheets__*` tools. See `/workspace/global/mcp_tools.md` for call shapes. **Never** use `node -e` heredocs against `sheets.mjs`. Bounded resolution scripts (`resolve-day.mjs`, `compute-tiers.mjs`) are fine via Bash.

## Portillo Games

**ID:** `1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY`
**URL:** https://docs.google.com/spreadsheets/d/1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY
**Role:** writes `Wordle Today` (6am rollover publishes the day's word + per-player budgets); reads `Wordle State` to render the progress card; updates `Cheat Log` with jury verdicts.
**Tabs:**
- **Wordle Today** — `date | word | budgets_json` — one row per day. `budgets_json` maps player → guess budget, e.g. `{"Paden":6,"Brenda":7,"Danny":5}`, derived from each pet's lifetime XP tier (see `CLAUDE.md` + `wordle_rules.md`).
- **Wordle State** — `date | player | guess_num | guess | grid | solved` — append-only, one row per scored guess. Host-side `/wordle` slash command writes; this channel reads to render the progress card.
- **Cheat Log** — `timestamp | date | player | type | detail | guess_count | status | verdict | penalty_applied` — status flow `pending_review` → `awaiting_verdict` → `resolved`. See `jury_review.md`.

## Silverthorne Household (cross-write)

**ID:** `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`
**Role:** append `Pet Log` rows for Saga Wordle XP/HP changes on day resolution. See `resolve-day.mjs`.

## Household Discord user IDs

- **Paden** — `181867944404320256`
- **Brenda** — `350815183804825600`
- **Danny** — `280744944358916097`
