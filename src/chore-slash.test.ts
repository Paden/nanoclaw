import { describe, it, expect } from 'vitest';
import {
  parseSchedule,
  classifyChore,
  choreLabel,
  xpForChore,
  submitStatus,
  categoryForChore,
  filterStaleRepeating,
  ChoreRow,
  ChicagoNow,
} from './chore-slash.js';
// Bundle/group helper lives next to runAutocomplete in the host-side
// runner. Imported here so we can test it without hitting Sheets.
// @ts-expect-error — JS module, no .d.ts
import { computeBundleOption, buildFactLine } from '../scripts/chore-slash.mjs';

function chore(overrides: Partial<ChoreRow> = {}): ChoreRow {
  return {
    chore_id: 'test',
    name: 'Test Chore',
    duration_min: 5,
    cadence: 'daily',
    schedule: '10:00',
    assigned_to: 'anyone',
    nag_after_min: 60,
    nag_interval_min: 60,
    active: true,
    ...overrides,
  };
}

function nowAt(hour: number, min = 0, dow = 5): ChicagoNow {
  return {
    dateStr: '2026-04-24',
    dow,
    hour,
    minute: min,
    minutesSinceMidnight: hour * 60 + min,
  };
}

describe('parseSchedule', () => {
  it('parses daily HH:MM', () => {
    expect(parseSchedule('daily', '08:30')).toEqual({
      hour: 8,
      min: 30,
      minutes: 510,
    });
  });

  it('parses weekly DAY HH:MM', () => {
    expect(parseSchedule('weekly', 'tue 19:00')).toEqual({
      hour: 19,
      min: 0,
      minutes: 1140,
      dow: 2,
    });
  });

  it('returns null on blank schedule', () => {
    expect(parseSchedule('as-needed', '')).toBeNull();
  });
});

describe('classifyChore', () => {
  it('marks daily chore as overdue once its time has passed', () => {
    const c = chore({ schedule: '08:00' });
    expect(classifyChore(c, nowAt(10), [])).toBe('overdue');
  });

  it('marks daily chore as upcoming_today before its time', () => {
    const c = chore({ schedule: '18:00' });
    expect(classifyChore(c, nowAt(10), [])).toBe('upcoming_today');
  });

  it('marks as done when a non-auto_skipped log row exists today', () => {
    const c = chore({ chore_id: 'eni_feed' });
    const log = [
      {
        timestamp: '2026-04-24 09:00:00',
        chore_id: 'eni_feed',
        done_by: 'Paden',
        status: 'on-time',
      },
    ];
    expect(classifyChore(c, nowAt(10), log)).toBe('done');
  });

  it('treats auto_skipped rows as NOT done (still overdue for today)', () => {
    const c = chore({ chore_id: 'eni_water_800', schedule: '08:00' });
    const log = [
      {
        timestamp: '2026-04-24 12:00:00',
        chore_id: 'eni_water_800',
        done_by: '',
        status: 'auto_skipped',
      },
    ];
    // auto_skipped means the sweeper declared it stale. It shouldn't appear
    // in autocomplete at all (filterStaleRepeating hides it), but if it
    // somehow did, the classification should reflect reality.
    expect(classifyChore(c, nowAt(14), log)).toBe('overdue');
  });

  it('marks weekly chore on the right day as overdue/upcoming', () => {
    const c = chore({ cadence: 'weekly', schedule: 'fri 10:00' });
    expect(classifyChore(c, nowAt(11, 0, 5), [])).toBe('overdue');
    expect(classifyChore(c, nowAt(9, 0, 5), [])).toBe('upcoming_today');
    expect(classifyChore(c, nowAt(9, 0, 3), [])).toBe('this_week');
  });

  it('labels as-needed or missing-schedule chores as todo', () => {
    const c = chore({ cadence: 'as-needed', schedule: '' });
    expect(classifyChore(c, nowAt(10), [])).toBe('todo');
  });
});

