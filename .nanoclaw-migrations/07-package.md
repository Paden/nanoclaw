# package.json Additions

**Intent:** v2 will have its own package.json. After checking out v2, add only the dependencies that aren't already present.

**How to apply:** Run `npm install <package>` for each missing dep. Don't copy the whole package.json.

**Dependencies to verify/add:**

| Package | Version | Purpose |
|---------|---------|---------|
| `discord.js` | `^14.18.0` | Installed by `/add-discord` — verify it's present |
| `cron-parser` | `5.5.0` | Task scheduler cron parsing |
| `js-tiktoken` | `^1.0.21` | Token counting for compaction threshold |
| `@clack/prompts` | `^1.2.0` | Setup wizard UI (may already be in v2) |

**Dev / tooling:**

Add `lint-staged` config to `package.json` for prettier on staged TypeScript files:
```json
{
  "lint-staged": {
    "src/**/*.ts": ["prettier --write"]
  }
}
```

**Check v2 first** — v2 may already include `cron-parser` and `js-tiktoken`. Only add what's missing after `npm install`.
