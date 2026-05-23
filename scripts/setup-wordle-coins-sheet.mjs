#!/usr/bin/env node
// One-off provisioning for the Wordle Coins feature. Creates two tabs on
// Portillo Games (Wordle Coins, Wordle Coins Log) if they don't exist,
// then seeds Wordle Coins with one row per player at balance 2.
//
// Run from host:
//   GOOGLE_OAUTH_CREDENTIALS=... GOOGLE_CALENDAR_MCP_TOKEN_PATH=... \
//     node scripts/setup-wordle-coins-sheet.mjs
//
// Or on macOS with the standard token paths, no env needed.

import { getAccessToken } from '../groups/global/scripts/lib/sheets.mjs';

const SHEET_ID = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
const PLAYERS = ['Paden', 'Brenda', 'Danny'];
const SEED_BALANCE = 2;
const NEEDED_TABS = [
  {
    title: 'Wordle Coins',
    header: ['player', 'balance', 'last_updated', 'last_event_id'],
  },
  {
    title: 'Wordle Coins Log',
    header: ['timestamp', 'player', 'delta', 'reason', 'new_balance', 'event_id'],
  },
];

async function fetchMetadata(token) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (j.error) throw new Error(`fetch metadata: ${j.error.message}`);
  return j;
}

async function addTab(token, title) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title } } }],
      }),
    },
  );
  const j = await r.json();
  if (j.error) throw new Error(`addSheet ${title}: ${j.error.message}`);
}

async function writeRows(token, range, values) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    },
  );
  const j = await r.json();
  if (j.error) throw new Error(`writeRows ${range}: ${j.error.message}`);
}

async function readRange(token, range) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  return j.values || [];
}

async function main() {
  const token = await getAccessToken();
  const meta = await fetchMetadata(token);
  const existingTitles = new Set((meta.sheets || []).map((s) => s.properties.title));

  for (const tab of NEEDED_TABS) {
    if (existingTitles.has(tab.title)) {
      console.log(`[setup] tab "${tab.title}" already exists — skipping create`);
    } else {
      await addTab(token, tab.title);
      console.log(`[setup] created tab "${tab.title}"`);
    }
    // Always (re)write the header in row 1
    await writeRows(token, `${tab.title}!A1:${String.fromCharCode(64 + tab.header.length)}1`, [tab.header]);
  }

  // Seed the Wordle Coins table if it's empty (only header).
  const coinsRows = await readRange(token, 'Wordle Coins!A:D');
  const hasData = coinsRows.length > 1;
  if (hasData) {
    console.log('[setup] Wordle Coins already has rows — skipping seed');
  } else {
    const now = new Date().toISOString();
    const seedRows = PLAYERS.map((p) => [p, String(SEED_BALANCE), now, 'seed']);
    await writeRows(token, `Wordle Coins!A2:D${1 + PLAYERS.length}`, seedRows);
    console.log(`[setup] seeded ${PLAYERS.length} players at balance ${SEED_BALANCE}`);
  }

  console.log('[setup] done.');
}

main().catch((err) => {
  process.stderr.write(`[setup] failed: ${err.message}\n`);
  process.exit(1);
});
