# Google Sheets — #liquid-gold

This channel owns the **Milk Pump** tab on the Emilio Tracking sheet, and appends XP to Silverthorne Household Pet Log on each pump.

## How to access

Use `mcp__google-sheets__*` tools. See `/workspace/global/mcp_tools.md` for call shapes. **Never** use `node -e` heredocs against `sheets.mjs`. The bounded `build_status_card.mjs` script is fine via Bash.

## Emilio Tracking

**ID:** `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`
**URL:** https://docs.google.com/spreadsheets/d/1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM
**Role:** writes to `Milk Pump` only. Feedings/diapers/naps live in the same sheet but belong to `#emilio-care`.
**Tabs:**
- **Milk Pump** — session fact + duration/time only. **Brenda no longer tracks ounces** — do NOT ask for or display oz.

## Silverthorne Household (cross-write)

**ID:** `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`
**Role:** silent append to `Pet Log` for pump-tied XP. Never surface pet names or XP in this channel — see `pump_rules.md`.
