import { describe, it, expect } from 'vitest';
import { buildWordleCardText } from './wordle_card.mjs';

describe('buildWordleCardText', () => {
  const baseSummary = {
    Paden: { guesses: 0, solved: false, done: false },
    Brenda: { guesses: 0, solved: false, done: false },
    Danny: { guesses: 0, solved: false, done: false },
  };

  const baseLeaderboard = {
    Paden: { wins: 5, streak: 1, avg_guesses: 3.94 },
    Brenda: { wins: 4, streak: 1, avg_guesses: 3.51 },
    Danny: { wins: 5, streak: 7, avg_guesses: 3.5 },
  };

  it('includes the SAGA WORDLE header and day number', () => {
    const out = buildWordleCardText({
      summary: baseSummary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toContain('🎯 SAGA WORDLE — Day 21');
    expect(out).toContain('pirate space opera');
  });

  it('shows "not started" when guesses=0', () => {
    const out = buildWordleCardText({
      summary: baseSummary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toMatch(/Paden.*🌋.*Voss.*not started/);
    expect(out).toMatch(/Brenda.*🌙.*Nyx.*not started/);
    expect(out).toMatch(/Danny.*❄️.*Zima.*not started/);
  });

  it('shows guess count for in-progress players', () => {
    const summary = {
      Paden: { guesses: 3, solved: false, done: false },
      Brenda: { guesses: 1, solved: false, done: false },
      Danny: { guesses: 0, solved: false, done: false },
    };
    const out = buildWordleCardText({
      summary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toMatch(/Paden.*3 guesses/);
    expect(out).toMatch(/Brenda.*1 guess/); // singular form
    expect(out).toMatch(/Danny.*not started/);
  });

  it('shows ✅ done with guess count when solved', () => {
    const summary = {
      Paden: { guesses: 3, solved: true, done: true },
      Brenda: { guesses: 0, solved: false, done: false },
      Danny: { guesses: 0, solved: false, done: false },
    };
    const out = buildWordleCardText({
      summary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toMatch(/Paden.*3\/6 ✅/);
  });

  it('shows ❌ when 6 guesses unsolved', () => {
    const summary = {
      Paden: { guesses: 6, solved: false, done: true },
      Brenda: { guesses: 0, solved: false, done: false },
      Danny: { guesses: 0, solved: false, done: false },
    };
    const out = buildWordleCardText({
      summary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toMatch(/Paden.*6\/6 ❌/);
  });

  it('includes leaderboard section with all-time stats', () => {
    const out = buildWordleCardText({
      summary: baseSummary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: baseLeaderboard,
      dateStr: '2026-04-25',
    });
    expect(out).toContain('🏆 All-time');
    expect(out).toContain('─');
    // Each player line in leaderboard
    expect(out).toMatch(/Paden.*5 wins/);
    expect(out).toMatch(/Danny.*5 wins.*streak 7/);
  });

  it('handles missing leaderboard gracefully', () => {
    const out = buildWordleCardText({
      summary: baseSummary,
      day: 21,
      genre: 'pirate space opera',
      leaderboard: null,
      dateStr: '2026-04-25',
    });
    // Should still produce a valid card without crashing
    expect(out).toContain('🎯 SAGA WORDLE — Day 21');
    expect(out.length).toBeGreaterThan(50);
  });
});
