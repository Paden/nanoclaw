# Google Sheets — #parents

This channel owns the **Panda reveal** reads on Portillo Games, and reads Emilio Tracking for daily schedule context.

## How to access

Use `mcp__google-sheets__*` tools. See `/workspace/global/mcp_tools.md` for call shapes. **Never** use `node -e` heredocs against `sheets.mjs`.

## Portillo Games

**ID:** `1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY`
**URL:** https://docs.google.com/spreadsheets/d/1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY
**Role:** reader — `Panda Submissions` reveal poller; appends long-form entries to `Panda Love Map` on reveal.
**Tabs:**
- **Panda Submissions** — `timestamp | date | user_id | name | question_number | answer` — written by the host-side `/qotd` slash command (Paden + Brenda only).
- **Panda Love Map** — long-term journal entries from Panda reveals.

## Emilio Tracking (read-only)

**ID:** `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`
**Role:** read-only — feedings/naps context for daily rhythm. All writes belong to `#emilio-care`.

## Household Discord user IDs

- **Paden** — `181867944404320256`
- **Brenda** — `350815183804825600`
- **Danny** — `280744944358916097`
