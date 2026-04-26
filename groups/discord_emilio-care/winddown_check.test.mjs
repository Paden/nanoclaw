import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  composeReminder,
  runWindDownCheck,
} from './winddown_check.mjs';

// Build a fake status card output that build_status_card.mjs would emit.
// build_status_card includes a line with `⏰ Wind-down: H:MM AM/PM · 💤 Sleep by: H:MM AM/PM`,
// optionally followed by `⚡ (short nap)` somewhere in the body.
function makeCard({
  windDown = '8:10 PM',
  sleepBy = '8:25 PM',
  shortNap = false,
} = {}) {
  let card = `Some preamble line\n⏰ Wind-down: ${windDown} · 💤 Sleep by: ${sleepBy}\n`;
  if (shortNap) card += '⚡ (short nap)\n';
  card += '═══ AGENT REF ═══\nrow data here';
  return card;
}

// Build a Date that, when read in America/Chicago, lands at the given local time.
// April 25 2026 is CDT (UTC-5). Hardcoding the offset keeps tests deterministic.
function chiDate({ year = 2026, month = 4, day = 25, hour = 10, minute = 0 } = {}) {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-05:00`;
  return new Date(iso);
}

describe('composeReminder', () => {
  it('rotates between three templates by hash of windDownMin', () => {
    const out = new Set();
    for (let m = 0; m < 30; m++) {
      out.add(composeReminder({ sleepTime: '8:25 PM', shortNap: false, windDownMin: m }));
    }
    expect(out.size).toBe(3);
  });

  it('mentions the sleep target time', () => {
    const line = composeReminder({ sleepTime: '8:25 PM', shortNap: false, windDownMin: 0 });
    expect(line).toContain('8:25 PM');
  });

  it('appends short-nap qualifier when shortNap is true', () => {
    const line = composeReminder({ sleepTime: '8:00 PM', shortNap: true, windDownMin: 0 });
    expect(line.toLowerCase()).toContain('short nap');
  });
});

describe('runWindDownCheck', () => {
  let tmpRoot;
  let statePath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'winddown-check-test-'));
    statePath = path.join(tmpRoot, 'winddown_state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('always returns wakeAgent: false (early-hours skip)', async () => {
    const out = await runWindDownCheck({
      nowFn: () => chiDate({ hour: 5 }),
      cardBuilder: vi.fn(),
      writeIpcMessageFn: vi.fn(),
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
  });

  it('always returns wakeAgent: false (late-hours skip)', async () => {
    const out = await runWindDownCheck({
      nowFn: () => chiDate({ hour: 22 }),
      cardBuilder: vi.fn(),
      writeIpcMessageFn: vi.fn(),
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
  });

  it('skips when current Chicago hour is at or past the 8pm cutoff', async () => {
    const writeIpcMessageFn = vi.fn().mockResolvedValue('/tmp/x.json');
    const out = await runWindDownCheck({
      // hour=20 is rejected by the 7-19 gate (cp.hour >= 20)
      nowFn: () => chiDate({ hour: 20, minute: 12 }),
      cardBuilder: () => makeCard({ windDown: '8:10 PM', sleepBy: '8:25 PM' }),
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('fires inside the 0–15 min post-windDown window (7am–8pm Chicago)', async () => {
    const writeIpcMessageFn = vi.fn().mockResolvedValue('/tmp/x.json');
    const out = await runWindDownCheck({
      // 7:55 PM Chicago, wind-down was 7:50 PM → diff 5, fires (hour=19 ok)
      nowFn: () => chiDate({ hour: 19, minute: 55 }),
      cardBuilder: () => makeCard({ windDown: '7:50 PM', sleepBy: '8:05 PM' }),
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.data.posted).toBe(true);
    expect(out.data.sleepTime).toBe('8:05 PM');
    expect(writeIpcMessageFn).toHaveBeenCalledTimes(1);
    const [group, msg] = writeIpcMessageFn.mock.calls[0];
    expect(group).toBe('discord_emilio-care');
    expect(msg.type).toBe('message');
    expect(msg.chatJid).toBe('dc:1490781468182577172');
    expect(msg.sender).toBeUndefined(); // Claudio voice — no sender
    expect(msg.text).toContain('8:05 PM');
  });

  it('skips when more than 15 min past the wind-down time', async () => {
    const writeIpcMessageFn = vi.fn();
    const out = await runWindDownCheck({
      // 7:30 PM, wind-down was 7:00 PM → diff 30, skip
      nowFn: () => chiDate({ hour: 19, minute: 30 }),
      cardBuilder: () => makeCard({ windDown: '7:00 PM', sleepBy: '7:15 PM' }),
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('marks shortNap and tightens the message', async () => {
    const writeIpcMessageFn = vi.fn().mockResolvedValue('ok');
    const out = await runWindDownCheck({
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      cardBuilder: () => makeCard({ windDown: '2:00 PM', sleepBy: '2:15 PM', shortNap: true }),
      writeIpcMessageFn,
      statePath,
    });
    expect(out.data.shortNap).toBe(true);
    const text = writeIpcMessageFn.mock.calls[0][1].text;
    expect(text.toLowerCase()).toContain('short nap');
  });

  it('dedupes — does not fire twice for the same wind-down slot', async () => {
    const writeIpcMessageFn = vi.fn().mockResolvedValue('ok');
    const params = {
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      cardBuilder: () => makeCard({ windDown: '2:00 PM', sleepBy: '2:15 PM' }),
      writeIpcMessageFn,
      statePath,
    };
    const out1 = await runWindDownCheck(params);
    expect(out1.data?.posted).toBe(true);

    const out2 = await runWindDownCheck(params);
    expect(out2.wakeAgent).toBe(false);
    expect(out2.data).toBeUndefined();
    expect(writeIpcMessageFn).toHaveBeenCalledTimes(1);
  });

  it('does not persist state when the IPC post fails — next tick retries', async () => {
    const writeIpcMessageFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('ok');
    const params = {
      nowFn: () => chiDate({ hour: 14, minute: 5 }),
      cardBuilder: () => makeCard({ windDown: '2:00 PM', sleepBy: '2:15 PM' }),
      writeIpcMessageFn,
      statePath,
    };

    const out1 = await runWindDownCheck(params);
    expect(out1.wakeAgent).toBe(false);
    expect(out1.data.posted).toBe(false);
    expect(out1.data.post_error).toContain('disk full');
    expect(fs.existsSync(statePath)).toBe(false);

    const out2 = await runWindDownCheck(params);
    expect(out2.data.posted).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('returns wakeAgent: false when card builder fails', async () => {
    const writeIpcMessageFn = vi.fn();
    const out = await runWindDownCheck({
      nowFn: () => chiDate({ hour: 14 }),
      cardBuilder: () => {
        throw new Error('build_status_card exploded');
      },
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('returns wakeAgent: false when wind-down line is missing from the card', async () => {
    const writeIpcMessageFn = vi.fn();
    const out = await runWindDownCheck({
      nowFn: () => chiDate({ hour: 14 }),
      cardBuilder: () => 'no winddown info here',
      writeIpcMessageFn,
      statePath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });
});
