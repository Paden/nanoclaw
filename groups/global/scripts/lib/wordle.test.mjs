import { describe, it, expect } from 'vitest';
import {
  tierForXp,
  lifetimeXp,
  scoreGuess,
  isValidGuessShape,
  determineWinner,
  computeDayStakes,
  renderCard,
  stageToBudget,
  computeWordleHpDelta,
} from './wordle.mjs';

describe('stageToBudget', () => {
  it('maps Egg and Hatchling to 7 guesses', () => {
    expect(stageToBudget(0)).toBe(7);
    expect(stageToBudget(1)).toBe(7);
  });
  it('maps Critter and Beast to 6 guesses', () => {
    expect(stageToBudget(2)).toBe(6);
    expect(stageToBudget(3)).toBe(6);
  });
  it('maps Spirit and Elemental to 5 guesses', () => {
    expect(stageToBudget(4)).toBe(5);
    expect(stageToBudget(5)).toBe(5);
  });
  it('maps Chimera and Wyrm to 4 guesses', () => {
    expect(stageToBudget(6)).toBe(4);
    expect(stageToBudget(7)).toBe(4);
  });
  it('maps Celestial through Deity to 3 guesses', () => {
    expect(stageToBudget(8)).toBe(3);
    expect(stageToBudget(9)).toBe(3);
    expect(stageToBudget(10)).toBe(3);
    expect(stageToBudget(11)).toBe(3);
  });
  it('maps Pantheon through Source to 2 guesses', () => {
    expect(stageToBudget(12)).toBe(2);
    expect(stageToBudget(13)).toBe(2);
    expect(stageToBudget(14)).toBe(2);
  });
});

describe('computeWordleHpDelta', () => {
  const W = (player) => ({ player, played: true, solved: true });
  const S = (player) => ({ player, played: true, solved: true });
  const F = (player) => ({ player, played: true, solved: false });
  const N = (player) => ({ player, played: false, solved: false });

  it('returns null at Egg (stage 0) for every outcome', () => {
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 0 })).toBeNull();
  });

  it('won (winner) heals 5 + floor(stage/2)', () => {
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_heal', delta: 5 });
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_heal', delta: 8 });
    expect(computeWordleHpDelta({ entry: W('Paden'), winner: 'Paden', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_heal', delta: 12 });
  });

  it('solved-non-winner heals 2 + floor(stage/4)', () => {
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_heal', delta: 2 });
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_heal', delta: 3 });
    expect(computeWordleHpDelta({ entry: S('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_heal', delta: 5 });
  });

  it('failed (played, did not solve) damages 5 + stage', () => {
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_damage', delta: -6 });
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_damage', delta: -12 });
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_damage', delta: -19 });
  });

  it('no-show (did not play) damages 8 + stage', () => {
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 1 }))
      .toEqual({ event_type: 'wordle_damage', delta: -9 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 7 }))
      .toEqual({ event_type: 'wordle_damage', delta: -15 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: 'Brenda', stage_index: 14 }))
      .toEqual({ event_type: 'wordle_damage', delta: -22 });
  });

  it('handles winner === null (nobody solved): all players who played are failed', () => {
    expect(computeWordleHpDelta({ entry: F('Paden'), winner: null, stage_index: 5 }))
      .toEqual({ event_type: 'wordle_damage', delta: -10 });
    expect(computeWordleHpDelta({ entry: N('Paden'), winner: null, stage_index: 5 }))
      .toEqual({ event_type: 'wordle_damage', delta: -13 });
  });
});

describe('tierForXp', () => {
  it('returns Hatchling/7 for new pets', () => {
    expect(tierForXp(0)).toEqual({ tier: 'Hatchling', guesses: 7 });
    expect(tierForXp(499)).toEqual({ tier: 'Hatchling', guesses: 7 });
  });
  it('promotes at exact thresholds', () => {
    expect(tierForXp(500).tier).toBe('Fledgling');
    expect(tierForXp(1500).tier).toBe('Adept');
    expect(tierForXp(3000).tier).toBe('Apex');
  });
  it('Apex caps at 4 guesses', () => {
    expect(tierForXp(99999)).toEqual({ tier: 'Apex', guesses: 4 });
  });
});

describe('lifetimeXp', () => {
  const rows = [
    ['ts', 'd', 'Voss', 'xp_gain', '20', 'wordle win'],
    ['ts', 'd', 'Voss', 'decay', '-10', 'wordle loss'],
    ['ts', 'd', 'Nyx', 'xp_gain', '20', 'wordle win'],
    ['ts', 'd', 'Voss', 'xp_gain', '100', 'big win'],
    ['ts', 'd', 'Voss', 'xp_gain', 'not-a-number', 'bad row'],
  ];
  it('sums only xp_gain rows for the named pet', () => {
    expect(lifetimeXp(rows, 'Voss')).toBe(120);
    expect(lifetimeXp(rows, 'Nyx')).toBe(20);
  });
  it('ignores decay events (soft reset = easier mode)', () => {
    const decayHeavy = [
      ['ts', 'd', 'Voss', 'xp_gain', '500', 'win'],
      ['ts', 'd', 'Voss', 'decay', '-400', 'loss'],
    ];
    expect(lifetimeXp(decayHeavy, 'Voss')).toBe(500);
  });
  it('returns 0 for an unknown pet', () => {
    expect(lifetimeXp(rows, 'Zima')).toBe(0);
  });
});

