#!/usr/bin/env node
// Manual override for Wordle coin balances. Use for vacation grants,
// refunds, fixing up after a bug.
//
// Usage:
//   node scripts/wordle-coins-set.mjs --player Brenda --balance 9 --reason "spring break grant"
//
// Logs to "Wordle Coins Log" with reason "manual:<your reason>".

import { setBalance, COIN_CAP } from '../groups/global/scripts/lib/wordle-coins.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--player') out.player = argv[++i];
    else if (a === '--balance') out.balance = Number(argv[++i]);
    else if (a === '--reason') out.reason = argv[++i];
  }
  return out;
}

const { player, balance, reason } = parseArgs(process.argv.slice(2));
if (!player || balance == null || Number.isNaN(balance) || !reason) {
  process.stderr.write(
    `usage: wordle-coins-set.mjs --player <name> --balance <0..${COIN_CAP}> --reason <text>\n`,
  );
  process.exit(2);
}

try {
  const next = await setBalance(player, balance, reason);
  console.log(`${player} balance set to ${next} (reason: ${reason})`);
} catch (err) {
  process.stderr.write(`failed: ${err.message}\n`);
  process.exit(1);
}
