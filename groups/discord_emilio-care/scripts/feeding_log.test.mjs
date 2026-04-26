// groups/discord_emilio-care/scripts/feeding_log.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { computeRecentFeedings, validateAmount } from './feeding_log.mjs';

describe('validateAmount', () => {
  it('accepts 0.1–20', () => {
    expect(validateAmount('2.5')).toBe(2.5);
    expect(validateAmount('0.5')).toBe(0.5);
    expect(validateAmount(20)).toBe(20);
  });
  it('rejects non-positive, non-numeric, >20', () => {
    expect(() => validateAmount('0')).toThrow();
    expect(() => validateAmount('abc')).toThrow();
    expect(() => validateAmount('25')).toThrow();
    expect(() => validateAmount('-1')).toThrow();
  });
});

describe('computeRecentFeedings', () => {
  const today = '2026-04-25';
  const rows = [
    ['Feed time', 'Amount (oz)', 'Source'],
    ['2026-04-25 09:00:00', '3', 'Formula'],
    ['2026-04-25 11:00:00', '2.5', 'Formula'],
    ['2026-04-24 22:00:00', '2', 'Formula'], // yesterday — excluded
    ['2026-04-25 17:30:00', '1.5', 'Formula'],
  ];

  it('returns today rows newest-first capped at limit', () => {
    const out = computeRecentFeedings(rows, today, 5);
    expect(out.map((r) => r.timestamp)).toEqual([
      '2026-04-25 17:30:00',
      '2026-04-25 11:00:00',
      '2026-04-25 09:00:00',
    ]);
  });

  it('honors limit', () => {
    expect(computeRecentFeedings(rows, today, 2).length).toBe(2);
  });

  it('returns empty when no rows for today', () => {
    expect(computeRecentFeedings(rows, '2026-04-26', 5)).toEqual([]);
  });

  it('preserves row index for sheet updates', () => {
    const out = computeRecentFeedings(rows, today, 5);
    // Row indices in the sheet are 1-based with header at row 1.
    // Newest (17:30) is rows[4] → sheet row 5.
    expect(out[0].sheetRow).toBe(5);
  });
});