describe('scoreGuess', () => {
  it('all greens for an exact match', () => {
    expect(scoreGuess('crane', 'crane')).toBe('🟩🟩🟩🟩🟩');
  });
  it('all gray when nothing matches', () => {
    expect(scoreGuess('blimp', 'crane')).toBe('⬜⬜⬜⬜⬜');
  });
  it('mixes greens and yellows', () => {
    // answer crane, guess caret → c green, a green, r yellow, e yellow, t gray
    expect(scoreGuess('caret', 'crane')).toBe('🟩🟨🟨🟨⬜');
  });
  it('handles duplicate letters correctly', () => {
    // answer abide, guess eerie:
    // greens pass: only pos 4 (e==e) → 🟩 at pos 4. remaining = {a,b,i,d}
    // yellows: pos 0 e (no e left) gray, pos 1 e gray, pos 2 r gray,
    //   pos 3 i (i in remaining) → yellow
    expect(scoreGuess('eerie', 'abide')).toBe('⬜⬜⬜🟨🟩');
  });
  it('green takes priority over yellow for duplicates', () => {
    // answer lever, guess eevee:
    // greens: pos 1 e==e, pos 2 v==v, pos 3 e==e → 🟩🟩🟩 at 1/2/3
    //   remaining = {l, r} (both e's consumed by greens)
    // yellows: pos 0 e (no e left) gray, pos 4 e gray
    expect(scoreGuess('eevee', 'lever')).toBe('⬜🟩🟩🟩⬜');
  });
  it('throws on length mismatch', () => {
    expect(() => scoreGuess('abc', 'crane')).toThrow();
  });
});

describe('isValidGuessShape', () => {
  it('accepts the right length and alphabetic chars', () => {
    expect(isValidGuessShape('crane', 5)).toBe(true);
    expect(isValidGuessShape('CRANE', 5)).toBe(true);
  });
  it('rejects wrong length', () => {
    expect(isValidGuessShape('cran', 5)).toBe(false);
    expect(isValidGuessShape('cranes', 5)).toBe(false);
  });
  it('rejects non-alphabetic', () => {
    expect(isValidGuessShape('cran3', 5)).toBe(false);
    expect(isValidGuessShape('cra ne', 5)).toBe(false);
  });
});

describe('determineWinner', () => {
  it('picks fewest-guess solver', () => {
    const w = determineWinner([
      { player: 'Paden', guesses: 4, solved: true, solved_at: '2026-04-07 10:00:00' },
      { player: 'Brenda', guesses: 3, solved: true, solved_at: '2026-04-07 11:00:00' },
    ]);
    expect(w).toBe('Brenda');
  });
  it('breaks ties by earliest solved_row_index', () => {
    const w = determineWinner([
      { player: 'Brenda', guesses: 3, solved: true, solved_row_index: 7 },
      { player: 'Danny', guesses: 3, solved: true, solved_row_index: 2 },
    ]);
    expect(w).toBe('Danny');
  });
  it('falls back to solved_at when row indices are missing', () => {
    const w = determineWinner([
      { player: 'Paden', guesses: 3, solved: true, solved_at: '2026-04-07 11:00:00' },
      { player: 'Brenda', guesses: 3, solved: true, solved_at: '2026-04-07 10:00:00' },
    ]);
    expect(w).toBe('Brenda');
  });
  it('returns null when nobody solved', () => {
    expect(
      determineWinner([
        { player: 'Paden', guesses: 6, solved: false },
        { player: 'Brenda', guesses: 7, solved: false },
      ]),
    ).toBeNull();
  });
});

describe('computeDayStakes', () => {
  it('winner gets +20, failed get -10, solved non-winner gets nothing', () => {
    const writes = computeDayStakes({
      word: 'crane',
      winner: 'Brenda',
      entries: [
        { player: 'Brenda', pet: 'Nyx', solved: true, played: true },
        { player: 'Paden', pet: 'Voss', solved: true, played: true },
        { player: 'Danny', pet: 'Zima', solved: false, played: true },
      ],
    });
    expect(writes).toEqual([
      { player: 'Brenda', pet: 'Nyx', event_type: 'xp_gain', delta: 20, reason: 'Saga Wordle win — crane' },
      { player: 'Danny', pet: 'Zima', event_type: 'decay', delta: -10, reason: 'Saga Wordle — failed to solve' },
    ]);
  });
  it('no-show gets -10 with did-not-play reason', () => {
    const writes = computeDayStakes({
      word: 'crane',
      winner: null,
      entries: [{ player: 'Paden', pet: 'Voss', solved: false, played: false }],
    });
    expect(writes[0].reason).toBe('Saga Wordle — did not play');
  });
});

describe('renderCard', () => {
  const base = {
    day: 12,
    date: 'Apr 7',
    genre: 'pirate space opera',
    word: 'crane',
    resolved: false,
    players: [
      { player: 'Paden', pet: 'Voss', petEmoji: '🌋', guessCount: 2, solved: false, budget: 6 },
      { player: 'Brenda', pet: 'Nyx', petEmoji: '🌙', guessCount: 0, solved: false, budget: 7 },
    ],
    leaderboard: {
      Paden: { wins: 12, streak: 3, best: 7, avg: 4.1 },
      Brenda: { wins: 15, streak: 7, best: 11, avg: 3.8 },
    },
    lastChapterOpening: 'The comet shivered.',
  };
  it('renders in-progress counts', () => {
    const out = renderCard(base);
    expect(out).toContain('Day 12');
    expect(out).toContain('2/6 guesses');
    expect(out).toContain('not started');
    expect(out).toContain('🏆 All-time');
    expect(out).toContain('The comet shivered.');
  });
  it('renders resolved state', () => {
    const out = renderCard({
      ...base,
      resolved: true,
      players: [
        { ...base.players[0], guessCount: 3, solved: true },
        { ...base.players[1], guessCount: 7, solved: false },
      ],
    });
    expect(out).toContain('solved in 3/6');
    expect(out).toContain('failed (7/7)');
  });
});
