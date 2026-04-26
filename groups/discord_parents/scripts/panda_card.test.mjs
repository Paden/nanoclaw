import { describe, it, expect } from 'vitest';
import { buildPandaPartialCard } from './panda_card.mjs';

describe('buildPandaPartialCard', () => {
  const base = {
    qNum: 15,
    question: 'What is the greatest accomplishment of your life?',
    day: 15,
    phase: '36_questions',
    loveMapCount: 14,
    lastRevealAt: '2026-04-21T13:58:24Z',
  };

  it('shows ⏳ waiting for both when neither answered', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: false,
      brendaAnswered: false,
    });
    expect(out).toMatch(/Paden\s+💭 ⏳ waiting/);
    expect(out).toMatch(/Brenda\s+💭 ⏳ waiting/);
  });

  it('shows ✅ for Paden when only Paden answered', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: true,
      brendaAnswered: false,
    });
    expect(out).toMatch(/Paden\s+💭 ✅ answered/);
    expect(out).toMatch(/Brenda\s+💭 ⏳ waiting/);
  });

  it('shows ✅ for Brenda when only Brenda answered', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: false,
      brendaAnswered: true,
    });
    expect(out).toMatch(/Paden\s+💭 ⏳ waiting/);
    expect(out).toMatch(/Brenda\s+💭 ✅ answered/);
  });

  it('renders the day, phase, and question text in the header', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: true,
      brendaAnswered: false,
    });
    expect(out).toContain('💌 PANDA — Day 15 · 36 Questions');
    expect(out).toContain("Today's question:");
    expect(out).toContain('"What is the greatest accomplishment of your life?"');
  });

  it('humanizes 36_questions and daily_pulse phase strings', () => {
    const a = buildPandaPartialCard({ ...base, phase: '36_questions', padenAnswered: false, brendaAnswered: false });
    expect(a).toContain('36 Questions');
    const b = buildPandaPartialCard({ ...base, phase: 'daily_pulse', padenAnswered: false, brendaAnswered: false });
    expect(b).toContain('Daily Pulse');
  });

  it('renders the Love Map count footer', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: true,
      brendaAnswered: false,
      loveMapCount: 23,
    });
    expect(out).toContain('🗺️ Love Map: 23 entries');
  });

  it('renders Last reveal as a YYYY-MM-DD date', () => {
    const out = buildPandaPartialCard({
      ...base,
      padenAnswered: true,
      brendaAnswered: false,
    });
    expect(out).toMatch(/Last reveal: 2026-04-21/);
  });

  it('handles missing lastRevealAt with em-dash', () => {
    const out = buildPandaPartialCard({
      ...base,
      lastRevealAt: null,
      padenAnswered: false,
      brendaAnswered: false,
    });
    expect(out).toContain('Last reveal: —');
  });

  it('does not include the qNum on the card itself', () => {
    // The spec card format never shows the question number — only the day.
    const out = buildPandaPartialCard({
      ...base,
      qNum: 99,
      padenAnswered: false,
      brendaAnswered: false,
    });
    expect(out).not.toMatch(/Q15/);
    expect(out).not.toMatch(/Q99/);
  });
});
