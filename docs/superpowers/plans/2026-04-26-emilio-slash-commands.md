# Emilio-care Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four host-side Discord slash commands for #emilio-care (`/asleep`, `/awake`, `/feeding`, `/update-feeding`) that bypass the agent entirely — instant response, zero Sonnet tokens.

**Architecture:** Single dispatcher script (`scripts/emilio-slash.mjs`) routes by action. Pure helpers live in `groups/discord_emilio-care/scripts/` (parse_time, feeding_log, emilio_chime). Sleep events reuse existing `open_sleep.mjs` / `close_sleep.mjs`. After every sheet write, emit two IPC messages: `edit_message label:status_card` (rebuilt card text) and `message sender:"Emilio"` (chime). Discord registration happens in `src/channels/discord.ts` mirroring the wordle/qotd/chore patterns.

**Tech Stack:** Node.js 22, TypeScript (discord.ts), .mjs ES modules (host-side scripts), vitest, Google Sheets v4, discord.js v14, NanoClaw IPC (file-based).

---

## File Structure

| Path | Role |
|---|---|
| `groups/discord_emilio-care/scripts/parse_time.mjs` | **Create.** Pure time parser. Exports `parseTime(input, now)`. |
| `groups/discord_emilio-care/scripts/feeding_log.mjs` | **Create.** Feedings tab helpers (append, update, recentFeedingsToday). |
| `groups/discord_emilio-care/scripts/emilio_chime.mjs` | **Create.** Pool-based chime selector with no-repeat state. |
| `scripts/emilio-slash.mjs` | **Create.** Host-side dispatcher with `asleep`, `awake`, `feeding`, `update-feeding`, `autocomplete-feeding-row` actions. |
| `groups/discord_emilio-care/scripts/parse_time.test.mjs` | **Create.** Time parser tests. |
| `groups/discord_emilio-care/scripts/feeding_log.test.mjs` | **Create.** Feeding helpers tests with mocked Sheets API. |
| `groups/discord_emilio-care/scripts/emilio_chime.test.mjs` | **Create.** Chime selector tests. |
| `scripts/emilio-slash.test.mjs` | **Create.** End-to-end dispatcher tests with mocked sheet + IPC writer. |
| `src/channels/discord.ts` | **Modify.** Register 4 slash commands; route invocations to `emilio-slash.mjs`; wire autocomplete handler. |
| `groups/discord_emilio-care/CLAUDE.md` | **Modify.** Document slash availability; agent should respect both paths. |

**Reused (no changes):**
- `groups/discord_emilio-care/open_sleep.mjs` — already accepts a Chicago-timestamp arg.
- `groups/discord_emilio-care/close_sleep.mjs` — already validates single-open invariant.
- `groups/discord_emilio-care/build_status_card.mjs` — already host-runnable; exports `buildStatusCard({ token })`.
- `src/ipc-writer.ts` — already exports `writeIpcMessage`.

---

## Task 1: Time parser

**Files:**
- Create: `groups/discord_emilio-care/scripts/parse_time.mjs`
- Test: `groups/discord_emilio-care/scripts/parse_time.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// groups/discord_emilio-care/scripts/parse_time.test.mjs
import { describe, it, expect } from 'vitest';
import { parseTime } from './parse_time.mjs';

const NOW = new Date('2026-04-25T20:00:00-05:00'); // 8pm CDT

describe('parseTime', () => {
  it('returns now for empty/now/n input', () => {
    for (const i of ['', 'now', 'n', ' ']) {
      const r = parseTime(i, NOW);
      expect(r.iso).toBe('2026-04-25 20:00:00');
    }
  });

  it('parses bare integer minutes-ago', () => {
    expect(parseTime('5', NOW).iso).toBe('2026-04-25 19:55:00');
    expect(parseTime('45', NOW).iso).toBe('2026-04-25 19:15:00');
    expect(parseTime('90', NOW).iso).toBe('2026-04-25 18:30:00');
  });

  it('rejects bare integer >120 as ambiguous', () => {
    expect(() => parseTime('200', NOW)).toThrow(/ambiguous/);
  });

  it('parses minute suffixes', () => {
    for (const i of ['5m', '5min', '5 min ago', '5mins ago', '5 minutes ago']) {
      expect(parseTime(i, NOW).iso).toBe('2026-04-25 19:55:00');
    }
  });

  it('parses hour suffixes including decimals', () => {
    expect(parseTime('1h', NOW).iso).toBe('2026-04-25 19:00:00');
    expect(parseTime('1.5h', NOW).iso).toBe('2026-04-25 18:30:00');
    expect(parseTime('2 hours ago', NOW).iso).toBe('2026-04-25 18:00:00');
  });

  it('parses absolute 12h with am/pm', () => {
    expect(parseTime('2:30pm', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('2:30 PM', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('8pm', NOW).iso).toBe('2026-04-25 20:00:00');
  });

  it('parses absolute 24h', () => {
    expect(parseTime('14:30', NOW).iso).toBe('2026-04-25 14:30:00');
    expect(parseTime('19:55', NOW).iso).toBe('2026-04-25 19:55:00');
  });

  it('rolls absolute time to yesterday if >1h future', () => {
    // NOW=20:00, "23:30" is 3.5h future → yesterday
    expect(parseTime('23:30', NOW).iso).toBe('2026-04-24 23:30:00');
  });

  it('keeps absolute time today if ≤1h future', () => {
    // NOW=20:00, "20:30" is 30m future → still today
    expect(parseTime('20:30', NOW).iso).toBe('2026-04-25 20:30:00');
  });

  it('throws on malformed input', () => {
    expect(() => parseTime('garbage', NOW)).toThrow(/parse_time/);
    expect(() => parseTime('25:99', NOW)).toThrow(/parse_time/);
  });

  it('returns displayLocal with am/pm', () => {
    expect(parseTime('14:30', NOW).displayLocal).toBe('2:30 PM');
    expect(parseTime('5m', NOW).displayLocal).toBe('7:55 PM');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run groups/discord_emilio-care/scripts/parse_time.test.mjs`
