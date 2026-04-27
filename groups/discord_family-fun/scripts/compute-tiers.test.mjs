import { describe, it, expect, vi } from 'vitest';
import { computeBudgets } from './compute-tiers.mjs';

// Pets tab columns A–P:
// A=owner B=name C=species D=avatar E=stage_index F=stage_name G=flavor_modifier
// H=health I=happiness J=xp K=streak_days L=last_completion_date M=status
// N=legacy_xp O=last_updated P=max_health
function petRow({ owner, stage_index }) {
  return [
    owner, '', '', '', String(stage_index), '', '',
    '', '', '', '', '', '', '', '', '',
  ];
}

describe('computeBudgets', () => {
  it('maps each player to stageToBudget(stage_index)', async () => {
    const fakeRows = [
      petRow({ owner: 'Paden', stage_index: 3 }),   // Beast → 6
      petRow({ owner: 'Brenda', stage_index: 0 }),  // Egg → 7
      petRow({ owner: 'Danny', stage_index: 7 }),   // Wyrm → 4
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    const result = await computeBudgets({ readRangeFn, token: 'fake' });
    expect(result).toEqual({ Paden: 6, Brenda: 7, Danny: 4 });
    expect(readRangeFn).toHaveBeenCalledOnce();
    const [, range] = readRangeFn.mock.calls[0];
    expect(range).toBe('Pets!A2:P10000');
  });

  it('throws a clear error if a player has no Pets row', async () => {
    const fakeRows = [
      petRow({ owner: 'Paden', stage_index: 5 }),
      // Brenda missing
      petRow({ owner: 'Danny', stage_index: 1 }),
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    await expect(computeBudgets({ readRangeFn, token: 'fake' }))
      .rejects.toThrow(/Brenda/);
  });

  it('matches owner case-insensitively', async () => {
    const fakeRows = [
      petRow({ owner: 'paden', stage_index: 12 }),  // Pantheon → 2
      petRow({ owner: 'BRENDA', stage_index: 4 }),  // Spirit → 5
      petRow({ owner: 'Danny', stage_index: 9 }),   // Eldritch → 3
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    const result = await computeBudgets({ readRangeFn, token: 'fake' });
    expect(result).toEqual({ Paden: 2, Brenda: 5, Danny: 3 });
  });
});