describe('choreLabel', () => {
  it('formats an overdue daily chore with time + XP', () => {
    const c = chore({
      name: 'Refill Eni water bowl',
      schedule: '10:30',
      duration_min: 2,
    });
    expect(choreLabel(c, 'overdue', 3)).toBe('Refill Eni water bowl · 10:30am (OVERDUE · +3 XP)');
  });

  it('formats a to-do without time', () => {
    const c = chore({
      name: 'Sell King bed frame',
      cadence: 'one-off',
      schedule: '',
      duration_min: 60,
    });
    expect(choreLabel(c, 'todo', 90)).toBe('Sell King bed frame (to-do · +90 XP)');
  });
});

describe('xpForChore', () => {
  it('multiplies duration by 1.5 on-time, 1.0 late, 0.5 very_late', () => {
    const c = chore({ duration_min: 10 });
    expect(xpForChore(c, 'on-time')).toBe(15);
    expect(xpForChore(c, 'late')).toBe(10);
    expect(xpForChore(c, 'very_late')).toBe(5);
  });
});

describe('submitStatus', () => {
  it('returns on-time inside the nag_after_min window', () => {
    const c = chore({
      schedule: '08:00',
      nag_after_min: 60,
      nag_interval_min: 60,
    });
    expect(submitStatus(c, nowAt(8, 30))).toBe('on-time');
  });

  it('returns late once past nag_after_min', () => {
    const c = chore({
      schedule: '08:00',
      nag_after_min: 60,
      nag_interval_min: 60,
    });
    expect(submitStatus(c, nowAt(10, 0))).toBe('late');
  });

  it('returns very_late after nag_after + 2*nag_interval', () => {
    const c = chore({
      schedule: '08:00',
      nag_after_min: 30,
      nag_interval_min: 30,
    });
    // 8:00 + 30 + 60 = 9:30 — at 10:00 we're past the very_late threshold
    expect(submitStatus(c, nowAt(10, 0))).toBe('very_late');
  });
});

describe('categoryForChore', () => {
  it('maps water / feed / trash / reservoir / gear / clean / default', () => {
    expect(categoryForChore(chore({ name: 'Refill Eni water bowl' }))).toBe('water');
    expect(categoryForChore(chore({ name: 'Feed Eni (breakfast)' }))).toBe('feed');
    expect(categoryForChore(chore({ name: 'Clean baby bottles' }))).toBe('feed');
    expect(categoryForChore(chore({ name: 'Take trash to curb' }))).toBe('trash');
    expect(categoryForChore(chore({ name: 'Fill Formula Maker reservoir' }))).toBe('reservoir');
    expect(categoryForChore(chore({ name: 'Change Formula Maker gear' }))).toBe('gear');
    expect(categoryForChore(chore({ name: 'Vacuum living area' }))).toBe('clean');
    expect(categoryForChore(chore({ name: 'Sell King bed frame' }))).toBe('default');
  });
});

describe('filterStaleRepeating', () => {
  const water = (id: string, hh: string): ChoreRow =>
    chore({
      chore_id: id,
      name: 'Refill Eni water bowl',
      schedule: hh,
      duration_min: 2,
    });

  it('passes singletons through unchanged', () => {
    const chores = [chore({ chore_id: 'dishes', name: 'Dishes', schedule: '21:00' })];
    const result = filterStaleRepeating(chores, nowAt(22));
    expect(result.map((c) => c.chore_id)).toEqual(['dishes']);
  });

  it('shows only the latest overdue slot when multiple have passed', () => {
    const series = [
      water('eni_water_800', '08:00'),
      water('eni_water_1030', '10:30'),
      water('eni_water_1530', '15:30'),
      water('eni_water_2000', '20:00'),
    ];
    // 4:00pm: 8:00, 10:30, 15:30 are passed; 20:00 is future.
    // Expect: the latest passed (15:30) + the single future (20:00).
    const out = filterStaleRepeating(series, nowAt(16));
    expect(out.map((c) => c.chore_id).sort()).toEqual(['eni_water_1530', 'eni_water_2000']);
  });

  it('shows only the next upcoming slot when nothing has passed yet', () => {
    const series = [water('eni_water_800', '08:00'), water('eni_water_1030', '10:30')];
    const out = filterStaleRepeating(series, nowAt(6));
    // Both are future; keep all future (caller's current policy).
    expect(out.map((c) => c.chore_id)).toEqual(['eni_water_800', 'eni_water_1030']);
  });
});

