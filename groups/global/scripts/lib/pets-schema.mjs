// Shared schema constants for the Silverthorne Pets tab + a Chicago-local
// timestamp helper. Hoisted from compute-tiers.mjs / resolve-day.mjs /
// migrate-wordle-hp.mjs so changes to the sheet schema only need to land
// in one place.
//
// Column layout (Silverthorne Pets tab, sheet 1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4):
//   A=owner B=name C=species D=avatar E=stage_index F=stage_name
//   G=flavor_modifier H=health I=happiness J=xp K=streak_days
//   L=last_completion_date M=status N=legacy_xp O=last_updated P=max_health

export const PETS_COL = Object.freeze({
  owner: 0,
  name: 1,
  species: 2,
  avatar: 3,
  stage_index: 4,
  stage_name: 5,
  flavor_modifier: 6,
  health: 7,
  happiness: 8,
  xp: 9,
  streak_days: 10,
  last_completion_date: 11,
  status: 12,
  legacy_xp: 13,
  last_updated: 14,
  max_health: 15,
});

export const PETS_HEADERS = Object.freeze([
  'owner', 'name', 'species', 'avatar', 'stage_index', 'stage_name',
  'flavor_modifier', 'health', 'happiness', 'xp', 'streak_days',
  'last_completion_date', 'status', 'legacy_xp', 'last_updated', 'max_health',
]);

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS` in America/Chicago. Defaults to now.
 * Used by Pet Log appends and any other writes that follow the Chicago-local
 * timestamp convention. Pass an explicit Date for deterministic tests.
 */
export function nowTsChicago(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}:${g.second}`;
}