Expected: FAIL — `parseTime is not a function` (file doesn't exist).

- [ ] **Step 3: Implement parse_time.mjs**

```js
// groups/discord_emilio-care/scripts/parse_time.mjs
// Pure time parser for Emilio-care slash commands. Returns Chicago wall-clock
// "YYYY-MM-DD HH:MM:SS" plus a 12h display string. The slash dispatcher
// converts this to whatever Sheets expects.

const TZ = 'America/Chicago';

function chicagoParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
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

export function parseTime(input, now = new Date()) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw === 'now' || raw === 'n') {
    return { iso: fmtIso(now), displayLocal: fmtDisplay(now) };
  }

  // Suffix forms: "5m", "5min", "5 min ago", "1.5h", "2 hours ago"
  const suffixMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b(?:\s+ago)?$/);
  if (suffixMatch) {
    const n = parseFloat(suffixMatch[1]);
    const unit = suffixMatch[2];
    const ms = unit.startsWith('h') ? n * 3600_000 : n * 60_000;
    return {
      iso: fmtIso(new Date(now.getTime() - ms)),
      displayLocal: fmtDisplay(new Date(now.getTime() - ms)),
    };
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

    // Build a Date for "today at H:M" in Chicago.
    const todayParts = chicagoParts(now);
    const target = new Date(`${todayParts.year}-${todayParts.month}-${todayParts.day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    // The string above is parsed as local-machine TZ; correct by re-projecting.
    // Simpler: compute today's midnight in Chicago, then add h*60+m minutes.
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    // Get Chicago-midnight of today as UTC instant.
    // Trick: format now in Chicago to get its date, then construct an ISO string with -05:00 (CDT) or -06:00 (CST).
    // For April 2026 Chicago is on CDT (UTC-5).
    // We sidestep DST math by formatting and parsing an ISO with explicit offset:
    const offsetMin = -getChicagoOffsetMinutes(now); // negative: e.g. -300 for CDT
    const offsetHr = String(Math.abs(Math.floor(offsetMin / 60))).padStart(2, '0');
    const offsetSign = offsetMin <= 0 ? '-' : '+';
    const iso = `${todayParts.year}-${todayParts.month}-${todayParts.day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00${offsetSign}${offsetHr}:00`;
    let result = new Date(iso);

    // If parsed time is >1h in the future, treat as yesterday.
    if (result.getTime() - now.getTime() > 3600_000) {
      result = new Date(result.getTime() - 86400_000);
    }
    return { iso: fmtIso(result), displayLocal: fmtDisplay(result) };
  }

  fail(input, 'unrecognized format');
}

// Compute Chicago's UTC offset in minutes for the given instant. CDT=-300, CST=-360.
function getChicagoOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const chi = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  return Math.round((chi.getTime() - utc.getTime()) / 60_000);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run groups/discord_emilio-care/scripts/parse_time.test.mjs`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add -f groups/discord_emilio-care/scripts/parse_time.mjs groups/discord_emilio-care/scripts/parse_time.test.mjs
git commit -m "feat(emilio-slash): add parse_time helper with relative + absolute formats"
```

---

## Task 2: Feeding-log helpers

**Files:**
- Create: `groups/discord_emilio-care/scripts/feeding_log.mjs`
- Test: `groups/discord_emilio-care/scripts/feeding_log.test.mjs`

The Feedings tab schema: `[Feed time, Amount (oz), Source]`. Sheet ID `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`.

- [ ] **Step 1: Write the failing tests**

```js
// groups/discord_emilio-care/scripts/feeding_log.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { computeRecentFeedings, validateAmount } from './feeding_log.mjs';

describe('validateAmount', () => {
  it('accepts 0.1–20', () => {
    expect(validateAmount('2.5')).toBe(2.5);
    expect(validateAmount('0.5')).toBe(0.5);
    expect(validateAmount(20)).toBe(20);
  });
  it('rejects non-positive, non-numeric, >20', () => {
    expect(() => validateAmount('0')).toThrow();
    expect(() => validateAmount('abc')).toThrow();
    expect(() => validateAmount('25')).toThrow();
    expect(() => validateAmount('-1')).toThrow();
  });
});

describe('computeRecentFeedings', () => {
  const today = '2026-04-25';
  const rows = [
    ['Feed time', 'Amount (oz)', 'Source'],
    ['2026-04-25 09:00:00', '3', 'Formula'],
    ['2026-04-25 11:00:00', '2.5', 'Formula'],
    ['2026-04-24 22:00:00', '2', 'Formula'], // yesterday — excluded
    ['2026-04-25 17:30:00', '1.5', 'Formula'],
  ];

  it('returns today rows newest-first capped at limit', () => {
    const out = computeRecentFeedings(rows, today, 5);
    expect(out.map((r) => r.timestamp)).toEqual([
      '2026-04-25 17:30:00',
      '2026-04-25 11:00:00',
      '2026-04-25 09:00:00',
    ]);
  });

  it('honors limit', () => {
    expect(computeRecentFeedings(rows, today, 2).length).toBe(2);
  });

  it('returns empty when no rows for today', () => {
    expect(computeRecentFeedings(rows, '2026-04-26', 5)).toEqual([]);
  });

  it('preserves row index for sheet updates', () => {
    const out = computeRecentFeedings(rows, today, 5);
    // Row indices in the sheet are 1-based with header at row 1.
    // Newest (17:30) is rows[4] → sheet row 5.
    expect(out[0].sheetRow).toBe(5);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run groups/discord_emilio-care/scripts/feeding_log.test.mjs`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement feeding_log.mjs**

