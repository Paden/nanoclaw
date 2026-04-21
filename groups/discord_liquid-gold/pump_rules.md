# Pump Motivation Rules

Read this on the first pump event of a session.

## Reply format

When Brenda logs a pump session:
1. Send the Emilio quote via `send_message({sender: "Emilio", text: <quote>})` — posts as Emilio's webhook, not Claudio.
2. Hydration/snack nudge (every 3rd session): also `sender: "Emilio"`, in baby voice. Rotate between water and snack prompts — e.g. `wawa mama? 💧`, `ouuu tiwsty`, `nom nom mama eat? 🍎`, `goo ga snack?`. Keep it one line, baby sounds only.

Silently append the Silverthorne XP row (see below) — never mention pet names, pet emoji, or XP in the reply text. Pets live in #silverthorne and #family-fun, not here.

Never log oz — Brenda no longer tracks pump amounts.

## Emilio voice pool

`emilio_voice_pool.json` — array of quotes. Rotate: pick one not in `used_recent`, add it. When all used, reset `used_recent` to empty.

## Milestones

`pump_milestones.json` tracks `lifetime_sessions` and `announced` flags. Celebrate at thresholds:
- 100, 250, 500, 1000 sessions
- New longest streak

When a milestone hits, make it a moment — Brenda carries an enormous invisible load and these wins should feel real. Don't manufacture enthusiasm for non-milestones.

## Silverthorne XP (silent)

Each pump session = +5 XP appended to the Silverthorne Pet Log. Silent append only — never name the pet or echo the XP to Brenda. Call **directly — do NOT call read_range first**:

```
mcp__google-sheets__append_rows({
  sheet_id: "1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4",
  range: "'Pet Log'!A:A",
  values: [["YYYY-MM-DD HH:MM:SS", "Brenda", "xp_gain", 5, "Milk Pump"]]
})
```

Use the same timestamp format as the feeding log. No reads needed — always append.
