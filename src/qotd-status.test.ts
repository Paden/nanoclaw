import { describe, it, expect } from 'vitest';
import { formatDateLabel, formatQotdStatusReply } from './qotd-status.js';

describe('formatDateLabel', () => {
  it('renders weekday + month + day from an ISO date', () => {
    expect(formatDateLabel('2026-04-14')).toBe('Tue, Apr 14');
  });

  it('falls back to the input on a malformed date', () => {
    expect(formatDateLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('formatQotdStatusReply', () => {
  it('returns a message for non-status results', () => {
    expect(
      formatQotdStatusReply({
        status: 'error',
        message: 'oops',
      }),
    ).toBe('oops');
  });

  it('celebrates an empty open list', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      open: [],
      currentQNum: 15,
      today: '2026-04-22',
    });
    expect(reply).toContain('All caught up');
  });

  it('shows day number, date, and question for a single open Q', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open: [
        {
          qNum: 7,
          day: 7,
          date: '2026-04-14',
          question: 'Do you have a secret hunch about how you will die?',
        },
      ],
    });
    expect(reply).toContain('1 panda question waiting');
    expect(reply).toContain('Day 7');
    expect(reply).toContain('Apr 14');
    expect(reply).toContain('Q7');
    expect(reply).toContain('secret hunch');
    expect(reply).toContain('`/qotd <answer>`');
  });

  it('marks today with (today) when the open Q matches', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open: [
        {
          qNum: 15,
          day: 15,
          date: '2026-04-22',
          question: 'What is the greatest accomplishment of your life?',
        },
      ],
    });
    expect(reply).toContain('(today)');
  });

  it('truncates the list at MAX_ITEMS and surfaces a remainder count', () => {
    const open = Array.from({ length: 15 }, (_, i) => ({
      qNum: i + 1,
      day: i + 1,
      date: `2026-04-${String(i + 8).padStart(2, '0')}`,
      question: `question ${i + 1}`,
    }));
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open,
    });
    expect(reply).toContain('15 panda questions waiting');
    expect(reply).toContain('…plus 3 more.');
    // First shown entry present, later ones trimmed
    expect(reply).toContain('Day 1');
    expect(reply).not.toContain('Day 15'); // day 13-15 should be cut
  });

  it('renders skipped days in a separate section when there are also open Qs', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open: [
        {
          qNum: 15,
          day: 15,
          date: '2026-04-22',
          question: 'What is the greatest accomplishment of your life?',
        },
      ],
      skippedOpen: [
        {
          qNum: 11,
          day: 11,
          date: '2026-04-18',
          question:
            'Take four minutes and tell your partner your life story...',
        },
      ],
    });
    expect(reply).toContain('1 panda question waiting');
    expect(reply).toContain('Skipped days');
    expect(reply).toContain('Day 11');
    expect(reply).toContain('Day 15');
    // Skipped section comes after the current section
    expect(reply.indexOf('Day 15')).toBeLessThan(reply.indexOf('Day 11'));
  });

  it('says "caught up on current" when only skipped days remain', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open: [],
      skippedOpen: [
        {
          qNum: 11,
          day: 11,
          date: '2026-04-18',
          question: 'Take four minutes...',
        },
      ],
    });
    expect(reply).toContain('All caught up on current');
    expect(reply).toContain('Skipped days');
    expect(reply).toContain('Day 11');
  });

  it('celebrates fully when both open and skipped are empty', () => {
    const reply = formatQotdStatusReply({
      status: 'status',
      currentQNum: 15,
      today: '2026-04-22',
      open: [],
      skippedOpen: [],
    });
    expect(reply).toContain('All caught up — no panda questions');
  });
});
