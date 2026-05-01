#!/usr/bin/env node
// calendar-slash.mjs — host-side renderer for the /calendar Discord slash
// command. Thin wrapper: mints an OAuth token from the host-local
// calendar-mcp artifacts, then delegates to the shared renderer.
//
// The same renderer (groups/global/scripts/calendar-render.mjs) backs the
// pinned `calendar_card` refresh cron in #panda, so slash and pin always
// match format.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const KEYS_FILE =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
const TOKENS_FILE =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

async function getAccessToken() {
  const keysRaw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  const keys = keysRaw.installed || keysRaw.web;
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: tokens.normal.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) {
    throw new Error(`token mint failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

const { renderCalendarCard } = await import(
  path.join(ROOT, 'groups', 'global', 'scripts', 'calendar-render.mjs')
);

async function main() {
  const token = await getAccessToken();
  const card = await renderCalendarCard({ token });
  process.stdout.write(card + '\n');
}

main().catch((err) => {
  process.stderr.write(`calendar-slash error: ${err.message}\n`);
  process.exit(1);
});
