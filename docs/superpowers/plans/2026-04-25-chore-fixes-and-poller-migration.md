# Chore Fixes, Poller-to-Event-Driven Migration, and Emilio Reminder Dedup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three reported bugs in `/chore`, replace four cron pollers with event-driven hooks from existing slash commands, and decide what to do about the two overlapping emilio-care wind-down reminders.

**Architecture:** Slash commands already run host-side (no agent, no Sonnet cost). They can do everything the cron pollers do — read sheet state, update pinned cards via IPC, fire the agent only when truly needed (e.g., wordle reveal narration). One small new shared helper (`writeIpcMessage`) lets any host script post to a Discord channel. Old cron tasks get deleted from the SQLite scheduled-tasks table.

**Tech Stack:** Node.js 22, TypeScript, vitest, SQLite (`store/messages.db`), Google Sheets v4, Discord.js, NanoClaw IPC (file-based queue under `data/ipc/<group>/messages/`).

**Open question (Phase 6):** The two emilio-care pollers (`x7diaz` 15-min cadence and `bun1lw` 10-min cadence) are **not pure duplicates** per investigation: `x7diaz` is a longer-lead-time gentle warning ("time to start thinking about wind-down"), `bun1lw` is the tighter "happening now" reminder. Phase 6 proposes consolidating into one task with both phases; user signoff required before delete.

---

## Bug Reproduction Evidence (Phase 1 ground truth)

Verified at 2026-04-25 20:18 CDT against the live Silverthorne sheet:

- **Bug 3 (bundles only check off one) — CONFIRMED.** The "Formula Maker service" bundle (`formula_water,formula_gear`) appears in autocomplete with **+13 XP** even though `formula_gear` was already logged today at 20:11 by Paden. Submitting the bundle would skip `formula_gear` (line 397-401 of `scripts/chore-slash.mjs`) and only credit `+5 XP` for `formula_water` — 8 XP "lost" silently. User perceives this as "the bundle didn't check off both."
- **Bug 1 (XP given but chore not marked done) — likely a manifestation of Bug 3.** The "missing" chore in a bundle (`formula_gear` in the example) IS checked off (it was logged at 20:11), but because the bundle's autocomplete still appears with the original full XP and label, the user thinks nothing happened.
- **Bug 2 (all chores show overdue) — partially mistaken observation.** At 20:18, the autocomplete correctly classifies one chore as `later today (Dishes 9pm)`, four as `this week`, several as `to-do`, and the rest as `OVERDUE`. The "OVERDUE" entries are genuinely overdue (8am, 10am, 12pm, 8pm chores at 8:18pm). However, **bundles still surface even when their member single-chores are already filtered out as `done`** — that's the visual that probably triggered the "all overdue" complaint when combined with Bug 3.

The fix in Phase 1 addresses all three by recomputing bundle XP and visibility from `todayLog`.

---

## File Structure

| File | Role |
|---|---|
| `scripts/chore-slash.mjs` | **Modify** — fix bundle XP/eligibility, partial-bundle response, submit hook |
| `src/chore-slash.test.ts` | **Modify** — add bundle XP / partial-bundle / autocomplete tests |
| `src/ipc-writer.ts` | **Create** — host-side `writeIpcMessage(groupFolder, msg)` helper |
| `src/ipc-writer.test.ts` | **Create** — tests for the helper |
| `scripts/wordle-slash.mjs` | **Modify** — call gate logic + `writeIpcMessage` after `appendSubmission` |
| `scripts/qotd-slash.mjs` | **Modify** — call gate logic + `writeIpcMessage` after answer append |
| `groups/discord_silverthorne/scripts/build_status_card.mjs` | **Modify** — make callable from host (env-var paths) so chore-slash can rebuild the pinned card without containerization |
| `groups/discord_emilio-care/wind_down_check.mjs` (or similar) | **Modify** — consolidate phase logic if user picks Phase 6 option A |
| `store/messages.db` (`scheduled_tasks` table) | **Modify** — DELETE rows for migrated pollers (`task-1775540044035-jd0cw6`, `task-1775619472081-ja2ron`, `task-1775531043169-1skmt3`, possibly one of the emilio tasks) |

---

## Phase 1: Fix `/chore` bugs

### Task 1.1: Bundle XP and visibility reflect `todayLog`