describe('computeBundleOption', () => {
  const morningChore = (overrides: Partial<ChoreRow> = {}): ChoreRow =>
    chore({
      chore_id: 'eni_feed_morning',
      name: 'Feed Eni (breakfast)',
      schedule: '08:00',
      duration_min: 5,
      ...overrides,
    });
  const dishesChore = (overrides: Partial<ChoreRow> = {}): ChoreRow =>
    chore({
      chore_id: 'kitchen_dishes',
      name: 'Wash dishes',
      schedule: '09:00',
      duration_min: 4,
      ...overrides,
    });

  it('returns full bundle XP and "bundle" label when no member is done', () => {
    const a = morningChore();
    const b = dishesChore();
    const group = {
      group_id: 'morning_routine',
      label: 'Morning routine',
      chore_ids: [a.chore_id, b.chore_id],
    };
    // 8:30am: a (08:00) is overdue but inside nag_after window → on-time.
    // b (09:00) is upcoming_today → on-time. Both surface as actionable.
    // xp = round(5*1.5) + round(4*1.5) = 8 + 6 = 14.
    const out = computeBundleOption(group, [a, b], nowAt(8, 30), []);
    expect(out).not.toBeNull();
    expect(out.value).toBe('group:morning_routine');
    expect(out.label).toBe('Morning routine · bundle (+14 XP)');
    expect(out.xp).toBe(14);
    expect(out.rank).toBe(-1);
  });

  it('returns reduced XP and "1 of 2 left" label when one member already logged today', () => {
    const a = morningChore();
    const b = dishesChore();
    const group = {
      group_id: 'morning_routine',
      label: 'Morning routine',
      chore_ids: [a.chore_id, b.chore_id],
    };
    const todayLog = [
      {
        timestamp: '2026-04-24 08:30:00',
        chore_id: a.chore_id,
        done_by: 'Paden',
        status: 'on-time',
      },
    ];
    // Only `b` (dishes, 4min on-time = 6 XP) remains.
    const out = computeBundleOption(group, [a, b], nowAt(10), todayLog);
    expect(out).not.toBeNull();
    expect(out.value).toBe('group:morning_routine');
    expect(out.label).toBe('Morning routine (1 of 2 left, +6 XP)');
    expect(out.xp).toBe(6);
  });

  it('returns null when every member is already done today', () => {
    const a = morningChore();
    const b = dishesChore();
    const group = {
      group_id: 'morning_routine',
      label: 'Morning routine',
      chore_ids: [a.chore_id, b.chore_id],
    };
    const todayLog = [
      {
        timestamp: '2026-04-24 08:30:00',
        chore_id: a.chore_id,
        done_by: 'Paden',
        status: 'on-time',
      },
      {
        timestamp: '2026-04-24 09:30:00',
        chore_id: b.chore_id,
        done_by: 'Paden',
        status: 'on-time',
      },
    ];
    const out = computeBundleOption(group, [a, b], nowAt(10), todayLog);
    expect(out).toBeNull();
  });
});

describe('buildFactLine', () => {
  it('returns "nothing new" when no chores were newly logged', () => {
    const fact = buildFactLine('Paden', [{ chore_id: 'a', name: 'A', skipped: 'already_done' }]);
    expect(fact).toBe('Nothing new to log — already done today.');
  });

  it('returns single-chore form when only one chore was logged', () => {
    const fact = buildFactLine('Paden', [{ chore_id: 'a', name: 'Feed Eni', xp: 5, status: 'on-time' }]);
    expect(fact).toBe('Paden did: Feed Eni');
  });

  it('joins multiple newly-done chores with " & "', () => {
    const fact = buildFactLine('Paden', [
      { chore_id: 'a', name: 'A', xp: 5, status: 'on-time' },
      { chore_id: 'b', name: 'B', xp: 3, status: 'on-time' },
    ]);
    expect(fact).toBe('Paden did: A & B');
  });

  it('signals partial completion when some bundle members were already done', () => {
    const fact = buildFactLine('Paden', [
      { chore_id: 'a', name: 'A', skipped: 'already_done' },
      { chore_id: 'b', name: 'B', xp: 3, status: 'on-time' },
    ]);
    expect(fact).toBe('Paden did 1 of 2: B');
  });
});
