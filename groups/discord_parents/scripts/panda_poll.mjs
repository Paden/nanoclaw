// panda_poll.mjs — gate logic for the Panda Romance Game reveal.
//
// Reads the Portillo Games "Panda Submissions" tab, compares against
// /workspace/group/panda_processed.json, and decides whether anything new
// happened since the last fire:
//
//   - both partners answered, not yet revealed   → full_reveal (wakes agent)
//   - exactly one partner answered (or partial state changed)
//                                                → partial    (host updates card)
//   - nothing new                                → wakeAgent: false
//
// Persists a fingerprint to panda_last_partial.json so identical partial
// states don't re-emit. Full reveals bypass the fingerprint and rely on
// processed_days for idempotency (the agent flips that file after revealing).
//
// Used by:
//   - scripts/qotd-slash.mjs after each successful answer submission (host)
//   - the legacy cron task (going away in this commit)
//
// All Sheets I/O is injected via deps so tests can run against fixtures.

import fs from 'fs';

export const PADEN_ID = '181867944404320256';
export const BRENDA_ID = '350815183804825600';

export const PANDA_REVEAL_PROMPT = `You are Claudio Portillo in the #panda channel. Both partners have just answered today's Panda question — run the FULL REVEAL now.

FLOW:
1. Read /workspace/group/panda_game_state.json for current_question_number, current_day, and current_question. Read /workspace/group/panda_processed.json for card_acked / processed_days.
2. Read the Portillo Games sheet (1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY), Panda Submissions tab. Find the two rows where qNum == current_question_number — one for Paden (181867944404320256), one for Brenda (350815183804825600).
3. Post ONE message in #panda containing:
   - A short theatrical header naming Day {N} · Q{qNum} and the question text.
   - Paden's full answer, clearly labeled.
   - Brenda's full answer, clearly labeled.
   - A brief warm reflection from Claudio — what stood out, what you learned, what it says about them as a couple. Intimate, never clinical.
4. Append a Love Map entry to the Panda Love Map tab of the same sheet. Columns: date, day, question_number, question, paden_answer, brenda_answer, insight. Capture anything new you learned about each of them.
5. Update /workspace/group/panda_processed.json: add current_question_number to processed_days, and append both \`{qNum}:181867944404320256\` and \`{qNum}:350815183804825600\` to card_acked.
6. Update /workspace/group/panda_game_state.json: set last_revealed_at to now (ISO string).
7. Update the pinned panda_heart card with both ✅ answered and the new Love Map count. Use \`send_message({label: "panda_heart", pin: true, upsert: true, text: ...})\` — all three flags.

Card format:
\`\`\`
💌 PANDA — Day {N} · {phase}
Today's question:
"{question text}"

  Paden  💭 ✅ answered
  Brenda 💭 ✅ answered

─────────────────
🗺️ Love Map: {count} entries
Last reveal: {date}
\`\`\`

Tone: warm, intimate, unhurried. Never reveal one partner's answer before the other.`;

function readJsonOr(path, fallback) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch {
    // ignore — corrupt file means we treat it as fresh
  }
  return fallback;
}

function writeJson(path, body) {
  fs.writeFileSync(path, JSON.stringify(body));
}

// pollPandaState({
//   readRangeFn, token, sheetId,
//   gameStatePath, processedPath, fingerprintPath,
// })
//   → { wakeAgent: boolean, reason?: string, data?: PartialOrFullData }
//
// Mirrors the cron's exact gate semantics:
//   - reads Panda Submissions, filters to rows whose qNum column matches
//     state.current_question_number
//   - if neither partner has a NEW (un-acked) row → wakeAgent: false
//   - if both partners have rows AND processed_days doesn't include qNum
//     → { type: 'full_reveal', ... } (bypasses fingerprint; agent flips
//       processed_days for idempotency)
//   - otherwise → { type: 'partial', ... } gated by panda_last_partial.json
//     (only fires when fingerprint changes vs. last call)
export async function pollPandaState({
  readRangeFn,
  token,
  sheetId,
  gameStatePath,
  processedPath,
  fingerprintPath,
} = {}) {
  if (!readRangeFn) throw new Error('readRangeFn required');
  if (!sheetId) throw new Error('sheetId required');
  if (!gameStatePath) throw new Error('gameStatePath required');
  if (!processedPath) throw new Error('processedPath required');
  if (!fingerprintPath) throw new Error('fingerprintPath required');

  const state = readJsonOr(gameStatePath, null);
  if (!state || typeof state.current_question_number !== 'number') {
    return { wakeAgent: false, reason: 'no_state' };
  }
  const processed = readJsonOr(processedPath, { processed_days: [], card_acked: [] });
  const currentQNum = state.current_question_number;

  let rows;
  try {
    rows = await readRangeFn(sheetId, 'Panda Submissions!A:F', { token });
  } catch (err) {
    return {
      wakeAgent: false,
      reason: 'error',
      error: String(err.message || err).slice(0, 200),
    };
  }
  if (!Array.isArray(rows)) {
    return { wakeAgent: false, reason: 'no_rows' };
  }

  // Match on question_number (column 4 / index 4), not date — Paden and Brenda
  // can be answering different qNums on the same day (e.g. catching up).
  // Columns: [timestamp, date, user_id, name, qNum, answer]
  const matching = rows
    .slice(1)
    .filter((row) => parseInt(row[4], 10) === currentQNum);

  const padenRow = matching.find((row) => row[2] === PADEN_ID);
  const brendaRow = matching.find((row) => row[2] === BRENDA_ID);

  const padenAcked = (processed.card_acked || []).includes(`${currentQNum}:${PADEN_ID}`);
  const brendaAcked = (processed.card_acked || []).includes(`${currentQNum}:${BRENDA_ID}`);
  const padenNew = padenRow && !padenAcked;
  const brendaNew = brendaRow && !brendaAcked;

  if (!padenNew && !brendaNew) {
    return { wakeAgent: false, reason: 'no_new_submissions' };
  }

  const alreadyRevealed = (processed.processed_days || []).includes(currentQNum);
  const bothAnswered = !!(padenRow && brendaRow);

  if (bothAnswered && !alreadyRevealed) {
    return {
      wakeAgent: true,
      data: {
        type: 'full_reveal',
        day: state.current_day,
        question: state.current_question,
        question_number: currentQNum,
        paden_answer: padenRow[5],
        brenda_answer: brendaRow[5],
      },
    };
  }

  // Partial-state fingerprint gate: suppress repeated wakes when partial state
  // is unchanged since the last call. Mirrors the cron's behavior.
  const currentFingerprint = `${currentQNum}:${padenRow ? 1 : 0}:${brendaRow ? 1 : 0}`;
  const last = readJsonOr(fingerprintPath, null);
  if (last && last.fingerprint === currentFingerprint) {
    return { wakeAgent: false, reason: 'partial_unchanged' };
  }
  writeJson(fingerprintPath, {
    fingerprint: currentFingerprint,
    updated_at: new Date().toISOString(),
  });

  return {
    wakeAgent: true,
    data: {
      type: 'partial',
      day: state.current_day,
      question: state.current_question,
      question_number: currentQNum,
      paden_answered: !!padenRow,
      brenda_answered: !!brendaRow,
    },
  };
}
