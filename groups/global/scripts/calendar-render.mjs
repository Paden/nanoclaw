// Shared calendar card renderer — single source of truth for both the
// /calendar slash command (scripts/calendar-slash.mjs) and the pinned
// `calendar_card` refresh cron in #panda.
//
// Exports renderCalendarCard({ token, today, timezone }) which returns the
// formatted card string. Caller is responsible for minting the OAuth token
// (the slash wrapper and the cron mint it differently — the wrapper uses
// host-local paths, the cron reads the in-container mount).

const DEFAULT_CALENDARS = [
  'padenportillo@gmail.com',
  'paden.portillo@brinqa.com',
  'ei9k066stgqobfdcavgcjemi0sj6m5tb@import.calendar.google.com',
];
const DEFAULT_TZ = 'America/Chicago';

function todayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function extractLocalTime(dateTimeIso, tz) {
  const dt = new Date(dateTimeIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt);
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${hour}:${p.minute}`;
}

function weekdayMonthDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

async function getCalendarNames(token) {
  // One call to the user's calendarList so card headers reflect the user's
  // chosen summary (e.g. "Brinqa Work") instead of a raw email/id.
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return {};
  const data = await r.json();
  const map = {};
  for (const c of data.items || []) {
    map[c.id] = c.summaryOverride || c.summary || c.id;
  }
  return map;
}

async function listEventsForDay(token, today, tz, calendars) {
  // Chicago wall-time bounds; we pass them with a naive offset that Google
  // accepts — singleEvents expansion collapses recurring instances, and
  // timeZone= normalizes returned times to the target TZ.
  const tzOffset = '-05:00'; // America/Chicago standard-time offset; good-enough for card rendering
  const timeMin = `${today}T00:00:00${tzOffset}`;
  const timeMax = `${today}T23:59:59${tzOffset}`;

  const byCalendar = new Map(calendars.map((c) => [c, []]));
  for (const cal of calendars) {
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events` +
      `?timeMin=${encodeURIComponent(timeMin)}` +
      `&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&timeZone=${encodeURIComponent(tz)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const data = await r.json();
    for (const ev of data.items || []) {
      if (ev.status === 'cancelled') continue;
      const location = (ev.location || '').replace(/\s+/g, ' ').trim();
      byCalendar.get(cal).push({
        summary: (ev.summary || '').trim() || 'Busy',
        allDay: !!ev.start?.date,
        start: ev.start?.dateTime || ev.start?.date || '',
        end: ev.end?.dateTime || ev.end?.date || '',
        location,
      });
    }
  }
  return byCalendar;
}

function renderCalendarSection(events, tz) {
  const lines = [];
  const allDay = events.filter((e) => e.allDay);
  const timed = events
    .filter((e) => !e.allDay)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  for (const ev of allDay) lines.push(`All day — ${ev.summary}`);
  for (const ev of timed) {
    const startHHMM = extractLocalTime(ev.start, tz);
    const endHHMM = ev.end ? extractLocalTime(ev.end, tz) : '';
    const timeRange = endHHMM
      ? `${fmt12(startHHMM)}–${fmt12(endHHMM)}`
      : fmt12(startHHMM);
    const loc = ev.location ? ` 📍 ${ev.location}` : '';
    lines.push(`${timeRange} — ${ev.summary}${loc}`);
  }
  return lines;
}

function renderCard(today, byCalendar, calendarNames, tz, calendars) {
  const lines = [`📅 ${weekdayMonthDay(today)}`, ''];
  const sectionsWithEvents = calendars.filter(
    (c) => (byCalendar.get(c) || []).length > 0,
  );

  if (sectionsWithEvents.length === 0) {
    lines.push('No events today 🎉');
  } else {
    for (const cal of sectionsWithEvents) {
      const label = calendarNames[cal] || cal;
      lines.push(`**${label}**`);
      lines.push(...renderCalendarSection(byCalendar.get(cal), tz));
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
  }

  lines.push('');
  lines.push('─────────────────');
  const nowHHMM = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  lines.push(`Updated ${fmt12(nowHHMM)}`);
  return lines.join('\n');
}

export async function renderCalendarCard({
  token,
  today,
  timezone = DEFAULT_TZ,
  calendars = DEFAULT_CALENDARS,
} = {}) {
  if (!token) throw new Error('renderCalendarCard: token is required');
  const day = today || todayInTz(timezone);
  const [byCalendar, names] = await Promise.all([
    listEventsForDay(token, day, timezone, calendars),
    getCalendarNames(token),
  ]);
  return renderCard(day, byCalendar, names, timezone, calendars);
}
