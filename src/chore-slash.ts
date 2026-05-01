// Pure helpers for the /chore slash command. Extracted so they can be tested
// without going through the sheets round-trip. The host-side runner
// (scripts/chore-slash.mjs) wires these up to live Chores + Chore Groups
// data.

export interface ChoreRow {
  chore_id: string;
  name: string;
  duration_min: number;
  cadence: 'daily' | 'weekly' | 'monthly' | 'one-off' | 'as-needed' | string;
  schedule: string; // "HH:MM" for daily, "mon HH:MM" for weekly, etc.
  assigned_to: string; // "anyone" | "Paden" | "Brenda" | "Danny"
  nag_after_min: number;
  nag_interval_min: number;
  active: boolean;
}

export interface ChoreGroup {
  group_id: string;
  label: string;
  chore_ids: string[];
  notes?: string;
}

export interface ChoreLogRow {
  timestamp: string; // "YYYY-MM-DD HH:MM:SS"
  chore_id: string;
  done_by: string;
  status: string; // "on-time" | "late" | "very_late" | "assisted" | "auto_skipped"
}

export interface ChicagoNow {
  dateStr: string; // YYYY-MM-DD
  dow: number; // 0=Sun..6=Sat
  hour: number;
  minute: number;
  minutesSinceMidnight: number; // hour*60+minute
}

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

