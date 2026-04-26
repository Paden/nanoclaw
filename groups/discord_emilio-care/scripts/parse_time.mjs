// groups/discord_emilio-care/scripts/parse_time.mjs
// Pure time parser for Emilio-care slash commands. Returns Chicago wall-clock
// "YYYY-MM-DD HH:MM:SS" plus a 12h display string. The slash dispatcher
// converts this to whatever Sheets expects.

const TZ = 'America/Chicago';

function chicagoParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(
    parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  if (p.hour === '24') p.hour = '00';
  return p;
}

function fmtIso(date) {
  const p = chicagoParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function fmtDisplay(date) {
  const p = chicagoParts(date);
  const h = parseInt(p.hour, 10);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${p.minute} ${ampm}`;
}

function fail(input, reason) {
  throw new Error(`parse_time: ${reason} (input: "${input}")`);
}

// Compute Chicago's UTC offset in minutes for the given instant. CDT=-300, CST=-360.
function getChicagoOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const chi = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  return Math.round((chi.getTime() - utc.getTime()) / 60_000);
}

export function parseTime(input, now = new Date()) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw === 'now' || raw === 'n') {
    return { iso: fmtIso(now), displayLocal: fmtDisplay(now) };
  }

  // Suffix forms: "5m", "5min", "5 min ago", "1.5h", "2 hours ago"
  const suffixMatch = raw.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b(?:\s+ago)?$/,
  );
  if (suffixMatch) {
    const n = parseFloat(suffixMatch[1]);
    const unit = suffixMatch[2];
    const ms = unit.startsWith('h') ? n * 3600_000 : n * 60_000;
    const past = new Date(now.getTime() - ms);
    return { iso: fmtIso(past), displayLocal: fmtDisplay(past) };
  }

  // Bare integer → minutes ago, capped at 120 to avoid "8" → "8pm" confusion
  const bareInt = raw.match(/^(\d+)$/);
  if (bareInt) {
    const n = parseInt(bareInt[1], 10);
    if (n > 120) fail(input, 'ambiguous — use 5m or 2h or 14:30');
    const past = new Date(now.getTime() - n * 60_000);
    return { iso: fmtIso(past), displayLocal: fmtDisplay(past) };
  }

  // Absolute clock: "2:30pm", "14:30", "8pm"
  const abs = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (abs) {
    let h = parseInt(abs[1], 10);
    const m = abs[2] ? parseInt(abs[2], 10) : 0;
    const ampm = abs[3];
    if (m < 0 || m > 59) fail(input, 'minute out of range');
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (!ampm && h > 23) fail(input, 'hour out of range');
    if (ampm && (h < 1 || h > 23)) fail(input, 'hour out of range');

    // Build today (in Chicago) at H:M.
    const todayParts = chicagoParts(now);
    const offsetMin = getChicagoOffsetMinutes(now); // e.g. -300 for CDT
    const offsetSign = offsetMin <= 0 ? '-' : '+';
    const absOff = Math.abs(offsetMin);
    const offsetHr = String(Math.floor(absOff / 60)).padStart(2, '0');
    const offsetMm = String(absOff % 60).padStart(2, '0');
    const iso =
      `${todayParts.year}-${todayParts.month}-${todayParts.day}` +
      `T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00` +
      `${offsetSign}${offsetHr}:${offsetMm}`;
    let result = new Date(iso);

    // If parsed time is >1h in the future, treat as yesterday.
    if (result.getTime() - now.getTime() > 3600_000) {
      result = new Date(result.getTime() - 86400_000);
    }
    return { iso: fmtIso(result), displayLocal: fmtDisplay(result) };
  }

  fail(input, 'unrecognized format');
}
