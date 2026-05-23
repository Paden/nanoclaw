// Persistent per-player coin bank for Wordle. State lives in two tabs on
// the Portillo Games sheet:
//   - Wordle Coins (one row per player, in-place updates)
//   - Wordle Coins Log (append-only audit)
//
// All sheet I/O is injected via `deps` so tests run without network. In
// production, callers wire `deps` to the live sheet helpers.
//
// Idempotency: each balance-changing call carries an `eventId`. If the
// player's stored `last_event_id` already matches, the call is a no-op.
// This protects against retried /chore or /wordle submissions doubling
// the deposit/withdrawal.

import {
  getAccessToken as defaultGetToken,
  readRange as defaultReadRange,
  updateRange as defaultUpdateRange,
  appendRows as defaultAppendRows,
} from './sheets.mjs';

export const PORTILLO_GAMES_SHEET = '1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY';
export const COIN_CAP = 10;
export const COINS_TAB = 'Wordle Coins!A:D';
export const LOG_TAB = 'Wordle Coins Log!A:F';

const HEADER_ROWS = 1;

function defaultDeps() {
  return {
    tokenFn: defaultGetToken,
    readRangeFn: defaultReadRange,
    updateRangeFn: defaultUpdateRange,
    appendRowsFn: defaultAppendRows,
  };
}

async function loadCoinsRows(deps, token) {
  return await deps.readRangeFn(PORTILLO_GAMES_SHEET, COINS_TAB, { token });
}

function findRow(rows, player) {
  // 1-indexed sheet row number. Row 1 is the header, so the first player
  // sits at row 2.
  for (let i = HEADER_ROWS; i < rows.length; i++) {
    if (rows[i][0] === player) {
      return { row: rows[i], rowNum: i + 1 };
    }
  }
  return null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export async function getBalance(player, deps = defaultDeps()) {
  const token = await deps.tokenFn();
  const rows = await loadCoinsRows(deps, token);
  const hit = findRow(rows, player);
  if (!hit) return 0;
  return parseInt(hit.row[1], 10) || 0;
}

async function applyDelta({ player, delta, reason, eventId, clampMode, deps }) {
  const token = await deps.tokenFn();
  const rows = await loadCoinsRows(deps, token);
  const hit = findRow(rows, player);
  if (!hit) {
    throw new Error(`Wordle Coins row not found for player: ${player}`);
  }
  const current = parseInt(hit.row[1], 10) || 0;
  const lastEventId = hit.row[3] || '';

  // Idempotency check
  if (eventId && lastEventId === eventId) {
    return current;
  }

  let next;
  if (clampMode === 'cap') {
    next = clamp(current + delta, 0, COIN_CAP);
  } else if (clampMode === 'set') {
    next = clamp(delta, 0, COIN_CAP); // delta is the absolute target in 'set'
  } else {
    throw new Error(`unknown clampMode: ${clampMode}`);
  }

  // Reject withdrawal when balance is already 0.
  if (clampMode === 'cap' && delta < 0 && current === 0) {
    throw new Error(`insufficient coins for ${player}: balance is 0`);
  }

  const now = new Date().toISOString();
  const newRow = [player, String(next), now, eventId || hit.row[3] || ''];
  await deps.updateRangeFn(
    PORTILLO_GAMES_SHEET,
    `Wordle Coins!A${hit.rowNum}:D${hit.rowNum}`,
    [newRow],
    { token },
  );

  let deltaStr;
  if (clampMode === 'set') {
    const actualDelta = next - current;
    deltaStr = actualDelta >= 0 ? `+${actualDelta}` : String(actualDelta);
  } else {
    deltaStr = delta >= 0 ? `+${delta}` : String(delta);
  }
  await deps.appendRowsFn(
    PORTILLO_GAMES_SHEET,
    LOG_TAB,
    [[now, player, deltaStr, reason, String(next), eventId || '']],
    { token },
  );

  return next;
}

export async function deposit(player, eventId, reason, deps = defaultDeps()) {
  return applyDelta({ player, delta: +1, reason, eventId, clampMode: 'cap', deps });
}

export async function withdraw(player, eventId, reason, deps = defaultDeps()) {
  return applyDelta({ player, delta: -1, reason, eventId, clampMode: 'cap', deps });
}

export async function setBalance(player, balance, reason, deps = defaultDeps()) {
  return applyDelta({
    player,
    delta: balance, // absolute target — interpreted by 'set' clampMode
    reason: `manual:${reason}`,
    eventId: null, // setBalance always writes; no idempotency
    clampMode: 'set',
    deps,
  });
}
