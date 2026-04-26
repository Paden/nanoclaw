import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pollPandaState, PADEN_ID, BRENDA_ID, PANDA_REVEAL_PROMPT } from './panda_poll.mjs';

const HEADERS = ['timestamp', 'date', 'user_id', 'name', 'qNum', 'answer'];

function rowFor(userId, name, qNum, answer = 'sample answer') {
  return ['2026-04-25T12:00:00', '2026-04-25', userId, name, String(qNum), answer];
}

describe('pollPandaState', () => {
  let tmpDir;
  let gameStatePath;
  let processedPath;
  let fingerprintPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-poll-test-'));
    gameStatePath = path.join(tmpDir, 'panda_game_state.json');
    processedPath = path.join(tmpDir, 'panda_processed.json');
    fingerprintPath = path.join(tmpDir, 'panda_last_partial.json');
    fs.writeFileSync(
      gameStatePath,
      JSON.stringify({
        phase: '36_questions',
        current_day: 15,
        current_question_number: 15,
        current_question: 'What is the greatest accomplishment of your life?',
      }),
    );
    fs.writeFileSync(
      processedPath,
      JSON.stringify({ processed_days: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14], card_acked: [] }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns wakeAgent=false when no submissions for current Q', async () => {
    const readRangeFn = vi.fn().mockResolvedValue([HEADERS]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('no_new_submissions');
  });

  it('returns partial when only Paden answered (first time)', async () => {
    const readRangeFn = vi.fn().mockResolvedValue([
      HEADERS,
      rowFor(PADEN_ID, 'Paden', 15, 'shipping NanoClaw'),
    ]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(true);
    expect(out.data.type).toBe('partial');
    expect(out.data.day).toBe(15);
    expect(out.data.question_number).toBe(15);
    expect(out.data.paden_answered).toBe(true);
    expect(out.data.brenda_answered).toBe(false);
    // Fingerprint must be persisted
    expect(fs.existsSync(fingerprintPath)).toBe(true);
    const fp = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
    expect(fp.fingerprint).toBe('15:1:0');
  });

  it('returns wakeAgent=false on identical second poll (partial fingerprint unchanged)', async () => {
    const rows = [HEADERS, rowFor(PADEN_ID, 'Paden', 15)];
    const readRangeFn = vi.fn().mockResolvedValue(rows);
    const first = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(first.wakeAgent).toBe(true);
    // Mark the partial as acked so it's not "new" the second time around —
    // mirrors what the cron's gate did. Without this the second poll would
    // still see Paden's row as new and short-circuit on the new-submission
    // gate before fingerprint check.
    fs.writeFileSync(
      processedPath,
      JSON.stringify({ processed_days: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14], card_acked: [`15:${PADEN_ID}`] }),
    );
    const second = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(second.wakeAgent).toBe(false);
    expect(second.reason).toBe('no_new_submissions');
  });

  it('partial fingerprint suppresses repeat when partial state unchanged', async () => {
    // Both Paden's row and a prior fingerprint exist; second poll without
    // any newly-acked rows but with un-acked Paden row → should suppress
    // on fingerprint gate.
    fs.writeFileSync(
      fingerprintPath,
      JSON.stringify({ fingerprint: '15:1:0', updated_at: '2026-04-25T11:00:00Z' }),
    );
    const rows = [HEADERS, rowFor(PADEN_ID, 'Paden', 15)];
    const readRangeFn = vi.fn().mockResolvedValue(rows);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('partial_unchanged');
  });

  it('returns full_reveal when both answered and not yet processed', async () => {
    const readRangeFn = vi.fn().mockResolvedValue([
      HEADERS,
      rowFor(PADEN_ID, 'Paden', 15, 'shipping the thing'),
      rowFor(BRENDA_ID, 'Brenda', 15, 'raising the kids'),
    ]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(true);
    expect(out.data.type).toBe('full_reveal');
    expect(out.data.paden_answer).toBe('shipping the thing');
    expect(out.data.brenda_answer).toBe('raising the kids');
    expect(out.data.day).toBe(15);
    expect(out.data.question_number).toBe(15);
    // Full reveal does NOT touch the fingerprint file.
    expect(fs.existsSync(fingerprintPath)).toBe(false);
  });

  it('does not re-fire when both answered but Q already in processed_days', async () => {
    fs.writeFileSync(
      processedPath,
      JSON.stringify({
        processed_days: [1, 15],
        card_acked: [`15:${PADEN_ID}`, `15:${BRENDA_ID}`],
      }),
    );
    const readRangeFn = vi.fn().mockResolvedValue([
      HEADERS,
      rowFor(PADEN_ID, 'Paden', 15),
      rowFor(BRENDA_ID, 'Brenda', 15),
    ]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('no_new_submissions');
  });

  it('filters out rows for other question numbers', async () => {
    // Paden answered Q14 (catch-up), nobody answered Q15. With current_question_number=15
    // the Q14 row should be invisible to the gate.
    const readRangeFn = vi.fn().mockResolvedValue([
      HEADERS,
      rowFor(PADEN_ID, 'Paden', 14, 'catch-up answer'),
    ]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('no_new_submissions');
  });

  it('returns wakeAgent=false on Sheets error (does not throw)', async () => {
    const readRangeFn = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('error');
  });

  it('returns wakeAgent=false when game state is missing', async () => {
    fs.unlinkSync(gameStatePath);
    const readRangeFn = vi.fn().mockResolvedValue([HEADERS]);
    const out = await pollPandaState({
      readRangeFn, token: 'fake', sheetId: 's1',
      gameStatePath, processedPath, fingerprintPath,
    });
    expect(out.wakeAgent).toBe(false);
    expect(out.reason).toBe('no_state');
    expect(readRangeFn).not.toHaveBeenCalled();
  });
});

describe('PANDA_REVEAL_PROMPT', () => {
  it('mentions both partner IDs and the sheet', () => {
    expect(PANDA_REVEAL_PROMPT).toContain(PADEN_ID);
    expect(PANDA_REVEAL_PROMPT).toContain(BRENDA_ID);
    expect(PANDA_REVEAL_PROMPT).toContain('1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY');
    expect(PANDA_REVEAL_PROMPT).toContain('Panda Love Map');
    expect(PANDA_REVEAL_PROMPT).toContain('panda_heart');
  });
});
