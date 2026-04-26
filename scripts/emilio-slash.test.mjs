import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// We'll stub fetch + dist/ipc-writer.js in module-level mocks.
// The dispatcher exports each action handler for direct invocation in tests.

import {
  runAsleep,
  runAwake,
  runFeeding,
  runUpdateFeeding,
  runAutocompleteFeedingRow,
} from './emilio-slash.mjs';

const TOKEN = 'fake-token';
const FEED_TS = '2026-04-25 17:30:00';
const PADEN = '181867944404320256';

function makeDeps(overrides = {}) {
  return {
    getToken: vi.fn(async () => TOKEN),
    readSleepLog: vi.fn(async () => [['Start', 'Duration']]),
    openSleep: vi.fn(async () => ({ ok: true, row: 5, startTime: 'now' })),
    closeSleep: vi.fn(async () => ({ ok: true, durationMin: 30 })),
    appendFeeding: vi.fn(async () => undefined),
    updateFeedingAmount: vi.fn(async () => undefined),
    readFeedings: vi.fn(async () => [
      ['Feed time', 'Amount', 'Source'],
      [FEED_TS, '1.5', 'Formula'],
    ]),
    buildStatusCard: vi.fn(async () => ({ discord: 'CARD', agentRef: '', full: 'CARD' })),
    writeIpcMessage: vi.fn(async () => '/tmp/x.json'),
    pickChime: vi.fn((evt) => ({ text: `chime:${evt}`, newState: { last: {} } })),
    loadChimeState: vi.fn(() => ({ last: {} })),
    saveChimeState: vi.fn(() => undefined),
    parseTime: vi.fn((input, now) => ({
      iso: '2026-04-25 20:00:00',
      displayLocal: '8:00 PM',
    })),
    validateAmount: vi.fn((input) => {
      const n = typeof input === 'number' ? input : parseFloat(String(input ?? ''));
      if (!Number.isFinite(n)) throw new Error(`amount must be a number (got "${input}")`);
      if (n <= 0) throw new Error(`amount must be > 0 (got ${n})`);
      if (n > 20) throw new Error(`amount must be <= 20 oz (got ${n})`);
      return n;
    }),
    now: new Date('2026-04-25T20:00:00-05:00'),
    ...overrides,
  };
}

describe('runAsleep', () => {
  it('opens a new nap when none open', async () => {
    const deps = makeDeps();
    const out = await runAsleep({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.openSleep).toHaveBeenCalledTimes(1);
    expect(deps.writeIpcMessage).toHaveBeenCalledTimes(2); // status_card + chime
  });

  it('refuses when an open nap exists', async () => {
    const deps = makeDeps({
      readSleepLog: vi.fn(async () => [
        ['Start', 'Duration'],
        ['2026-04-25 19:00:00', ''],
      ]),
    });
    const out = await runAsleep({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Open nap from/);
    expect(deps.openSleep).not.toHaveBeenCalled();
  });
});

describe('runAwake', () => {
  it('errors with no open nap', async () => {
    const deps = makeDeps();
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No open nap/);
  });

  it('errors with 2+ open naps', async () => {
    const deps = makeDeps({
      readSleepLog: vi.fn(async () => [
        ['Start', 'Duration'],
        ['2026-04-25 19:00:00', ''],
        ['2026-04-25 19:30:00', ''],
      ]),
    });
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Multiple open/);
  });

  it('closes the single open nap', async () => {
    const deps = makeDeps({
      readSleepLog: vi.fn(async () => [
        ['Start', 'Duration'],
        ['2026-04-25 19:30:00', ''],
      ]),
    });
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.closeSleep).toHaveBeenCalledTimes(1);
  });
});

describe('runFeeding', () => {
  it('appends, fires chime, rebuilds card', async () => {
    const deps = makeDeps();
    const out = await runFeeding(
      { userId: PADEN, amount: '2.5', time: 'now', source: 'Formula' },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(deps.appendFeeding).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({
        amount: 2.5,
        source: 'Formula',
      }),
    );
    expect(deps.writeIpcMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects bad amount', async () => {
    const deps = makeDeps();
    const out = await runFeeding(
      { userId: PADEN, amount: 'abc', time: 'now', source: 'Formula' },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(deps.appendFeeding).not.toHaveBeenCalled();
  });

  it('auto-closes a single open nap', async () => {
    const deps = makeDeps({
      readSleepLog: vi.fn(async () => [
        ['Start', 'Duration'],
        ['2026-04-25 19:30:00', ''],
      ]),
    });
    const out = await runFeeding(
      { userId: PADEN, amount: '2', time: 'now', source: 'Formula' },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(deps.closeSleep).toHaveBeenCalledTimes(1);
    expect(out.napClosed).toBe(true);
  });

  it('does NOT auto-close when 0 or 2+ open', async () => {
    const deps = makeDeps({
      readSleepLog: vi.fn(async () => [['Start', 'Duration']]), // zero open
    });
    await runFeeding(
      { userId: PADEN, amount: '2', time: 'now', source: 'Formula' },
      deps,
    );
    expect(deps.closeSleep).not.toHaveBeenCalled();
  });
});

describe('runUpdateFeeding', () => {
  it('updates most recent today when row arg is empty', async () => {
    const deps = makeDeps();
    const out = await runUpdateFeeding({ userId: PADEN, amount: '3', row: '' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateFeedingAmount).toHaveBeenCalledWith(TOKEN, { sheetRow: 2, amount: 3 });
  });

  it('updates by timestamp when row provided', async () => {
    const deps = makeDeps({
      readFeedings: vi.fn(async () => [
        ['Feed time', 'Amount', 'Source'],
        ['2026-04-25 09:00:00', '3', 'Formula'],
        ['2026-04-25 17:30:00', '1.5', 'Formula'],
      ]),
    });
    const out = await runUpdateFeeding(
      { userId: PADEN, amount: '2', row: '2026-04-25 09:00:00' },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(deps.updateFeedingAmount).toHaveBeenCalledWith(TOKEN, { sheetRow: 2, amount: 2 });
  });

  it('refuses cross-day row', async () => {
    const deps = makeDeps({
      readFeedings: vi.fn(async () => [
        ['Feed time', 'Amount', 'Source'],
        ['2026-04-24 22:00:00', '2', 'Formula'],
      ]),
    });
    const out = await runUpdateFeeding(
      { userId: PADEN, amount: '3', row: '2026-04-24 22:00:00' },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/today only/i);
  });

  it('errors when no feedings today', async () => {
    const deps = makeDeps({
      readFeedings: vi.fn(async () => [['Feed time', 'Amount', 'Source']]),
    });
    const out = await runUpdateFeeding({ userId: PADEN, amount: '3', row: '' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No feedings/);
  });
});

describe('runAutocompleteFeedingRow', () => {
  it('returns up to 5 today, newest first', async () => {
    const deps = makeDeps({
      readFeedings: vi.fn(async () => [
        ['Feed time', 'Amount', 'Source'],
        ['2026-04-25 09:00:00', '3', 'Formula'],
        ['2026-04-25 11:00:00', '2.5', 'Formula'],
        ['2026-04-25 17:30:00', '1.5', 'Formula'],
      ]),
    });
    const out = await runAutocompleteFeedingRow({}, deps);
    expect(out.ok).toBe(true);
    expect(out.options.length).toBe(3);
    expect(out.options[0].label).toMatch(/5:30 PM/);
    expect(out.options[0].value).toBe('2026-04-25 17:30:00');
  });
});
