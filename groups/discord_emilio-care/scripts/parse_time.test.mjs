// groups/discord_emilio-care/scripts/parse_time.test.mjs
import { describe, it, expect } from 'vitest';
import { parseTime } from './parse_time.mjs';

const NOW = new Date('2026-04-25T20:00:00-05:00'); // 8pm CDT

describe('parseTime', () => {
  it('returns now for empty/now/n input', () => {
    for (const i of ['', 'now', 'n', ' ']) {
      const r = parseTime(i, NOW);
      expect(r.iso).toBe('2026-04-25 20:00:00');
    }
  });

  it('parses bare integer minutes-ago', () => {
    expect(parseTime('5', NOW).iso).toBe('2026-04-25 19:55:00');
    expect(parseTime('45', NOW).iso).toBe('2026-04-25 19:15:00');
    expect(parseTime('90', NOW).iso).toBe('2026-04-25 18:30:00');
  });

  it('rejects bare integer >120 as ambiguous', () => {
    expect(() => parseTime('200', NOW)).toThrow(/ambiguous/);
  });

  it('parses minute suffixes', () => {
    for (const i of ['5m', '5min', '5 min ago', '5mins ago', '5 minutes ago']) {
      expect(parseTime(i, NOW).iso).toBe('2026-04-25 19:55:00');
    }
  });

  it('parses hour suffixes including decimals', () => {
    expect(parseTime('1h', NOW).iso).toBe('2026-04-25 19:00:00');
    expect(parseTime('1.5h', NOW).iso).toBe('2026-04-25 18:30:00');
    expect(parseTime('2 hours ago', NOW).iso).toBe('2026-04-25 18:00:00');
  });

  it('parses absolute 12h with am/pm', () => {
    expect(parseTime('2:30pm', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('2:30 PM', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('8pm', NOW).iso).toBe('2026-04-25 20:00:00');
  });

  it('parses absolute 24h', () => {
    expect(parseTime('14:30', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('19:55', NOW).iso).toBe('2026-04-25 19:55:00');
  });

  it('rolls absolute time to yesterday if >1h future', () => {
    // NOW=20:00, "23:30" is 3.5h future → yesterday
    expect(parseTime('23:30', NOW).iso).toBe('2026-04-24 23:30:00');
  });

  it('keeps absolute time today if ≤1h future', () => {
    // NOW=20:00, "20:30" is 30m future → still today
    expect(parseTime('20:30', NOW).iso).toBe('2026-04-25 20:30:00');
  });

  it('throws on malformed input', () => {
    expect(() => parseTime('garbage', NOW)).toThrow(/parse_time/);
    expect(() => parseTime('25:99', NOW)).toThrow(/parse_time/);
  });

  it('returns displayLocal with am/pm', () => {
    expect(parseTime('14:30', NOW).displayLocal).toBe('2:30 PM');
    expect(parseTime('5m', NOW).displayLocal).toBe('7:55 PM');
  });
});