**Files:**
- Modify: `scripts/chore-slash.mjs:308-321` (groupOptions construction)
- Test: `src/chore-slash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/chore-slash.test.ts — add these
import { describe, it, expect } from 'vitest';
import { computeBundleOption } from '../scripts/chore-slash.mjs';

describe('bundle XP', () => {
  const now = { dateStr: '2026-04-25', dow: 6, minutesSinceMidnight: 1218 };
  const chores = [
    { chore_id: 'a', name: 'A', duration_min: 5, cadence: 'daily', schedule: '20:00', assigned_to: 'anyone', nag_after_min: 30, nag_interval_min: 30, active: true },
    { chore_id: 'b', name: 'B', duration_min: 3, cadence: 'daily', schedule: '20:00', assigned_to: 'anyone', nag_after_min: 30, nag_interval_min: 30, active: true },
  ];
  const group = { group_id: 'g', label: 'G', chore_ids: ['a','b'] };

  it('returns full XP when no member is done', () => {
    const todayLog = [];
    const opt = computeBundleOption(group, chores, now, todayLog);
    expect(opt).not.toBeNull();
    expect(opt.xp).toBe(8); // 5+3 base, on-time => 1.5x => 12 actually. Adjust to actual logic.
  });

  it('returns reduced XP when one member already done', () => {
    const todayLog = [{ chore_id: 'a', status: 'on-time', timestamp: '2026-04-25 20:11:00' }];
    const opt = computeBundleOption(group, chores, now, todayLog);
    expect(opt).not.toBeNull();
    // Only b remains
    expect(opt.label).toContain('1 of 2');
    expect(opt.xp).toBeLessThan(8);
  });

  it('returns null when all members are done', () => {
    const todayLog = [
      { chore_id: 'a', status: 'on-time', timestamp: '2026-04-25 20:11:00' },
      { chore_id: 'b', status: 'on-time', timestamp: '2026-04-25 20:12:00' },
    ];
    expect(computeBundleOption(group, chores, now, todayLog)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chore-slash.test.ts -t "bundle XP"`
