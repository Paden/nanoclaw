import { describe, it, expect, vi } from 'vitest';
import { resolveDay } from './resolve-day.mjs';

const TODAY = '2026-04-07';

// Pets columns A–P (16 cols).
// A=owner B=name C=species D=avatar E=stage_index F=stage_name G=flavor_modifier
// H=health I=happiness J=xp K=streak_days L=last_completion_date M=status
// N=legacy_xp O=last_updated P=max_health
function petRow({ owner, stage_index, health, max_health, status = 'alive', rowNum }) {
  const r = new Array(16).fill('');
  r[0] = owner;
  r[4] = String(stage_index);
  r[7] = String(health);
  r[12] = status;
  r[15] = String(max_health);
  r._rowNum = rowNum; // not part of sheet, but handy for asserting writes
  return r;
}

function makeDeps({ todayRows, stateRows, petsRows, cheatRows = [] }) {
  const appendRowsFn = vi.fn().mockResolvedValue({});
  const updateRangeFn = vi.fn().mockResolvedValue({});
  const readRangeFn = vi.fn().mockImplementation(async (_sheet, range) => {
    if (range.startsWith('Wordle Today')) return todayRows;
    if (range.startsWith('Wordle State')) return stateRows;
    if (range.startsWith('Cheat Log')) return cheatRows;
    if (range.startsWith('Pets!')) return petsRows;
    return [];
  });
  return {
    readRangeFn,
    appendRowsFn,
    updateRangeFn,
    token: 'fake',
    today: TODAY,
    now: '2026-04-07 18:00:00',
  };
}

