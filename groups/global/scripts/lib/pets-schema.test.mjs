import { describe, it, expect } from 'vitest';
import { PETS_COL, PETS_HEADERS, nowTsChicago } from './pets-schema.mjs';

describe('PETS_COL', () => {
  it('matches the Silverthorne Pets tab schema (columns A–P)', () => {
    expect(PETS_COL).toEqual({
      owner: 0,
      name: 1,
      species: 2,
      avatar: 3,
      stage_index: 4,
      stage_name: 5,
      flavor_modifier: 6,
      health: 7,
      happiness: 8,
      xp: 9,
      streak_days: 10,
      last_completion_date: 11,
      status: 12,
      legacy_xp: 13,
      last_updated: 14,
      max_health: 15,
    });
  });

  it('PETS_HEADERS is a parallel array — index N matches PETS_COL.<key>', () => {
    expect(PETS_HEADERS).toHaveLength(16);
    for (const [key, idx] of Object.entries(PETS_COL)) {
      expect(PETS_HEADERS[idx]).toBe(key);
    }
  });
});

describe('nowTsChicago', () => {
  it('returns YYYY-MM-DD HH:MM:SS in Chicago local time', () => {
    const ts = nowTsChicago();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('accepts an injected Date for deterministic output', () => {
    // 2026-04-27T14:30:00Z = 09:30:00 CDT (UTC-5)
    const fixed = new Date('2026-04-27T14:30:00Z');
    expect(nowTsChicago(fixed)).toBe('2026-04-27 09:30:00');
  });

  it('handles a UTC date that crosses the day boundary in Chicago', () => {
    // 2026-04-27T03:00:00Z = 22:00:00 CDT on 2026-04-26
    const fixed = new Date('2026-04-27T03:00:00Z');
    expect(nowTsChicago(fixed)).toBe('2026-04-26 22:00:00');
  });
});
