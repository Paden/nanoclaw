// groups/discord_emilio-care/scripts/emilio_chime.mjs
// Pure: parse emilio_voice.md into pools, pick a non-repeating line per event.
// State is opaque to callers; persist + pass back unchanged.

const HEADING_TO_KEY = {
  'feed': 'feed',
  'feeding': 'feed',
  'feedings': 'feed',
  'diaper': 'diaper',
  'nap start': 'nap_start',
  'nap-start': 'nap_start',
  'sleep': 'nap_start',
  'wake': 'wake',
  'wake up': 'wake',
  'wake-up': 'wake',
  'general': 'general',
  'general / chime-ins': 'general',
  'chime-ins': 'general',
};

export function parsePools(markdown) {
  const pools = {};
  const lines = String(markdown ?? '').split('\n');
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      // Strip trailing parenthetical descriptors (e.g. "General / chime-ins (when no specific event)")
      const normalized = heading[1].toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
      const key = HEADING_TO_KEY[normalized] ?? null;
      current = key;
      if (current && !pools[current]) pools[current] = [];
      continue;
    }
    if (!current) continue;
    const item = line.match(/^-\s+`([^`]+)`/);
    if (item) pools[current].push(item[1]);
  }
  return pools;
}

const EVENT_TO_POOL = {
  feed: 'feed',
  feeding: 'feed',
  feeding_update: 'feed', // no dedicated pool — reuse feed
  diaper: 'diaper',
  nap_start: 'nap_start',
  asleep: 'nap_start',
  wake: 'wake',
  awake: 'wake',
};

// Parent-specific phrases — used to filter chimes so the wrong parent
// isn't addressed (e.g. "yummy mama" when Dad logs the feeding).
// `\b` doesn't handle non-ASCII reliably (papá), so we use lookarounds
// that allow either an ASCII word boundary OR a non-letter character.
const MOM_WORDS = /(?:^|[^\p{L}])(mama|mamá|mommy|ma-ma-ma)(?:[^\p{L}]|$)/iu;
const DAD_WORDS = /(?:^|[^\p{L}])(dada|daddy|papá|papa|da-da-da)(?:[^\p{L}]|$)/iu;

function isAllowedFor(line, parentRole) {
  // parentRole: 'dad' | 'mom' | null (null = no parent address)
  if (parentRole === 'dad' && MOM_WORDS.test(line)) return false;
  if (parentRole === 'mom' && DAD_WORDS.test(line)) return false;
  if (parentRole === null && (MOM_WORDS.test(line) || DAD_WORDS.test(line))) return false;
  return true;
}

export function pickChime(eventType, pools, state = { last: {} }, opts = {}) {
  const poolKey = EVENT_TO_POOL[eventType] ?? 'general';
  const parentRole = opts.parentRole === undefined ? undefined : opts.parentRole;
  const filterByParent = parentRole !== undefined;

  const primaryRaw = pools[poolKey] ?? [];
  const generalRaw = pools.general ?? [];
  const primary = filterByParent
    ? primaryRaw.filter((l) => isAllowedFor(l, parentRole))
    : primaryRaw;
  const general = filterByParent
    ? generalRaw.filter((l) => isAllowedFor(l, parentRole))
    : generalRaw;
  const last = state.last?.[poolKey];

  const candidates = primary.filter((l) => l !== last);
  let picked;
  if (candidates.length > 0) {
    picked = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (general.length > 0) {
    picked = general[Math.floor(Math.random() * general.length)];
  } else if (primary.length > 0) {
    picked = primary[0]; // last-resort: ignore no-repeat rule
  } else if (primaryRaw.length > 0) {
    // Filtered pools both empty — fall back to unfiltered primary so we
    // never end up with an empty message.
    picked = primaryRaw[0];
  } else {
    picked = '...';
  }

  return {
    text: picked,
    newState: {
      ...state,
      last: { ...(state.last || {}), [poolKey]: picked },
    },
  };
}