describe('resolveDay', () => {
  it('writes XP rows + HP rows, updates Pets.health, and reports transitions', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    // Paden won (1 guess). Brenda solved on guess 2 (non-winner). Danny no-show.
    const stateRows = [
      [TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
      [TODAY, 'Brenda', '1', 'SLATE', '⬜⬜🟨⬜🟨', 'false'],
      [TODAY, 'Brenda', '2', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 5, health: 60, max_health: 200 }), // Spirit-ish, bigger pool
      petRow({ owner: 'Brenda', stage_index: 1, health: 30, max_health: 120 }), // Hatchling, near critical
      petRow({ owner: 'Danny',  stage_index: 7, health: 50, max_health: 240 }), // Wyrm
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('resolved');
    expect(result.winner).toBe('Paden');

    // Existing XP writes preserved (winner +20, no-show -10)
    expect(result.writes).toEqual([
      { player: 'Paden', pet: 'Voss', event_type: 'xp_gain', delta: 20, reason: 'Saga Wordle win — crane' },
      { player: 'Danny', pet: 'Zima', event_type: 'decay', delta: -10, reason: 'Saga Wordle — did not play' },
    ]);

    // HP writes: Paden won (+5+floor(5/2)=+7), Brenda solved (+2+floor(1/4)=+2), Danny no-show (−(8+7)=−15)
    expect(result.hp_writes).toEqual([
      { player: 'Paden', pet: 'Voss', event_type: 'wordle_heal', delta: 7,
        reason: 'Saga Wordle win — crane',
        prev_health: 60, new_health: 67, max_health: 200 },
      { player: 'Brenda', pet: 'Nyx', event_type: 'wordle_heal', delta: 2,
        reason: 'Saga Wordle solve — crane',
        prev_health: 30, new_health: 32, max_health: 120 },
      { player: 'Danny', pet: 'Zima', event_type: 'wordle_damage', delta: -15,
        reason: 'Saga Wordle — did not play',
        prev_health: 50, new_health: 35, max_health: 240 },
    ]);

    // appendRows called twice: XP block + HP block
    expect(deps.appendRowsFn).toHaveBeenCalledTimes(2);
    const xpAppended = deps.appendRowsFn.mock.calls[0][2];
    const hpAppended = deps.appendRowsFn.mock.calls[1][2];
    expect(xpAppended).toHaveLength(2); // Paden xp_gain + Danny decay
    expect(hpAppended).toHaveLength(3); // 3 HP rows
    expect(hpAppended[0]).toEqual([
      '2026-04-07 18:00:00', TODAY, 'Voss', 'wordle_heal', '7', 'Saga Wordle win — crane',
    ]);
    expect(hpAppended[2]).toEqual([
      '2026-04-07 18:00:00', TODAY, 'Zima', 'wordle_damage', '-15', 'Saga Wordle — did not play',
    ]);

    // Pets.health updated for each non-deceased pet via updateRange
    expect(deps.updateRangeFn).toHaveBeenCalledTimes(3);
    // Transitions: Paden 60→67 (no transition), Brenda 30→32 (still critical, no transition),
    //   Danny 50→35 (50/240=20.8% → above 20% threshold (48), 35/240=14.6% → below — entered critical)
    expect(result.transitions).toEqual([
      { player: 'Danny', pet: 'Zima', kind: 'entered_critical', new_health: 35, max_health: 240 },
    ]);
  });

  it('skips deceased pets entirely — no HP delta, no Pet Log row, no transition', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [
      [TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 3, health: 50, max_health: 160 }),
      petRow({ owner: 'Brenda', stage_index: 5, health: 0,  max_health: 200, status: 'deceased' }),
      petRow({ owner: 'Danny',  stage_index: 2, health: 80, max_health: 140 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    // Brenda is deceased — she's not in hp_writes
    expect(result.hp_writes.map((w) => w.player)).toEqual(['Paden', 'Danny']);
    // updateRange called twice (Paden + Danny) — Brenda's health cell never touched
    expect(deps.updateRangeFn).toHaveBeenCalledTimes(2);
  });

  it('detects death transitions when HP drops to 0 from wordle damage', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = []; // Everyone no-shows
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 14, health: 5, max_health: 380 }), // Source on the brink
      petRow({ owner: 'Brenda', stage_index: 1,  health: 50, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1,  health: 50, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    // Source no-show: -(8+14)=−22. 5 + (−22) = clamped to 0.
    const padenHp = result.hp_writes.find((w) => w.player === 'Paden');
    expect(padenHp.new_health).toBe(0);
    expect(result.transitions).toContainEqual(
      { player: 'Paden', pet: 'Voss', kind: 'died', new_health: 0, max_health: 380 },
    );
  });

  it('detects recovered transitions when HP climbs above 40%', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    // Paden wins
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      // Paden at 38/100 (38% — critical). Win at stage 5: +5+floor(5/2)=+7. 38+7=45 → 45% → recovered.
      petRow({ owner: 'Paden',  stage_index: 5, health: 38, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.transitions).toContainEqual(
      { player: 'Paden', pet: 'Voss', kind: 'recovered', new_health: 45, max_health: 100 },
    );
  });

  it('clamps health at max_health on heal', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      // Paden at 99/100, win heal +5 should clamp at 100 not overflow
      petRow({ owner: 'Paden',  stage_index: 1, health: 99, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    const paden = result.hp_writes.find((w) => w.player === 'Paden');
    expect(paden.new_health).toBe(100);
  });

  it('Egg-stage pets skip HP delta entirely', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 0, health: 50, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    expect(result.hp_writes.map((w) => w.player)).not.toContain('Paden');
  });

  it('does not emit a phantom recovered transition when prev_health <= 0', async () => {
    // Hypothetical: a pet whose row shows health=0 but status='alive' (data
    // inconsistency or future revive flow). A heal must NOT trigger 'recovered'.
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 5, health: 0, max_health: 100 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 1, health: 100, max_health: 120 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows });
    const result = await resolveDay(deps);

    // Paden won at stage 5: heal +7 → 0 + 7 = 7 / 100 = 7% — well under 40%
    // recovered threshold AND prev was 0, so no transition either way.
    const paden = result.hp_writes.find((w) => w.player === 'Paden');
    expect(paden.new_health).toBe(7);
    expect(result.transitions).toEqual([]);
  });

  it('holds stakes when a cheat review is pending — no HP writes either', async () => {
    const todayRows = [[TODAY, 'crane', '{"Paden":6,"Brenda":7,"Danny":5}']];
    const stateRows = [[TODAY, 'Paden', '1', 'CRANE', '🟩🟩🟩🟩🟩', 'true']];
    const cheatRows = [
      ['2026-04-07 09:00:00', TODAY, 'Paden', 'one_guess_solve', 'crane', '1', 'pending_review', '', 'FALSE'],
    ];
    const petsRows = [
      petRow({ owner: 'Paden',  stage_index: 5, health: 60, max_health: 200 }),
      petRow({ owner: 'Brenda', stage_index: 1, health: 100, max_health: 120 }),
      petRow({ owner: 'Danny',  stage_index: 7, health: 50, max_health: 240 }),
    ];
    const deps = makeDeps({ todayRows, stateRows, petsRows, cheatRows });
    const result = await resolveDay(deps);

    expect(result.status).toBe('stakes_held');
    expect(deps.appendRowsFn).not.toHaveBeenCalled();
    expect(deps.updateRangeFn).not.toHaveBeenCalled();
  });

  it('returns no_puzzle when no row for today', async () => {
    const deps = makeDeps({ todayRows: [], stateRows: [], petsRows: [] });
    const result = await resolveDay(deps);
    expect(result.status).toBe('no_puzzle');
  });
});
