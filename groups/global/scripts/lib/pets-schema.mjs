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
 * Pet evolution stages — index, display name, and the cumulative XP
 * threshold required to reach that stage. Sourced from the Silverthorne
 * award_xp.mjs script; hoisted here so other scripts (resolve-day,
 * status cards, etc.) can resolve "what stage / how far to next" without
 * duplicating the table.
 */
export const STAGES = Object.freeze([
  { index: 0, name: 'Egg',           xpThreshold: 0 },
  { index: 1, name: 'Hatchling',     xpThreshold: 50 },
  { index: 2, name: 'Critter',       xpThreshold: 150 },
  { index: 3, name: 'Beast',         xpThreshold: 350 },
  { index: 4, name: 'Spirit',        xpThreshold: 750 },
  { index: 5, name: 'Elemental',     xpThreshold: 1500 },
  { index: 6, name: 'Chimera',       xpThreshold: 3000 },
  { index: 7, name: 'Wyrm',          xpThreshold: 5500 },
  { index: 8, name: 'Celestial',     xpThreshold: 9500 },
  { index: 9, name: 'Eldritch',      xpThreshold: 16000 },
  { index: 10, name: 'Cosmic Horror', xpThreshold: 28000 },
  { index: 11, name: 'Deity',        xpThreshold: 50000 },
  { index: 12, name: 'Pantheon',     xpThreshold: 85000 },
  { index: 13, name: 'Concept',      xpThreshold: 145000 },
  { index: 14, name: 'Source',       xpThreshold: 245000 },
]);

/**
 * Resolve a stage descriptor for a given XP total. Returns { current, next }
 * where `next` is null at the cap. Mirrors the lookup in award_xp.mjs so
 * stage transitions stay consistent across scripts.
 */
export function stageForXp(xp) {
  let current = STAGES[0];
  for (const stage of STAGES) {
    if (xp >= stage.xpThreshold) current = stage;
  }
  const next = STAGES.find((s) => s.index === current.index + 1) ?? null;
  return { current, next };
}

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
