#!/usr/bin/env bun
// wordle-kickoff.mjs — fully deterministic daily Wordle kickoff.
//
// Runs as a pre-task script (task content: { script: "bun ..." }) and never
// wakes the agent. Picks a word, computes budgets, writes the day's row to
// Portillo Games > Wordle Today, updates local state files, and posts the
// kickoff message directly to #family-fun.
//
// The word is never sent to an LLM. Discord post text never includes it.
// This is intentional — earlier prompt-based kickoffs leaked the answer.
//
// Last stdout line: { "wakeAgent": false, "data": {...} } (or wakeAgent:false
// on error after logging the failure to channel).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken, appendRows } from '../../global/scripts/lib/sheets.mjs';
import { computeBudgets } from './compute-tiers.mjs';
import { getBalance } from '../../global/scripts/lib/wordle-coins.mjs';
import { postChat } from './lib/post-outbound.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR = path.resolve(__dirname, '..');
const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';

function todayChicago() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function pickWord(wordlistPath, usedPath) {
  const all = fs
    .readFileSync(wordlistPath, 'utf8')
    .split('\n')
    .map((w) => w.trim().toUpperCase())
    .filter((w) => /^[A-Z]{5}$/.test(w));

  const usedRaw = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, 'utf8')) : [];
  const used = new Set(usedRaw.map((w) => String(w).toUpperCase()));

  const candidates = all.filter((w) => !used.has(w));
  if (candidates.length === 0) {
    throw new Error('wordlist exhausted — every word used');
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function main() {
  const date = todayChicago();
  const wordlistPath = path.join(GROUP_DIR, 'wordle_wordlist.txt');
  const usedPath = path.join(GROUP_DIR, 'wordle_used_words.json');
  const statePath = path.join(GROUP_DIR, 'wordle_state.json');

  const prevState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { day: 0 };
  const nextDay = (prevState.day || 0) + 1;

  const word = pickWord(wordlistPath, usedPath);
  const budgets = await computeBudgets();

  const balances = {};
  for (const player of Object.keys(budgets)) {
    try {
      balances[player] = await getBalance(player);
    } catch (err) {
      process.stderr.write(`balance read failed for ${player}: ${err.message}\n`);
      balances[player] = 0;
    }
  }

  const effectiveBudgets = Object.fromEntries(
    Object.entries(budgets).map(([player, tierMax]) => [
      player,
      Math.min(balances[player] ?? 0, tierMax),
    ]),
  );

  const token = await getAccessToken();
  // Write the raw tier cap (per pet stage), not a 7:30am snapshot of
  // min(bank, tier). `/wordle` gates on (balance > 0) AND (used < cap)
  // live, so coins earned during the day are spendable the same day.
  // Earlier behavior locked today's max at the morning bank — coins earned
  // after 7:30am couldn't be spent until tomorrow. That was wrong.
  await appendRows(
    PORTILLO_GAMES_SHEET,
    'Wordle Today!A:C',
    [[date, word, JSON.stringify(budgets)]],
    { token },
  );

  const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, 'utf8')) : [];
  used.push(word);
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2) + '\n');

  fs.writeFileSync(statePath, JSON.stringify({ date, day: nextDay, resolved: false }, null, 2) + '\n');

  const playerLines = Object.entries(budgets).map(([player, tierMax]) => {
    const bank = balances[player] ?? 0;
    const tail = bank === 0 ? '   ← do a chore to play' : '';
    return `${player}  🪙 ${bank} · cap ${tierMax}/day${tail}`;
  });

  const text = [
    `**Wordle Day ${nextDay}** — ${date}`,
    ...playerLines,
    '_Each chore = +1 🪙. Coins earned today are spendable today, up to the tier cap._',
    `Submit with \`/wordle <word>\` · status via \`/wordle-status\``,
  ].join('\n');

  postChat(text);

  return {
    wakeAgent: false,
    data: { date, day: nextDay, budgets, balances, effectiveBudgets },
  };
}

main()
  .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
  .catch((err) => {
    try {
      postChat(`⚠️ Wordle kickoff failed: ${err.message}`);
    } catch {}
    process.stdout.write(JSON.stringify({ wakeAgent: false, error: err.message }) + '\n');
    process.exit(1);
  });
