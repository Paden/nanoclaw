#!/usr/bin/env node
// pet-status-slash.mjs — host-side single-shot Silverthorne pet status
// for /pet-status. Reads Pets tab and prints a compact per-pet card:
// stage + HP + XP and "X to <next stage>". Mobile-friendly vertical
// layout (no wide table).
//
// Emits one JSON line: { ok, table } or { ok:false, error }

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const { getAccessToken, readRange } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'sheets.mjs')
);
const { PETS_COL, stageForXp } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'lib', 'pets-schema.mjs')
);

const SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';

// Visual identity per pet — matches webhook personas in src/config.ts.
const PETS = [
  { owner: 'Paden', emoji: '🌋' },
  { owner: 'Brenda', emoji: '🌙' },
  { owner: 'Danny', emoji: '❄️' },
];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let token;
try {
  token = await getAccessToken();
} catch (err) {
  emit({ ok: false, error: `Auth failed: ${err.message}` });
  process.exit(0);
}

let petsRows;
try {
  petsRows = await readRange(SHEET, 'Pets!A2:P200', { token });
} catch (err) {
  emit({ ok: false, error: `Sheet read failed: ${err.message}` });
  process.exit(0);
}

function findPet(owner) {
  return (petsRows || []).find(
    (r) => (r[PETS_COL.owner] || '').toLowerCase() === owner.toLowerCase(),
  );
}

const lines = [];
for (const { owner, emoji } of PETS) {
  const row = findPet(owner);
  if (!row) {
    lines.push(`${emoji} ${owner} · (no pet row)`);
    continue;
  }
  const name = row[PETS_COL.name] || '?';
  const xp = parseInt(row[PETS_COL.xp], 10) || 0;
  const health = parseInt(row[PETS_COL.health], 10) || 0;
  const maxHealth = parseInt(row[PETS_COL.max_health], 10) || 100;
  const status = (row[PETS_COL.status] || 'alive').toLowerCase();
  const streak = parseInt(row[PETS_COL.streak_days], 10) || 0;

  const { current, next } = stageForXp(xp);

  lines.push(`${emoji} **${name}** · ${owner}${status === 'deceased' ? ' · ⚰️ deceased' : ''}`);
  lines.push(`   ${current.name} (stage ${current.index})`);
  lines.push(`   HP ${health}/${maxHealth} · XP ${xp}`);
  if (next) {
    const toNext = Math.max(0, next.xpThreshold - xp);
    lines.push(`   ${toNext} XP to ${next.name}`);
  } else {
    lines.push(`   MAXED — no further stages`);
  }
  if (streak > 0) lines.push(`   🔥 ${streak}-day streak`);
  lines.push('');
}

// Trim trailing blank
while (lines.length && lines[lines.length - 1] === '') lines.pop();

const table = lines.join('\n');
emit({ ok: true, table });
