#!/usr/bin/env node
// wordle-status-slash.mjs — host-side read-only status for /wordle-status.
//
// Parallel to wordle-slash.mjs, but calls getStatusForPlayer() — no guess,
// no scoring, no writes. Same OAuth routing as wordle-slash.mjs so both
// commands share Google credentials.
//
// Usage:
//   node scripts/wordle-status-slash.mjs <player>
//
// Example:
//   node scripts/wordle-status-slash.mjs Paden
//
// Emits one JSON line on stdout — see score-guess.mjs getStatusForPlayer()
// for the shape.

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Route sheets.mjs at the host-local OAuth artifacts before importing anything
// that calls getAccessToken() — the module reads these env vars at call time.
process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const { getStatusForPlayer } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'score-guess.mjs')
);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const [, , player] = process.argv;
  if (!player) {
    process.stderr.write('usage: wordle-status-slash.mjs <player>\n');
    process.exit(2);
  }

  const result = await getStatusForPlayer(player);
  emit(result);
}

main().catch((err) => {
  emit({ ok: false, status: 'error', message: err.message, stack: err.stack });
  process.exit(1);
});