```js
// groups/discord_emilio-care/scripts/feeding_log.mjs
// Feedings tab helpers — pure functions for testability + thin Sheets API wrappers.

const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';
const TAB = 'Feedings';

export function validateAmount(input) {
  const n = typeof input === 'number' ? input : parseFloat(String(input ?? ''));
  if (!Number.isFinite(n)) throw new Error(`amount must be a number (got "${input}")`);
  if (n <= 0) throw new Error(`amount must be > 0 (got ${n})`);
  if (n > 20) throw new Error(`amount must be ≤ 20 oz (got ${n})`);
  return n;
}

// Pure: takes the full sheet rows (header + data) and returns today's feedings
// newest-first, each annotated with its 1-based sheet row number.
export function computeRecentFeedings(rows, todayDateStr, limit = 5) {
  if (!rows || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ts = r[0] || '';
    if (!ts.startsWith(todayDateStr)) continue;
    out.push({
      timestamp: ts,
      amount: r[1] || '',
      source: r[2] || '',
      sheetRow: i + 1, // header is row 1
    });
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit);
}

export async function appendFeeding(token, { timestamp, amount, source }) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[timestamp, amount, source]] }),
    },
  );
  if (!r.ok) throw new Error(`appendFeeding ${r.status}: ${await r.text()}`);
}

export async function updateFeedingAmount(token, { sheetRow, amount }) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!B${sheetRow}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[amount]] }),
    },
  );
  if (!r.ok) throw new Error(`updateFeedingAmount ${r.status}: ${await r.text()}`);
}

export async function readFeedings(token) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB + '!A:C')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (j.error) throw new Error(`readFeedings ${j.error.message}`);
  return j.values || [];
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run groups/discord_emilio-care/scripts/feeding_log.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f groups/discord_emilio-care/scripts/feeding_log.mjs groups/discord_emilio-care/scripts/feeding_log.test.mjs
git commit -m "feat(emilio-slash): add feeding_log helpers (append/update/recent)"
```

---

## Task 3: Chime selector

**Files:**
- Create: `groups/discord_emilio-care/scripts/emilio_chime.mjs`
- Test: `groups/discord_emilio-care/scripts/emilio_chime.test.mjs`

`emilio_voice.md` has pools: **Feed**, **Diaper**, **Nap start**, **Wake**, **General / chime-ins**. No `feeding_update` pool exists. Reuse Feed pool for `feeding_update`.

- [ ] **Step 1: Write the failing tests**

```js
// groups/discord_emilio-care/scripts/emilio_chime.test.mjs
import { describe, it, expect } from 'vitest';
import { pickChime, parsePools } from './emilio_chime.mjs';

const SAMPLE_VOICE_MD = `
### Feed
- \`nom nom\`
- \`mmm milk\`
- \`glug glug\`

### Nap start
- \`nini mama\`
- \`zzz goo\`

### Wake
- \`ouuu awake\`
- \`hi mama\`

### General
- \`goo\`
- \`mama 💛\`
`;

describe('parsePools', () => {
  it('extracts pools from markdown ###/- entries', () => {
    const pools = parsePools(SAMPLE_VOICE_MD);
    expect(pools.feed).toEqual(['nom nom', 'mmm milk', 'glug glug']);
    expect(pools.nap_start).toEqual(['nini mama', 'zzz goo']);
    expect(pools.wake).toEqual(['ouuu awake', 'hi mama']);
    expect(pools.general).toEqual(['goo', 'mama 💛']);
  });
});

