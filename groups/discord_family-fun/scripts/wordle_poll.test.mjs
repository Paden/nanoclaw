import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pollWordleState, computeFingerprint } from './wordle_poll.mjs';

function makeStateRows({ paden = 0, brenda = 0, danny = 0, padenSolved = false, brendaSolved = false, dannySolved = false } = {}) {
  // Sheet shape: header + (date, player, guess_num, solved, ...)
  const today = '2026-04-25';
  const rows = [['date', 'player', 'guess_num', 'solved']];
  for (let i = 1; i <= paden; i++) rows.push([today, 'Paden', String(i), i === paden && padenSolved ? 'true' : 'false']);
  for (let i = 1; i <= brenda; i++) rows.push([today, 'Brenda', String(i), i === brenda && brendaSolved ? 'true' : 'false']);
  for (let i = 1; i <= danny; i++) rows.push([today, 'Danny', String(i), i === danny && dannySolved ? 'true' : 'false']);
  // Add a stale row from yesterday — should be filtered out
  rows.push(['2026-04-24', 'Paden', '1', 'false']);
  return rows;
}

describe('pollWordleState', () => {
  let tmpDir;
  let stateFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordle-poll-test-'));
    stateFile = path.join(tmpDir, 'wordle_poller_state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns wakeAgent=false when no state rows for today', async () => {
    const readRangeFn = vi.fn().mockResolvedValue([['date', 'player', 'guess_num', 'solved']]);
    const result = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(result.wakeAgent).toBe(false);
    expect(result.reason).toBe('no_state_rows');
  });

  it('returns wakeAgent=true on first state change with summary data', async () => {
    const readRangeFn = vi.fn().mockResolvedValue(
      makeStateRows({ paden: 2, brenda: 0, danny: 0 }),
    );
    const result = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(result.wakeAgent).toBe(true);
    expect(result.data.summary.Paden).toEqual({ guesses: 2, solved: false, done: false });
    expect(result.data.summary.Brenda).toEqual({ guesses: 0, solved: false, done: false });
    expect(result.data.summary.Danny).toEqual({ guesses: 0, solved: false, done: false });
    expect(result.data.all_done).toBe(false);
    expect(result.data.needs_resolve).toBe(false);
    // State file written
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('returns wakeAgent=false on identical second poll (no change)', async () => {
    const rows = makeStateRows({ paden: 2 });
    const readRangeFn = vi.fn().mockResolvedValue(rows);
    await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    const second = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(second.wakeAgent).toBe(false);
    expect(second.reason).toBe('no_change');
  });

  it('returns wakeAgent=true with needs_resolve when all 3 players done and not yet resolved', async () => {
    const readRangeFn = vi.fn().mockResolvedValue(
      makeStateRows({ paden: 3, brenda: 4, danny: 6, padenSolved: true, brendaSolved: true, dannySolved: false }),
    );
    const result = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(result.wakeAgent).toBe(true);
    expect(result.data.all_done).toBe(true);
    expect(result.data.needs_resolve).toBe(true);
    expect(result.data.summary.Danny.done).toBe(true); // 6 guesses unsolved = done
  });

  it('does not double-fire reveal: needs_resolve=false on second poll after marking resolved', async () => {
    const rows = makeStateRows({ paden: 3, brenda: 4, danny: 6, padenSolved: true, brendaSolved: true });
    const readRangeFn = vi.fn().mockResolvedValue(rows);
    const first = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(first.data.needs_resolve).toBe(true);
    // Second poll on the same state — fingerprint unchanged, resolved flag persisted.
    const second = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(second.wakeAgent).toBe(false);
    expect(second.reason).toBe('no_change');
  });

  it('returns wakeAgent=false on Sheets error (does not throw)', async () => {
    const readRangeFn = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(result.wakeAgent).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('marks player as done when guess_num >= 6 even unsolved', async () => {
    const readRangeFn = vi.fn().mockResolvedValue(
      makeStateRows({ paden: 6 }),
    );
    const result = await pollWordleState({
      readRangeFn,
      token: 'fake',
      sheetId: 'sheet1',
      pollerStatePath: stateFile,
      today: '2026-04-25',
    });
    expect(result.data.summary.Paden.done).toBe(true);
    expect(result.data.summary.Paden.solved).toBe(false);
  });
});

describe('computeFingerprint', () => {
  it('produces stable hash for identical inputs', () => {
    const a = computeFingerprint('2026-04-25', { Paden: { guesses: 2, solved: false, done: false } });
    const b = computeFingerprint('2026-04-25', { Paden: { guesses: 2, solved: false, done: false } });
    expect(a).toBe(b);
  });

  it('changes when summary changes', () => {
    const a = computeFingerprint('2026-04-25', { Paden: { guesses: 2, solved: false, done: false } });
    const b = computeFingerprint('2026-04-25', { Paden: { guesses: 3, solved: false, done: false } });
    expect(a).not.toBe(b);
  });
});