// Parse "HH:MM" or "mon HH:MM" — returns minutesSinceMidnight + optional dow.
export function parseSchedule(
  cadence: string,
  schedule: string,
): { hour: number; min: number; minutes: number; dow?: number } | null {
  if (!schedule) return null;
  if (cadence === 'daily') {
    const m = schedule.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    return { hour, min, minutes: hour * 60 + min };
  }
  if (cadence === 'weekly') {
    const m = schedule.match(/^(\w+)\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dow = DAY_NAMES[m[1].toLowerCase()];
    if (dow === undefined) return null;
    const hour = parseInt(m[2], 10);
    const min = parseInt(m[3], 10);
    return { hour, min, minutes: hour * 60 + min, dow };
  }
  return null;
}

export type ChoreBucket = 'overdue' | 'upcoming_today' | 'this_week' | 'todo' | 'done';

// Classify a chore for autocomplete ordering + labels. "overdue" = scheduled
// time today has already passed and no Chore Log entry yet. "upcoming_today"
// = scheduled today but not yet due. "this_week" = weekly scheduled this week
// (not today). "todo" = one-off / as-needed. "done" = already logged today.
export function classifyChore(chore: ChoreRow, now: ChicagoNow, todayLog: ChoreLogRow[]): ChoreBucket {
  const loggedToday = todayLog.some((l) => l.chore_id === chore.chore_id && l.status !== 'auto_skipped');
  if (loggedToday) return 'done';

  const parsed = parseSchedule(chore.cadence, chore.schedule);
  if (!parsed) {
    // No schedule: one-off / as-needed → "todo"
    return 'todo';
  }
  if (chore.cadence === 'daily') {
    if (parsed.minutes <= now.minutesSinceMidnight) return 'overdue';
    return 'upcoming_today';
  }
  if (chore.cadence === 'weekly') {
    if (parsed.dow === now.dow) {
      if (parsed.minutes <= now.minutesSinceMidnight) return 'overdue';
      return 'upcoming_today';
    }
    return 'this_week';
  }
  return 'todo';
}

// Format HH:MM from minutes, lowercased AM/PM.
export function fmt12mins(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60);
  const m = minutesSinceMidnight % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// "Refill Eni water bowl · 10:30am (OVERDUE · +3 XP)"
export function choreLabel(chore: ChoreRow, bucket: ChoreBucket, xp: number): string {
  const parsed = parseSchedule(chore.cadence, chore.schedule);
  const time = parsed ? ` · ${fmt12mins(parsed.minutes)}` : '';
  let statusTag = '';
  switch (bucket) {
    case 'overdue':
      statusTag = ' (OVERDUE';
      break;
    case 'upcoming_today':
      statusTag = ' (later today';
      break;
    case 'this_week':
      statusTag = ' (this week';
      break;
    case 'todo':
      statusTag = ' (to-do';
      break;
    case 'done':
      statusTag = ' (done today';
      break;
  }
  const xpTag = xp > 0 ? ` · +${xp} XP)` : ')';
  return `${chore.name}${time}${statusTag}${xpTag}`;
}

// XP per the silverthorne spec: duration_min × 1.5 on-time, × 1.0 late,
// × 0.5 very_late (3+ nags). For /chore submit, we default to on-time unless
// nag state says otherwise.
export function xpForChore(chore: ChoreRow, status: 'on-time' | 'late' | 'very_late'): number {
  const mult = status === 'very_late' ? 0.5 : status === 'late' ? 1.0 : 1.5;
  return Math.round((chore.duration_min || 0) * mult);
}

// Determine submit status from now vs. schedule + nag state. MVP: if current
// time is before schedule+nag_after_min (or no schedule), it's 'on-time'. If
// past 2 nag intervals, 'very_late'. Otherwise 'late'.
export function submitStatus(chore: ChoreRow, now: ChicagoNow): 'on-time' | 'late' | 'very_late' {
  const parsed = parseSchedule(chore.cadence, chore.schedule);
  if (!parsed) return 'on-time';
  const sinceDue = now.minutesSinceMidnight - parsed.minutes;
  if (sinceDue <= (chore.nag_after_min || 0)) return 'on-time';
  const nagMinutes = chore.nag_interval_min || chore.nag_after_min || 0;
  if (nagMinutes > 0 && sinceDue >= chore.nag_after_min + nagMinutes * 2) {
    return 'very_late';
  }
  return 'late';
}

// Rank buckets for autocomplete sort (smaller rank = more actionable).
export const BUCKET_RANK: Record<ChoreBucket, number> = {
  overdue: 0,
  upcoming_today: 1,
  this_week: 2,
  todo: 3,
  done: 4,
};

export interface RankedOption {
  value: string; // chore_id or "group:<group_id>"
  label: string;
  bucket: ChoreBucket | 'group';
  rank: number;
}

// Category detection for pet-voice lookup. Rough keyword match on the chore's
// name. Keys here must match top-level keys in chore_pet_lines.json.
export function categoryForChore(chore: ChoreRow): string {
  const name = (chore.name || '').toLowerCase();
  if (/water/.test(name)) return 'water';
  if (/feed|breakfast|dinner|lunch|meal|bottles?\b/.test(name)) return 'feed';
  if (/bottle/.test(name)) return 'feed';
  if (/trash|bins?\b/.test(name)) return 'trash';
  if (/reservoir/.test(name)) return 'reservoir';
  if (/\bgear\b/.test(name)) return 'gear';
  if (/clean|wash|wipe|vacuum|bathroom|dishes|counter|roomba/.test(name)) return 'clean';
  return 'default';
}

// Collapse repeating-series chores to show only the CURRENT interval in
// autocomplete. We group by exact `name` string (e.g. all "Refill Eni water
// bowl" rows with different schedule times). Within a group: show only the
// most recent passed time + any future time today. Historical "stale"
// overdue ones drop out. This is the autocomplete-side hygiene; the sweeper
// cron writes auto_skipped rows so the sheet also reflects reality.
export function filterStaleRepeating(chores: ChoreRow[], now: ChicagoNow): ChoreRow[] {
  const byName = new Map<string, ChoreRow[]>();
  for (const c of chores) {
    const k = c.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(c);
  }
  const out: ChoreRow[] = [];
  for (const [, group] of byName) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // Multiple same-name chores = repeating series (e.g. eni_water at
    // 08:00 / 12:00 / 18:00 / 20:00). Keep: the most recent passed time +
    // anything future today.
    const passed: ChoreRow[] = [];
    const future: ChoreRow[] = [];
    for (const c of group) {
      const p = parseSchedule(c.cadence, c.schedule);
      if (!p) continue;
      if (p.minutes <= now.minutesSinceMidnight) passed.push(c);
      else future.push(c);
    }
    if (passed.length > 0) {
      // keep only the latest passed (highest minutes)
      passed.sort((a, b) => {
        const pa = parseSchedule(a.cadence, a.schedule)!.minutes;
        const pb = parseSchedule(b.cadence, b.schedule)!.minutes;
        return pb - pa;
      });
      out.push(passed[0]);
    }
    out.push(...future);
  }
  return out;
}