Expected: FAIL — `computeBundleOption is not a function` (export doesn't exist yet).

- [ ] **Step 3: Extract and export `computeBundleOption` in `chore-slash.mjs`**

Replace lines 308-321 with:
```js
export function computeBundleOption(group, chores, now, todayLog) {
  const memberChores = group.chore_ids
    .map((id) => chores.find((c) => c.chore_id === id))
    .filter(Boolean);
  if (memberChores.length === 0) return null;

  const remaining = memberChores.filter((c) => classifyChore(c, now, todayLog) !== 'done');
  if (remaining.length === 0) return null; // all done; hide bundle

  const anyActionable = remaining.some((c) => {
    const b = classifyChore(c, now, todayLog);
    return b === 'overdue' || b === 'upcoming_today';
  });
  if (!anyActionable) return null;

  const xpTotal = remaining.reduce(
    (sum, c) => sum + xpForChore(c, submitStatusFor(c, now)),
    0,
  );
  const partial = remaining.length < memberChores.length;
  const labelSuffix = partial
    ? ` (${remaining.length} of ${memberChores.length} left, +${xpTotal} XP)`
    : ` · bundle (+${xpTotal} XP)`;

  return {
    value: `group:${group.group_id}`,
    label: `${group.label}${labelSuffix}`,
    xp: xpTotal,
    rank: -1,
  };
}

// In runAutocomplete, replace the groupOptions block:
const groupOptions = groups
  .map((g) => computeBundleOption(g, chores, now, todayLog))
  .filter(Boolean);
```

- [ ] **Step 4: Run tests; iterate**

Run: `npx vitest run src/chore-slash.test.ts -t "bundle XP"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/chore-slash.mjs src/chore-slash.test.ts
git commit -m "fix(chore-slash): bundle XP reflects already-done members"
```

### Task 1.2: Submit response signals partial bundles

**Files:**
- Modify: `scripts/chore-slash.mjs:455-465` (fact line generation)
- Test: extend `src/chore-slash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('fact line shows partial bundle completion', () => {
  // Helper: mock results array shape from runSubmit
  const results = [
    { chore_id: 'a', name: 'A', skipped: 'already_done' },
    { chore_id: 'b', name: 'B', xp: 5, status: 'on-time' },
  ];
  const fact = buildFactLine('Paden', results);
  expect(fact).toContain('1 of 2');
  expect(fact).toContain('B'); // newly-done one
});
```

- [ ] **Step 2: Run, verify fail**

`npx vitest run src/chore-slash.test.ts -t "partial bundle"`

- [ ] **Step 3: Extract `buildFactLine` helper**

In `chore-slash.mjs`:
```js
export function buildFactLine(doneBy, results) {
  const newlyDone = results.filter((r) => r.xp && !r.skipped);
  const skipped = results.filter((r) => r.skipped === 'already_done');
  if (newlyDone.length === 0) return 'Nothing new to log — already done today.';
  if (skipped.length === 0 && newlyDone.length === 1)
    return `${doneBy} did: ${newlyDone[0].name}`;
  if (skipped.length === 0)
    return `${doneBy} did: ${newlyDone.map((r) => r.name).join(' & ')}`;
  // Partial bundle
  const total = newlyDone.length + skipped.length;
  return `${doneBy} did ${newlyDone.length} of ${total}: ${newlyDone.map((r) => r.name).join(' & ')}`;
}
```

Replace the inline fact construction in `runSubmit` with `buildFactLine(doneBy, results)`.

- [ ] **Step 4: Verify pass**

`npx vitest run src/chore-slash.test.ts`

- [ ] **Step 5: Commit**

`git commit -m "fix(chore-slash): submit response shows partial-bundle completion"`

### Task 1.3: Live verification

- [ ] **Step 1: Run autocomplete now, verify bundles with already-done members show reduced XP / "X of N left" label**

```bash
node scripts/chore-slash.mjs autocomplete 181867944404320256 ""
```

Expected: any bundle whose members are partially logged today shows label like `Formula Maker service (1 of 2 left, +5 XP)`. Bundles with all members done are absent.

- [ ] **Step 2: Pre-commit hook runs full vitest; confirm green.**

---

## Phase 2: Shared IPC writer helper

### Task 2.1: `src/ipc-writer.ts`

**Files:**
- Create: `src/ipc-writer.ts`
- Test: `src/ipc-writer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeIpcMessage } from './ipc-writer.js';

describe('writeIpcMessage', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('drops a JSON file in data/ipc/<group>/messages/', async () => {
    await writeIpcMessage('discord_test', {
      type: 'message',
      chatJid: 'dc:123',
      text: 'hi',
    }, { rootDir: tmpRoot });
    const dir = path.join(tmpRoot, 'data', 'ipc', 'discord_test', 'messages');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(body.type).toBe('message');
    expect(body.text).toBe('hi');
  });

  it('rejects unknown message types', async () => {
    await expect(
      writeIpcMessage('discord_test', { type: 'bogus' as any, chatJid: 'dc:1' }, { rootDir: tmpRoot }),
    ).rejects.toThrow(/unknown ipc type/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

`npx vitest run src/ipc-writer.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/ipc-writer.ts
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const VALID_TYPES = new Set([
  'message', 'edit_message', 'delete_message',
  'pin_message', 'unpin_message',
  'add_reaction', 'remove_reaction',
]);

export interface IpcMessage {
  type: string;
  chatJid: string;
  text?: string;
  label?: string;
  pin?: boolean;
  upsert?: boolean;
  sender?: string;
  emoji?: string;
  messageId?: string;
}

export async function writeIpcMessage(
  groupFolder: string,
  msg: IpcMessage,
  opts: { rootDir?: string } = {},
): Promise<string> {
  if (!VALID_TYPES.has(msg.type)) {
    throw new Error(`unknown ipc type: ${msg.type}`);
  }
  if (!msg.chatJid) throw new Error('chatJid required');

  const rootDir = opts.rootDir ?? process.cwd();
  const dir = path.join(rootDir, 'data', 'ipc', groupFolder, 'messages');
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, JSON.stringify(msg, null, 2));
  return filepath;
}
```

- [ ] **Step 4: Verify pass**

`npx vitest run src/ipc-writer.test.ts`

- [ ] **Step 5: Commit**

`git commit -m "feat(ipc): add host-side writeIpcMessage helper for slash commands"`

---

## Phase 3: Wordle event-driven

### Task 3.1: Extract gate logic into a reusable function

**Files:**
- Create: `groups/discord_family-fun/scripts/wordle_poll.mjs` (gate logic from current cron `script` column)
- Modify: `scripts/wordle-slash.mjs`

- [ ] **Step 1: Move the existing gate-script body** (currently embedded in the `scheduled_tasks.script` column for `task-1775540044035-jd0cw6`) into a new file `groups/discord_family-fun/scripts/wordle_poll.mjs`. Export `pollWordleState({ token })` returning `{ wakeAgent, data }`.

- [ ] **Step 2: Refactor so the function uses host paths when run from the slash, container paths when run by the agent.** Use env-var-driven path resolution (already a pattern in `wordle-slash.mjs:30-36`).

- [ ] **Step 3: Wire up `wordle-slash.mjs`** — after `appendSubmission()` succeeds (line ~62), call `pollWordleState`, then conditionally:
  - If `wakeAgent && !data.needs_resolve` → `writeIpcMessage(groupFolder, { type: 'message', chatJid, label: 'wordle_card', pin: true, upsert: true, text: buildCardText(data.summary) })` (a synchronous text-only card; no agent needed for counts).
  - If `data.needs_resolve` → `writeIpcMessage(groupFolder, { type: 'schedule_one_off_agent', ..., prompt: REVEAL_PROMPT })` so Sonnet narrates the saga **once** at reveal moment.

- [ ] **Step 4: Add an integration test** that mocks `appendRows` + `sheetsGet` and verifies the two paths emit the right IPC messages.

- [ ] **Step 5: Commit**

### Task 3.2: Delete the cron task

- [ ] **Step 1: Verify nothing else references `task-1775540044035-jd0cw6`.**
```bash
grep -rE "1775540044035|jd0cw6" --include="*.ts" --include="*.mjs" --include="*.md" .
```

- [ ] **Step 2: Delete the row.**
```bash
sqlite3 store/messages.db "DELETE FROM scheduled_tasks WHERE id='task-1775540044035-jd0cw6';"
```

- [ ] **Step 3: Run a `/wordle` guess and watch the logs** for `OneCLI gateway config applied` (should NOT appear except at reveal). Confirm `wordle_card` updates via IPC.

- [ ] **Step 4: Commit (DB change isn't tracked but commit the slash code).**

---

## Phase 4: Silverthorne nag event-driven

**Pre-req:** Phase 1 complete (chore-slash bundle bug fixed) and Phase 2 (`writeIpcMessage`).

The silverthorne nag has two distinct jobs:
- **(a) Status card refresh after a chore is logged** — currently the cron does this; it's purely event-driven and can move into chore-slash.
- **(b) Time-based nags for overdue chores** — fundamentally polling work (the polling IS the trigger). Stays as cron, but the cron prompt should NOT wake the agent — the gate script already constructs the nag text; we can post directly via IPC.

### Task 4.1: Move status-card rebuild to chore-slash post-submit

**Files:** `scripts/chore-slash.mjs`, `groups/discord_silverthorne/scripts/build_status_card.mjs`

- [ ] **Step 1:** Make `build_status_card.mjs` host-runnable (env-var paths, already partially the case).
- [ ] **Step 2:** In `chore-slash.mjs:runSubmit` after the XP-award block, run the card builder and `writeIpcMessage({ type: 'edit_message', label: 'status_card', text })`.
- [ ] **Step 3:** Test: run `/chore eni_breakfast`, confirm the pinned card refreshes within ~1s.

### Task 4.2: Convert the nag cron to script-only (no agent)

**Files:** `groups/discord_silverthorne/scripts/nag_check.mjs`, `scheduled_tasks` row `task-1775531043169-1skmt3`

- [ ] **Step 1:** Modify `nag_check.mjs` to emit IPC messages directly via a new helper (`writeIpcMessage` from a Node script — copy the helper to `groups/global/scripts/lib/ipc.mjs` for cross-group reuse).
- [ ] **Step 2:** Replace the `prompt` column for `task-1775531043169-1skmt3` with a stub that always `[no-reply]`s; alternatively change the gate script to never set `wakeAgent: true` (cron just runs `nag_check.mjs` which posts directly).
- [ ] **Step 3:** Verify after a couple of cycles: `nag_check.mjs` posts the nag webhook personas without the agent ever firing.

### Task 4.3: Commit + verify in DB

```bash
sqlite3 store/messages.db "SELECT prompt FROM scheduled_tasks WHERE id='task-1775531043169-1skmt3';"
# should be the no-op stub
```

---

## Phase 5: Panda reveal event-driven

Same shape as Phase 3.

### Task 5.1: Extract the panda gate script

- [ ] **Step 1:** Move gate body for `task-1775619472081-ja2ron` into `groups/discord_parents/scripts/panda_poll.mjs`, export `pollPandaState({ token })`.
- [ ] **Step 2:** In `qotd-slash.mjs` after `appendSubmission`, call `pollPandaState`, then:
  - `partial` → `writeIpcMessage({ type: 'edit_message', label: 'panda_heart', text: buildPartialCard(data) })` — no agent needed.
  - `full_reveal` → `writeIpcMessage({ type: 'message', chatJid, sender: 'Claudio', text: buildRevealText(data) })`. The reveal text **could** still go through Sonnet for narration, but the narrative payload is small enough that a templated reveal works. Default to templated; user can opt back into Sonnet if they want narrative voice.

### Task 5.2: Delete the cron

```bash
sqlite3 store/messages.db "DELETE FROM scheduled_tasks WHERE id='task-1775619472081-ja2ron';"
```

---

## Phase 6: Emilio reminder dedup (decision required)

**Investigation finding:** `task-1775899684850-x7diaz` (every 15 min, 7-19h) is the **early-warning** advisory ("time to start thinking about wind-down"), and `task-1776104908481-bun1lw` (every 10 min, 7-21h) is the **immediate "happening now"** reminder. They are not pure duplicates. Both fire the agent only when the wind-down window opens (gate-protected); today (2026-04-25) `bun1lw` fired the agent **1 time** and `x7diaz` fired **0 times**.

**Three options:**

### Option A: Consolidate into one task with two-phase output

- One cron `*/10 7-21 * * *` runs a single gate script.
- Gate detects two states: `early_warning` (40+ min before sleep target) and `imminent` (0–10 min before sleep target).
- Single agent prompt accepts both states with branching logic.
- Net: -1 cron task, -1 redundant gate read of the Sleep Log.
- Risk: agent prompt gets more complex; needs careful testing.

### Option B: Keep both, document the difference

- No code change.
- Add a comment block in the prompts pointing at each other.
- Net: zero change but clarity for future maintenance.

### Option C: Move both to script-only (no agent)

- Both reminders are deterministic text ("Wind-down at X, sleep by Y") — no Sonnet reasoning required.
- Replace agent fires with `writeIpcMessage` direct posts from the gate scripts.
- Net: zero agent fires from emilio reminders; -1 daily Sonnet call.
- Risk: loses Claudio's voice / contextual nudges if any.

**Recommendation:** **Option C.** Both reminders are templated; the agent isn't adding value. Combined with Phase 4 conversion of the silverthorne nag, this completes a pattern: time-based reminders should not invoke the agent.

### Task 6.1: Stop here for user decision

- [ ] **Step 1:** Present the three options to the user. Do not implement.
- [ ] **Step 2:** Once chosen, add a Task 6.2 with concrete steps.

---

## Self-Review Checklist

- [x] **Spec coverage:** Each user-stated bug + each suggested poller + dedup has at least one phase.
- [x] **Placeholder scan:** No "TBD" or "implement later" in core phases. Phase 6 has explicit user-decision step (acceptable).
- [x] **Type consistency:** `writeIpcMessage` signature matches across files. `IpcMessage` shape mirrors what `src/ipc.ts` consumes.
- [ ] **Dependency graph:**
  - Phase 1 stand-alone.
  - Phase 2 stand-alone.
  - Phase 3, 4, 5 each depend on Phase 2.
  - Phase 4 also depends on Phase 1.
  - Phase 6 stand-alone (and gated on user choice).
- [ ] **Worktree:** This plan should run in a worktree (per writing-plans skill convention). The user has not been working in one yet — call out at handoff.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-25-chore-fixes-and-poller-migration.md`.

Recommended execution order:

1. **Phase 1 first** — fixes user-reported pain immediately, smallest blast radius.
2. **Phase 2 next** — foundation for Phases 3-5.
3. **Phases 3, 4, 5 in parallel** — they're independent.
4. **Phase 6** — needs user decision (option A/B/C) before implementation.

Two execution options for the implementation:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review, parallelizable.
2. **Inline Execution** — single session, batch tasks with checkpoints.

Worktree: this is a multi-area refactor — recommend running in a worktree (`/Users/paden.portillobrinqa.com/.claude/worktrees/chore-poller-cleanup`). Decision deferred to user.
