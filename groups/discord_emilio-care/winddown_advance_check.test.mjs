import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  composeAdvanceReminder,
  computeWindow,
  runAdvanceCheck,
} from './winddown_advance_check.mjs';

// Build a Date that lands at the given Chicago local time (CDT, UTC-5 in April).
function chiDate({ year = 2026, month = 4, day = 25, hour = 14, minute = 0 } = {}) {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-05:00`;
  return new Date(iso);
}

// Build a Sleep Log [start, dur] row with start at a Chicago local time.
function makeRow({ year = 2026, month = 4, day = 25, hour = 12, minute = 0, durMin }) {
  const start = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  return [start, String(durMin)];
}

describe('composeAdvanceReminder', () => {
  it('produces the canonical wind-down reminder line', () => {
    const line = composeAdvanceReminder({
      windDownTime: '2:30 PM',
      sleepByTime: '2:45 PM',
      shortNap: false,
    });
    expect(line).toContain('2:30 PM');
    expect(line).toContain('2:45 PM');
    expect(line).toMatch(/😴/);
    expect(line).not.toMatch(/⚡/);
  });

  it('appends ⚡ when shortNap is true', () => {
    const line = composeAdvanceReminder({
      windDownTime: '2:30 PM',
      sleepByTime: '2:45 PM',
      shortNap: true,
    });
    expect(line).toMatch(/⚡/);
  });
});

describe('computeWindow', () => {
  it('returns null when no row is provided', () => {
    expect(computeWindow({ lastRow: null, now: chiDate() })).toBeNull();
    expect(computeWindow({ lastRow: [], now: chiDate() })).toBeNull();
  });

  it('returns null when duration is missing or zero', () => {
    expect(computeWindow({ lastRow: ['2026-04-25 12:00:00', ''], now: chiDate() })).toBeNull();
    expect(computeWindow({ lastRow: ['2026-04-25 12:00:00', '0'], now: chiDate() })).toBeNull();
  });

  it('returns null when the nap was on a previous day', () => {
    const row = makeRow({ day: 24, hour: 12, durMin: 60 });
    expect(computeWindow({ lastRow: row, now: chiDate({ day: 25 }) })).toBeNull();
  });

  it('long nap: windDown = wake + 70, sleepBy = wake + 90, shortNap=false', () => {
    // Nap starts 12:00, 60 min → wakes 13:00. windDown = 14:10. sleepBy = 14:30.
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const w = computeWindow({ lastRow: row, now: chiDate({ hour: 14, minute: 5 }) });
    expect(w.shortNap).toBe(false);
    expect(w.windDownMin).toBe(14 * 60 + 10);
    expect(w.sleepByMin).toBe(14 * 60 + 30);
    expect(w.diff).toBe(5);
  });

  it('short nap: windDown = wake + 45, sleepBy = wake + 60, shortNap=true', () => {
    // Nap starts 12:00, 30 min → wakes 12:30. windDown = 13:15. sleepBy = 13:30.
    const row = makeRow({ hour: 12, minute: 0, durMin: 30 });
    const w = computeWindow({ lastRow: row, now: chiDate({ hour: 13, minute: 10 }) });
    expect(w.shortNap).toBe(true);
    expect(w.windDownMin).toBe(13 * 60 + 15);
    expect(w.sleepByMin).toBe(13 * 60 + 30);
    expect(w.diff).toBe(5);
  });
});

describe('runAdvanceCheck', () => {
  let tmpRoot;
  let statePath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'winddown-advance-test-'));
    statePath = path.join(tmpRoot, 'winddown_advance_state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('always returns wakeAgent: false', async () => {
    const sheetsReader = vi.fn().mockResolvedValue(null);
    const writeIpcMessageFn = vi.fn();
    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 14 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('fires inside the 0–10 min lead-up window for a long nap', async () => {
    // Nap 12:00, 60 min → wake 13:00, windDown 14:10. At 14:05, diff = 5 → fires.
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn().mockResolvedValue('/tmp/x.json');

    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });

    expect(out.wakeAgent).toBe(false);
    expect(out.data.posted).toBe(true);
    expect(out.data.windDownTime).toBe('2:10 PM');
    expect(out.data.sleepByTime).toBe('2:30 PM');
    expect(out.data.shortNap).toBe(false);

    expect(writeIpcMessageFn).toHaveBeenCalledTimes(1);
    const [group, msg] = writeIpcMessageFn.mock.calls[0];
    expect(group).toBe('discord_emilio-care');
    expect(msg.type).toBe('message');
    expect(msg.chatJid).toBe('dc:1490781468182577172');
    expect(msg.sender).toBeUndefined();
    expect(msg.text).toContain('2:10 PM');
    expect(msg.text).toContain('2:30 PM');
    expect(msg.text).not.toMatch(/⚡/);
  });

  it('appends ⚡ for a short nap branch', async () => {
    // Nap 12:00, 30 min → wake 12:30, windDown 13:15. At 13:10, diff = 5 → fires, shortNap=true.
    const row = makeRow({ hour: 12, minute: 0, durMin: 30 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn().mockResolvedValue('ok');

    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 13, minute: 10 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });

    expect(out.data.shortNap).toBe(true);
    expect(writeIpcMessageFn.mock.calls[0][1].text).toMatch(/⚡/);
  });

  it('does not fire when the wind-down is more than 10 min away', async () => {
    // Nap 12:00, 60 min → windDown 14:10. At 13:50, diff = 20 → skip.
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn();

    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 13, minute: 50 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('does not fire when the wind-down has already passed (negative diff)', async () => {
    // windDown 14:10, now 14:15 → diff = -5 → skip.
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn();

    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 14, minute: 15 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('dedupes — second run for the same slot does not fire again', async () => {
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn().mockResolvedValue('ok');

    const params = {
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    };

    const out1 = await runAdvanceCheck(params);
    expect(out1.data.posted).toBe(true);

    const out2 = await runAdvanceCheck(params);
    expect(out2.wakeAgent).toBe(false);
    expect(out2.data).toBeUndefined();
    expect(writeIpcMessageFn).toHaveBeenCalledTimes(1);
  });

  it('does not persist state when IPC post fails — next tick retries', async () => {
    const row = makeRow({ hour: 12, minute: 0, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('ok');

    const params = {
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    };

    const out1 = await runAdvanceCheck(params);
    expect(out1.data.posted).toBe(false);
    expect(out1.data.post_error).toContain('disk full');
    expect(fs.existsSync(statePath)).toBe(false);

    const out2 = await runAdvanceCheck(params);
    expect(out2.data.posted).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('returns wakeAgent: false when sheets reader fails', async () => {
    const sheetsReader = vi.fn().mockRejectedValue(new Error('auth dead'));
    const writeIpcMessageFn = vi.fn();
    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ hour: 14 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('returns wakeAgent: false when last row is from yesterday', async () => {
    const row = makeRow({ day: 24, hour: 22, durMin: 60 });
    const sheetsReader = vi.fn().mockResolvedValue(row);
    const writeIpcMessageFn = vi.fn();
    const out = await runAdvanceCheck({
      nowFn: () => chiDate({ day: 25, hour: 14 }),
      sheetsReader,
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });
});
