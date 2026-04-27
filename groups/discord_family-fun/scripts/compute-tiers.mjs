#!/usr/bin/env node
// compute-tiers.mjs — read Silverthorne Pets tab, compute each player's
// guess budget for the day from their pet's current stage_index.
// Prints JSON to stdout: {"Paden":6,"Brenda":7,"Danny":5}
//
// Used by the 6am rollover script and the publish-today flow.

import { getAccessToken, readRange } from '../../global/scripts/lib/sheets.mjs';
import { stageToBudget } from '../../global/scripts/lib/wordle.mjs';

const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const PLAYERS = [
  { name: 'Paden', pet: 'Voss' },
  { name: 'Brenda', pet: 'Nyx' },
  { name: 'Danny', pet: 'Zima' },
];

// Pets columns A–P. stage_index is column E (index 4).
const STAGE_INDEX_COL = 4;
const OWNER_COL = 0;

export async function computeBudgets({ readRangeFn = readRange, token } = {}) {
  const t = token ?? (await getAccessToken());
  const rows = await readRangeFn(SILVERTHORNE_SHEET, 'Pets!A2:P10000', { token: t });
  const out = {};
  for (const { name } of PLAYERS) {
    const row = (rows || []).find(
      (r) => String(r[OWNER_COL] || '').toLowerCase() === name.toLowerCase(),
    );
    if (!row) {
      throw new Error(`No Pets row for owner "${name}"`);
    }
    const stageIndex = parseInt(row[STAGE_INDEX_COL], 10) || 0;
    out[name] = stageToBudget(stageIndex);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  computeBudgets()
    .then((b) => {
      process.stdout.write(JSON.stringify(b) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`compute-tiers failed: ${err.message}\n`);
      process.exit(1);
    });
}
