// Host-side reconciliation between Chore Log and Wordle Coins.
//
// The /chore slash command deposits a coin per chore-id at submit time, but
// agent-direct sheet writes (Claudio interpreting natural-language chore
// reports and writing Chore Log rows himself) bypass that path. To keep
// coins consistent without trusting the LLM, every ~10 minutes we scan
// today's Chore Log, filter to registered chore-ids (from the Chores tab),
// and deposit coins for any that don't already have a matching audit-log
// entry. Idempotency on `chore:<id>:<date>` event-ids means re-running is
// safe — already-deposited rows no-op via the existing eventId match in
// wordle-coins.mjs.
//
// Critically, this validates the chore-id against the Chores tab. If
// Claudio invents a chore-id like `paint_kitchen` (seen 2026-05-23), the
// reconciliation skips it — no coin is awarded for invented chores.

import { log } from './log.js';

// Lazy-loaded via dynamic import. The .mjs modules don't ship .d.ts, so we
// type their public surface inline. Live wiring goes to the calendar-mcp
// OAuth via groups/global/scripts/lib/sheets.mjs.

interface CoinsLib {
  getBalance(player: string): Promise<number>;
  deposit(player: string, eventId: string, reason: string): Promise<number>;
}

interface SheetsLib {
  getAccessToken(): Promise<string>;
  readRange(sheetId: string, range: string, opts: { token: string }): Promise<string[][]>;
}

let coinsMod: Promise<CoinsLib> | null = null;
let sheetsMod: Promise<SheetsLib> | null = null;

function loadCoinsMod(): Promise<CoinsLib> {
  if (!coinsMod) {
    coinsMod = import('../groups/global/scripts/lib/wordle-coins.mjs' as string) as Promise<CoinsLib>;
  }
  return coinsMod;
}

function loadSheetsMod(): Promise<SheetsLib> {
  if (!sheetsMod) {
    sheetsMod = import('../groups/global/scripts/lib/sheets.mjs' as string) as Promise<SheetsLib>;
  }
  return sheetsMod;
}

const SILVERTHORNE_SHEET = '1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4';
const VALID_PLAYERS = new Set(['Paden', 'Brenda', 'Danny']);
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let lastRunMs = 0;
let inFlight = false;

function todayChicago(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Run the reconciliation once. Throttled to at most one execution per
 * RECONCILIATION_INTERVAL_MS, and serialized — only one run at a time.
 * Safe to call on every host-sweep tick.
 */
export async function reconcileWordleCoinsTick(): Promise<void> {
  const now = Date.now();
  if (now - lastRunMs < RECONCILIATION_INTERVAL_MS) return;
  if (inFlight) return;
  inFlight = true;
  lastRunMs = now;
  try {
    await reconcileNow();
  } catch (err) {
    log.error('Wordle coin reconciliation failed', { err: (err as Error).message });
  } finally {
    inFlight = false;
  }
}

/**
 * Force a reconciliation pass regardless of throttle (used by tests and
 * one-off scripts).
 */
export async function reconcileNow(): Promise<{
  scanned: number;
  registered: number;
  deposited: number;
}> {
  const sheets = await loadSheetsMod();
  const coins = await loadCoinsMod();
  const token = await sheets.getAccessToken();

  const today = todayChicago();

  // Pull the registered chore-id set from the Chores tab. The Chores tab's
  // first column is chore_id — anything else (paint_kitchen, etc.) is an
  // agent invention and should be ignored.
  const choreDefs = await sheets.readRange(SILVERTHORNE_SHEET, 'Chores!A:A', { token });
  const validChoreIds = new Set<string>();
  for (let i = 1; i < choreDefs.length; i++) {
    const id = String(choreDefs[i][0] || '').trim();
    if (id) validChoreIds.add(id);
  }

  // Pull today's Chore Log rows. Columns: [timestamp, chore_id, name, done_by, duration_min, status, notes].
  const logRows = await sheets.readRange(SILVERTHORNE_SHEET, 'Chore Log!A:G', { token });
  const todays = logRows.filter((r) => String(r[0] || '').startsWith(today) && String(r[5] || '') !== 'invalid');

  let scanned = 0;
  let registered = 0;
  let deposited = 0;

  for (const row of todays) {
    scanned++;
    const choreId = String(row[1] || '').trim();
    const doneBy = String(row[3] || '').trim();
    if (!choreId || !doneBy) continue;
    if (!validChoreIds.has(choreId)) continue; // invented or unknown — skip
    if (!VALID_PLAYERS.has(doneBy)) continue; // unknown player (e.g. Macy) — skip
    registered++;

    try {
      const before = await coins.getBalance(doneBy);
      const after = await coins.deposit(doneBy, `chore:${choreId}:${today}`, `chore:${choreId}`);
      if (after > before) {
        deposited++;
        log.info('Reconciled wordle coin', {
          owner: doneBy,
          choreId,
          before,
          after,
        });
      }
    } catch (err) {
      log.warn('Reconciliation deposit failed', {
        owner: doneBy,
        choreId,
        err: (err as Error).message,
      });
    }
  }

  return { scanned, registered, deposited };
}