describe('pickChime', () => {
  const pools = {
    feed: ['nom nom', 'mmm milk', 'glug glug'],
    wake: ['ouuu awake', 'hi mama'],
    nap_start: ['nini mama', 'zzz goo'],
    general: ['goo'],
  };

  it('picks from the right pool', () => {
    const r = pickChime('feed', pools, { last: {} });
    expect(['nom nom', 'mmm milk', 'glug glug']).toContain(r.text);
  });

  it('avoids the last-picked line for that event', () => {
    const r = pickChime('feed', pools, { last: { feed: 'nom nom' } });
    expect(r.text).not.toBe('nom nom');
  });

  it('falls back to feed pool for feeding_update', () => {
    const r = pickChime('feeding_update', pools, { last: {} });
    expect(['nom nom', 'mmm milk', 'glug glug']).toContain(r.text);
  });

  it('falls back to general when pool is missing or single-element + same as last', () => {
    // Wake pool has only 2; if both have been used, fallback to general
    const r = pickChime('wake', { wake: ['ouuu awake'], general: ['goo'] }, { last: { wake: 'ouuu awake' } });
    expect(r.text).toBe('goo');
  });

  it('updates state with the picked line', () => {
    const r = pickChime('nap_start', pools, { last: { nap_start: 'nini mama' } });
    expect(r.newState.last.nap_start).toBe(r.text);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run groups/discord_emilio-care/scripts/emilio_chime.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement emilio_chime.mjs**

```js
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
  const lines = markdown.split('\n');
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const key = HEADING_TO_KEY[heading[1].toLowerCase()] ?? null;
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

export function pickChime(eventType, pools, state = { last: {} }) {
  const poolKey = EVENT_TO_POOL[eventType] ?? 'general';
  const primary = pools[poolKey] ?? [];
  const general = pools.general ?? [];
  const last = state.last?.[poolKey];

  const candidates = primary.filter((l) => l !== last);
  let picked;
  if (candidates.length > 0) {
    picked = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (general.length > 0) {
    picked = general[Math.floor(Math.random() * general.length)];
  } else if (primary.length > 0) {
    picked = primary[0]; // last-resort: ignore no-repeat rule
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
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run groups/discord_emilio-care/scripts/emilio_chime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -f groups/discord_emilio-care/scripts/emilio_chime.mjs groups/discord_emilio-care/scripts/emilio_chime.test.mjs
git commit -m "feat(emilio-slash): add chime selector with pool parsing + no-repeat"
```

---

## Task 4: Slash dispatcher (the main script)

**Files:**
- Create: `scripts/emilio-slash.mjs`
- Test: `scripts/emilio-slash.test.mjs`

The dispatcher is invoked from `discord.ts` as a child process. Actions: `asleep`, `awake`, `feeding`, `update-feeding`, `autocomplete-feeding-row`. All emit a single JSON line on stdout.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/emilio-slash.test.mjs
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// We'll stub fetch + dist/ipc-writer.js in module-level mocks.
// The dispatcher exports each action handler for direct invocation in tests.

import {
  runAsleep,
  runAwake,
  runFeeding,
  runUpdateFeeding,
  runAutocompleteFeedingRow,
} from './emilio-slash.mjs';

const TOKEN = 'fake-token';
const FEED_TS = '2026-04-25 17:30:00';
const PADEN = '181867944404320256';

function makeDeps(overrides = {}) {
  return {
    getToken: vi.fn(async () => TOKEN),
    readSleepLog: vi.fn(async () => [['Start','Duration']]),
    openSleep: vi.fn(async () => ({ ok: true, row: 5, startTime: 'now' })),
    closeSleep: vi.fn(async () => ({ ok: true, durationMin: 30 })),
    appendFeeding: vi.fn(async () => undefined),
    updateFeedingAmount: vi.fn(async () => undefined),
    readFeedings: vi.fn(async () => [['Feed time','Amount','Source'], [FEED_TS, '1.5', 'Formula']]),
    buildStatusCard: vi.fn(async () => ({ discord: 'CARD', agentRef: '', full: 'CARD' })),
    writeIpcMessage: vi.fn(async () => '/tmp/x.json'),
    pickChime: vi.fn((evt) => ({ text: `chime:${evt}`, newState: { last: {} } })),
    loadChimeState: vi.fn(() => ({ last: {} })),
    saveChimeState: vi.fn(() => undefined),
    now: new Date('2026-04-25T20:00:00-05:00'),
    ...overrides,
  };
}

describe('runAsleep', () => {
  it('opens a new nap when none open', async () => {
    const deps = makeDeps();
    const out = await runAsleep({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.openSleep).toHaveBeenCalledTimes(1);
    expect(deps.writeIpcMessage).toHaveBeenCalledTimes(2); // status_card + chime
  });

  it('refuses when an open nap exists', async () => {
    const deps = makeDeps({
      readSleepLog: async () => [['Start','Duration'], ['2026-04-25 19:00:00', '']],
    });
    const out = await runAsleep({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Open nap from/);
    expect(deps.openSleep).not.toHaveBeenCalled();
  });
});

describe('runAwake', () => {
  it('errors with no open nap', async () => {
    const deps = makeDeps();
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No open nap/);
  });

  it('errors with 2+ open naps', async () => {
    const deps = makeDeps({
      readSleepLog: async () => [
        ['Start','Duration'],
        ['2026-04-25 19:00:00', ''],
        ['2026-04-25 19:30:00', ''],
      ],
    });
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Multiple open/);
  });

  it('closes the single open nap', async () => {
    const deps = makeDeps({
      readSleepLog: async () => [
        ['Start','Duration'],
        ['2026-04-25 19:30:00', ''],
      ],
    });
    const out = await runAwake({ userId: PADEN, time: 'now' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.closeSleep).toHaveBeenCalledTimes(1);
  });
});

describe('runFeeding', () => {
  it('appends, fires chime, rebuilds card', async () => {
    const deps = makeDeps();
    const out = await runFeeding({ userId: PADEN, amount: '2.5', time: 'now', source: 'Formula' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.appendFeeding).toHaveBeenCalledWith(TOKEN, expect.objectContaining({
      amount: 2.5, source: 'Formula',
    }));
    expect(deps.writeIpcMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects bad amount', async () => {
    const deps = makeDeps();
    const out = await runFeeding({ userId: PADEN, amount: 'abc', time: 'now', source: 'Formula' }, deps);
    expect(out.ok).toBe(false);
    expect(deps.appendFeeding).not.toHaveBeenCalled();
  });

  it('auto-closes a single open nap', async () => {
    const deps = makeDeps({
      readSleepLog: async () => [
        ['Start','Duration'],
        ['2026-04-25 19:30:00', ''],
      ],
    });
    const out = await runFeeding({ userId: PADEN, amount: '2', time: 'now', source: 'Formula' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.closeSleep).toHaveBeenCalledTimes(1);
    expect(out.napClosed).toBe(true);
  });

  it('does NOT auto-close when 0 or 2+ open', async () => {
    const deps = makeDeps({
      readSleepLog: async () => [['Start','Duration']], // zero open
    });
    await runFeeding({ userId: PADEN, amount: '2', time: 'now', source: 'Formula' }, deps);
    expect(deps.closeSleep).not.toHaveBeenCalled();
  });
});

describe('runUpdateFeeding', () => {
  it('updates most recent today when row arg is empty', async () => {
    const deps = makeDeps();
    const out = await runUpdateFeeding({ userId: PADEN, amount: '3', row: '' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateFeedingAmount).toHaveBeenCalledWith(TOKEN, { sheetRow: 2, amount: 3 });
  });

  it('updates by timestamp when row provided', async () => {
    const deps = makeDeps({
      readFeedings: async () => [
        ['Feed time','Amount','Source'],
        ['2026-04-25 09:00:00', '3', 'Formula'],
        ['2026-04-25 17:30:00', '1.5', 'Formula'],
      ],
    });
    const out = await runUpdateFeeding({ userId: PADEN, amount: '2', row: '2026-04-25 09:00:00' }, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateFeedingAmount).toHaveBeenCalledWith(TOKEN, { sheetRow: 2, amount: 2 });
  });

  it('refuses cross-day row', async () => {
    const deps = makeDeps({
      readFeedings: async () => [
        ['Feed time','Amount','Source'],
        ['2026-04-24 22:00:00', '2', 'Formula'],
      ],
    });
    const out = await runUpdateFeeding({ userId: PADEN, amount: '3', row: '2026-04-24 22:00:00' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/today only/i);
  });

  it('errors when no feedings today', async () => {
    const deps = makeDeps({ readFeedings: async () => [['Feed time','Amount','Source']] });
    const out = await runUpdateFeeding({ userId: PADEN, amount: '3', row: '' }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No feedings/);
  });
});

describe('runAutocompleteFeedingRow', () => {
  it('returns up to 5 today, newest first', async () => {
    const deps = makeDeps({
      readFeedings: async () => [
        ['Feed time','Amount','Source'],
        ['2026-04-25 09:00:00', '3', 'Formula'],
        ['2026-04-25 11:00:00', '2.5', 'Formula'],
        ['2026-04-25 17:30:00', '1.5', 'Formula'],
      ],
    });
    const out = await runAutocompleteFeedingRow({}, deps);
    expect(out.ok).toBe(true);
    expect(out.options.length).toBe(3);
    expect(out.options[0].label).toMatch(/5:30 PM/);
    expect(out.options[0].value).toBe('2026-04-25 17:30:00');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run scripts/emilio-slash.test.mjs`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement emilio-slash.mjs**

```js
#!/usr/bin/env node
// scripts/emilio-slash.mjs — host-side runner for /asleep, /awake, /feeding,
// /update-feeding. Dispatches by first CLI arg. Each action returns a JSON
// envelope on stdout consumed by src/channels/discord.ts.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

process.env.GOOGLE_OAUTH_CREDENTIALS =
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(ROOT, 'data', 'google-calendar', 'gcp-oauth.keys.json');
process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH =
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

const TZ = 'America/Chicago';
const GROUP_DIR = path.join(ROOT, 'groups', 'discord_emilio-care');
const CHAT_JID = 'dc:1490781468182577172';
const CHIME_STATE_PATH = path.join(GROUP_DIR, 'emilio_chime_state.json');
const VOICE_MD_PATH = path.join(GROUP_DIR, 'emilio_voice.md');

const USER_TO_OWNER = {
  '181867944404320256': 'Paden',
  '350815183804825600': 'Brenda',
  '280744944358916097': 'Danny',
};

const SHEET_ID = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function chicagoDateStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Pure deps map — passed into runX for testability. Default impl uses live IO.
async function defaultDeps() {
  const { parseTime } = await import('../groups/discord_emilio-care/scripts/parse_time.mjs');
  const { appendFeeding, updateFeedingAmount, readFeedings, validateAmount } =
    await import('../groups/discord_emilio-care/scripts/feeding_log.mjs');
  const { parsePools, pickChime } =
    await import('../groups/discord_emilio-care/scripts/emilio_chime.mjs');
  const sheets = await import('../groups/global/scripts/lib/sheets.mjs');
  const ipc = await import('../dist/ipc-writer.js');
  const cardMod = await import('../groups/discord_emilio-care/build_status_card.mjs');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);

  const voice = fs.existsSync(VOICE_MD_PATH) ? fs.readFileSync(VOICE_MD_PATH, 'utf8') : '';
  const pools = parsePools(voice);

  return {
    getToken: () => sheets.getAccessToken(),
    readSleepLog: async (token) => {
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Sleep Log!A:B')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      return j.values || [];
    },
    openSleep: async (timestamp) => {
      const { stdout } = await execFileP('node', [path.join(GROUP_DIR, 'open_sleep.mjs'), timestamp], {
        env: { ...process.env, WORKSPACE_GROUP: GROUP_DIR, WORKSPACE_GLOBAL: path.join(ROOT, 'groups', 'global') },
      });
      return JSON.parse(stdout.trim().split('\n').pop());
    },
    closeSleep: async (timestamp) => {
      const { stdout } = await execFileP('node', [path.join(GROUP_DIR, 'close_sleep.mjs'), timestamp], {
        env: { ...process.env, WORKSPACE_GROUP: GROUP_DIR, WORKSPACE_GLOBAL: path.join(ROOT, 'groups', 'global') },
      });
      return JSON.parse(stdout.trim().split('\n').pop());
    },
    appendFeeding,
    updateFeedingAmount,
    readFeedings,
    validateAmount,
    buildStatusCard: cardMod.buildStatusCard,
    writeIpcMessage: ipc.writeIpcMessage,
    pickChime: (evt, state) => pickChime(evt, pools, state),
    loadChimeState: () => {
      try { return JSON.parse(fs.readFileSync(CHIME_STATE_PATH, 'utf8')); }
      catch { return { last: {} }; }
    },
    saveChimeState: (s) => fs.writeFileSync(CHIME_STATE_PATH, JSON.stringify(s, null, 2)),
    parseTime,
    now: new Date(),
  };
}

function ownerFor(userId) { return USER_TO_OWNER[userId] || null; }

function findOpenNaps(rows) {
  if (!rows || rows.length < 2) return [];
  return rows.slice(1)
    .map((r, i) => ({ start: r[0] || '', duration: r[1] || '', sheetRow: i + 2 }))
    .filter((r) => r.start && !r.duration);
}

async function emitFollowups(deps, eventType, replyExtra = {}) {
  const token = await deps.getToken();
  // Status card
  let cardText;
  try {
    const card = await deps.buildStatusCard({ token });
    cardText = typeof card === 'string' ? card : card.discord ?? card.full ?? '';
  } catch (err) {
    process.stderr.write(`status_card rebuild failed: ${err.message}\n`);
  }
  if (cardText) {
    await deps.writeIpcMessage('discord_emilio-care', {
      type: 'edit_message',
      chatJid: CHAT_JID,
      label: 'status_card',
      text: cardText,
    });
  }
  // Chime
  const state = deps.loadChimeState();
  const { text, newState } = deps.pickChime(eventType, state);
  await deps.writeIpcMessage('discord_emilio-care', {
    type: 'message',
    chatJid: CHAT_JID,
    sender: 'Emilio',
    text,
  });
  deps.saveChimeState(newState);
}

// --- Action handlers (exported for tests) ---

export async function runAsleep({ userId, time }, deps) {
  if (!ownerFor(userId)) return { ok: false, error: 'You are not registered for emilio-care logging.' };
  const token = await deps.getToken();
  const rows = await deps.readSleepLog(token);
  const open = findOpenNaps(rows);
  if (open.length > 0) {
    return { ok: false, error: `Open nap from ${open[0].start}. Run /awake first or update the row directly.` };
  }
  const parsed = deps.parseTime(time, deps.now);
  const result = await deps.openSleep(parsed.iso);
  if (!result.ok) return { ok: false, error: result.error || 'open_sleep failed' };
  await emitFollowups(deps, 'asleep');
  return { ok: true, reply: `Nap opened at ${parsed.displayLocal}.` };
}

export async function runAwake({ userId, time }, deps) {
  if (!ownerFor(userId)) return { ok: false, error: 'You are not registered for emilio-care logging.' };
  const token = await deps.getToken();
  const rows = await deps.readSleepLog(token);
  const open = findOpenNaps(rows);
  if (open.length === 0) return { ok: false, error: 'No open nap to close.' };
  if (open.length > 1) return { ok: false, error: 'Multiple open naps — please clean up the sheet first.' };
  const parsed = deps.parseTime(time, deps.now);
  const result = await deps.closeSleep(parsed.iso);
  if (!result.ok) return { ok: false, error: result.error || 'close_sleep failed' };
  await emitFollowups(deps, 'awake');
  return { ok: true, reply: `Nap closed at ${parsed.displayLocal}, ${result.durationMin} min.` };
}

export async function runFeeding({ userId, amount, time, source }, deps) {
  if (!ownerFor(userId)) return { ok: false, error: 'You are not registered for emilio-care logging.' };
  let n;
  try { n = deps.validateAmount(amount); }
  catch (err) { return { ok: false, error: err.message }; }
  const parsed = deps.parseTime(time, deps.now);
  const src = source || 'Formula';
  const token = await deps.getToken();
  await deps.appendFeeding(token, { timestamp: parsed.iso, amount: n, source: src });

  // Implicit wake-up
  let napClosed = false;
  const sleepRows = await deps.readSleepLog(token);
  const open = findOpenNaps(sleepRows);
  if (open.length === 1) {
    const closeResult = await deps.closeSleep(parsed.iso);
    if (closeResult.ok) napClosed = true;
  }

  await emitFollowups(deps, 'feeding');
  const reply = `Logged ${n}oz ${src} at ${parsed.displayLocal}.${napClosed ? ' Closed open nap.' : ''}`;
  return { ok: true, reply, napClosed };
}

export async function runUpdateFeeding({ userId, amount, row }, deps) {
  if (!ownerFor(userId)) return { ok: false, error: 'You are not registered for emilio-care logging.' };
  let n;
  try { n = deps.validateAmount(amount); }
  catch (err) { return { ok: false, error: err.message }; }

  const today = chicagoDateStr(deps.now);
  const token = await deps.getToken();
  const allRows = await deps.readFeedings(token);

  let target;
  if (row) {
    if (!row.startsWith(today)) {
      return { ok: false, error: 'Today only — older rows must be edited via the agent or sheet.' };
    }
    const idx = allRows.findIndex((r) => r[0] === row);
    if (idx === -1) return { ok: false, error: `No feeding row matches ${row}.` };
    target = { timestamp: row, amount: allRows[idx][1], sheetRow: idx + 1 };
  } else {
    // Default: most recent today.
    const todays = [];
    for (let i = 1; i < allRows.length; i++) {
      const ts = allRows[i][0] || '';
      if (ts.startsWith(today)) todays.push({ timestamp: ts, amount: allRows[i][1], sheetRow: i + 1 });
    }
    if (todays.length === 0) return { ok: false, error: 'No feedings logged today.' };
    todays.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    target = todays[0];
  }

  await deps.updateFeedingAmount(token, { sheetRow: target.sheetRow, amount: n });
  await emitFollowups(deps, 'feeding_update');
  return {
    ok: true,
    reply: `Feeding at ${target.timestamp.slice(11, 16)} updated: ${target.amount}oz → ${n}oz.`,
  };
}

export async function runAutocompleteFeedingRow(_args, deps) {
  const token = await deps.getToken();
  const today = chicagoDateStr(deps.now);
  const allRows = await deps.readFeedings(token);
  const todays = [];
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    const ts = r[0] || '';
    if (ts.startsWith(today)) todays.push({ ts, amount: r[1] || '', source: r[2] || '' });
  }
  todays.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const top = todays.slice(0, 5);
  return {
    ok: true,
    options: top.map((t) => {
      const hh = parseInt(t.ts.slice(11, 13), 10);
      const mm = t.ts.slice(14, 16);
      const ampm = hh < 12 ? 'AM' : 'PM';
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return {
        value: t.ts,
        label: `${h12}:${mm} ${ampm} · ${t.amount}oz ${t.source}`,
      };
    }),
  };
}

// --- CLI ---

async function main() {
  const [, , action, userId, ...rest] = process.argv;
  if (!action) {
    process.stderr.write('usage: emilio-slash.mjs <action> [userId] [args...]\n');
    process.exit(2);
  }
  const deps = await defaultDeps();
  try {
    let out;
    switch (action) {
      case 'asleep':
        out = await runAsleep({ userId, time: rest[0] || '' }, deps);
        break;
      case 'awake':
        out = await runAwake({ userId, time: rest[0] || '' }, deps);
        break;
      case 'feeding':
        out = await runFeeding({ userId, amount: rest[0], time: rest[1] || '', source: rest[2] || '' }, deps);
        break;
      case 'update-feeding':
        out = await runUpdateFeeding({ userId, amount: rest[0], row: rest[1] || '' }, deps);
        break;
      case 'autocomplete-feeding-row':
        out = await runAutocompleteFeedingRow({}, deps);
        break;
      default:
        out = { ok: false, error: `unknown action: ${action}` };
    }
    emit(out);
  } catch (err) {
    emit({ ok: false, error: err.message, stack: err.stack });
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run scripts/emilio-slash.test.mjs`
Expected: PASS — all dispatcher tests green.

- [ ] **Step 5: Run full suite to check no regressions**

Run: `npm test`
Expected: PASS, count = previous_total + 30+ new tests.

- [ ] **Step 6: Commit**

```bash
git add -f scripts/emilio-slash.mjs scripts/emilio-slash.test.mjs
git commit -m "feat(emilio-slash): add dispatcher for /asleep /awake /feeding /update-feeding"
```

---

## Task 5: Discord registration

**Files:**
- Modify: `src/channels/discord.ts`

The existing pattern (lines 322-360 area, plus 392-450 for registration). Add 4 commands and one autocomplete handler.

- [ ] **Step 1: Read current registration block**

```bash
sed -n '390,460p' /Users/paden.portillobrinqa.com/ai-workspace/nanoclaw/src/channels/discord.ts
```
Note where `chore`, `qotd`, `wordle` get registered. The `addStringOption` and `addNumberOption` patterns.

- [ ] **Step 2: Add the four command definitions** after the existing `chore` block in the registration list:

```ts
new SlashCommandBuilder()
  .setName('asleep')
  .setDescription('Log Emilio falling asleep (#emilio-care)')
  .addStringOption((opt) =>
    opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
  ),
new SlashCommandBuilder()
  .setName('awake')
  .setDescription('Close the open nap (#emilio-care)')
  .addStringOption((opt) =>
    opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
  ),
new SlashCommandBuilder()
  .setName('feeding')
  .setDescription('Log a feeding (#emilio-care)')
  .addNumberOption((opt) =>
    opt.setName('amount').setDescription('Ounces, e.g. 2.5').setMinValue(0.1).setMaxValue(20).setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
  )
  .addStringOption((opt) =>
    opt.setName('source').setDescription('Source (default Formula)').setRequired(false)
      .addChoices({ name: 'Formula', value: 'Formula' }, { name: 'Breast', value: 'Breast' }),
  ),
new SlashCommandBuilder()
  .setName('update-feeding')
  .setDescription('Correct a recent feeding amount (#emilio-care)')
  .addNumberOption((opt) =>
    opt.setName('amount').setDescription('Corrected oz').setMinValue(0.1).setMaxValue(20).setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('row').setDescription('Which feeding (autocomplete shows last 5)').setRequired(false).setAutocomplete(true),
  ),
```

- [ ] **Step 3: Add invocation handlers** in the `interaction.isChatInputCommand()` block (where `chore` is handled around line 349):

```ts
if (
  interaction.commandName === 'asleep' ||
  interaction.commandName === 'awake' ||
  interaction.commandName === 'feeding' ||
  interaction.commandName === 'update-feeding'
) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const args: string[] = [];
  if (interaction.commandName === 'asleep' || interaction.commandName === 'awake') {
    args.push(interaction.options.getString('time') || '');
  } else if (interaction.commandName === 'feeding') {
    args.push(String(interaction.options.getNumber('amount')));
    args.push(interaction.options.getString('time') || '');
    args.push(interaction.options.getString('source') || '');
  } else {
    // update-feeding
    args.push(String(interaction.options.getNumber('amount')));
    args.push(interaction.options.getString('row') || '');
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      'node',
      [
        path.join(process.cwd(), 'scripts', 'emilio-slash.mjs'),
        interaction.commandName,
        userId,
        ...args,
      ],
      { timeout: 30_000, maxBuffer: 1_000_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (result.ok) {
      await interaction.editReply({ content: result.reply || 'Done.' });
    } else {
      await interaction.editReply({ content: `❌ ${result.error || 'Unknown error'}` });
    }
  } catch (err: unknown) {
    const e = err as Error;
    await interaction.editReply({ content: `❌ slash error: ${e.message}` });
  }
  return;
}
```

- [ ] **Step 4: Add autocomplete handler** in the autocomplete-interaction block (where `chore` autocomplete lives):

```ts
if (interaction.commandName === 'update-feeding') {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      'node',
      [
        path.join(process.cwd(), 'scripts', 'emilio-slash.mjs'),
        'autocomplete-feeding-row',
        interaction.user.id,
      ],
      { timeout: 5_000, maxBuffer: 200_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (result.ok && result.options) {
      await interaction.respond(result.options.slice(0, 25));
    } else {
      await interaction.respond([]);
    }
  } catch {
    await interaction.respond([]);
  }
  return;
}
```

- [ ] **Step 5: Run TypeScript check + tests**

```bash
npm run build
npm test
```
Expected: build clean, all tests pass (existing discord.ts tests should not break — they don't cover the new branches).

- [ ] **Step 6: Manual smoke test** (in Discord, after restart)

1. Restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
2. In #emilio-care, run `/asleep`. Expect: ephemeral reply "Nap opened at HH:MM AM/PM.", pinned card refreshes within ~2s, Emilio chime posts.
3. Run `/asleep` again. Expect: error reply about open nap.
4. Run `/awake`. Expect: success reply with duration, card refreshes, Emilio chime.
5. Run `/feeding amount:2.5`. Expect: success reply, card refreshes, Emilio chime. If a nap was open, "Closed open nap." appended.
6. Run `/update-feeding amount:3.0`. Expect: most recent feeding amount changes to 3.0, card refreshes, Emilio chime.
7. Test bad input: `/feeding amount:0` (rejected by Discord min-value).

- [ ] **Step 7: Commit**

```bash
git add src/channels/discord.ts
git commit -m "feat(discord): register /asleep /awake /feeding /update-feeding for #emilio-care"
```

---

## Task 6: CLAUDE.md update + slash global registration script

**Files:**
- Modify: `groups/discord_emilio-care/CLAUDE.md`

The agent in #emilio-care needs to know slash commands exist so it doesn't redundantly suggest typing free-text when a slash would do, and so it doesn't duplicate the chime when a slash already fired one.

- [ ] **Step 1: Append a "Slash commands" section to `groups/discord_emilio-care/CLAUDE.md`**

```markdown
## Slash commands (host-side, no agent fire)

These slash commands are handled directly by the host without invoking you. They write to the sheet, fire the Emilio chime, and rebuild the status card on their own:

- `/asleep [time]` — opens a nap (errors if one is already open).
- `/awake [time]` — closes the open nap (errors on 0 or 2+ open).
- `/feeding amount:<oz> [time] [source]` — logs a feeding; auto-closes a single open nap.
- `/update-feeding amount:<oz> [row]` — corrects a recent feeding's amount.

`time` accepts `5m`, `2:30pm`, `14:30`, `now`, blank.

When you see one of these slash invocations in the channel transcript:
- **Don't re-log** the same event. The slash already wrote it.
- **Don't fire another chime.** The slash already fired one.
- **You can still answer questions** that come alongside (e.g. "Did you log that?" — answer based on the freshly-built card).
- For **complex multi-event messages** ("woke 30min ago, 2oz, diaper change"), continue using your existing log-then-ack flow — slashes don't replace free-text.
```

- [ ] **Step 2: Commit**

```bash
git add groups/discord_emilio-care/CLAUDE.md
git commit -m "docs(emilio-care): document slash commands so the agent doesn't double-log"
```

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Restart service to pick up new dist + slash registration**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Wait ~5s, verify clean boot via `tail -10 logs/nanoclaw.log`.

- [ ] **Step 5: Run the manual smoke test** from Task 5 Step 6 to confirm end-to-end works in Discord.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Tasks |
|---|---|
| `/asleep` behavior | Task 4 (`runAsleep`) + Task 5 registration + smoke test |
| `/awake` behavior | Task 4 (`runAwake`) + Task 5 registration + smoke test |
| `/feeding` behavior incl. auto-close | Task 4 (`runFeeding`) + Task 5 registration |
| `/update-feeding` behavior + autocomplete | Task 4 (`runUpdateFeeding`, `runAutocompleteFeedingRow`) + Task 5 |
| Time parser | Task 1 |
| Architecture: emilio-slash.mjs, parse_time, feeding_log, emilio_chime | Tasks 1–4 |
| Reused: open_sleep, close_sleep, build_status_card, ipc-writer | (no changes; called from Task 4) |
| Discord registration | Task 5 |
| CLAUDE.md update | Task 6 |
| Errors and edge cases | Covered in Task 4 tests (open conflict, no open, 2+ open, bad amount, cross-day, no feedings) |
| Permissions (USER_TO_OWNER) | Task 4 (`ownerFor` check at top of every action) |
| Testing (unit + manual smoke) | Tasks 1–4 unit; Task 5 Step 6 + Task 6 Step 5 manual |
| Out of scope (`/diaper`, etc.) | Excluded as planned |
| Risk: feeding_update pool fallback | Task 3 (`pickChime` falls back to feed pool) |
| Risk: autocomplete value stability | Task 4 (`row` arg uses timestamp not row index) |

No gaps.

**2. Placeholder scan:** No "TBD/TODO/etc.". All steps include exact code or exact commands.

**3. Type consistency:** `runAsleep`, `runAwake`, `runFeeding`, `runUpdateFeeding`, `runAutocompleteFeedingRow` are referenced consistently. `parseTime`, `appendFeeding`, `updateFeedingAmount`, `readFeedings`, `validateAmount`, `parsePools`, `pickChime`, `writeIpcMessage`, `buildStatusCard` — names match across tasks.

**Dependency graph:**
- Task 1 (parse_time) — independent.
- Task 2 (feeding_log) — independent.
- Task 3 (emilio_chime) — independent.
- Task 4 — depends on 1, 2, 3.
- Task 5 — depends on 4.
- Task 6 — depends on 5.

Tasks 1–3 can run in parallel; 4 must wait for all three; 5 waits for 4; 6 waits for 5.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-emilio-slash-commands.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks. Tasks 1–3 can run in parallel since they're independent; 4–6 sequentially.
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints.

Which approach?
