import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import runPandaHook. The module has top-level dynamic imports for
// sheets.mjs but those don't perform I/O, so the module is safe to load in
// the test process. We pass injected deps so no real Sheets/IPC calls
// happen.
import { runPandaHook } from './qotd-slash.mjs';

describe('runPandaHook', () => {
  let tmpRoot;
  let gameStatePath;
  let processedPath;
  let fingerprintPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qotd-slash-test-'));
    gameStatePath = path.join(tmpRoot, 'panda_game_state.json');
    processedPath = path.join(tmpRoot, 'panda_processed.json');
    fingerprintPath = path.join(tmpRoot, 'panda_last_partial.json');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does nothing when poll returns wakeAgent=false', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn();
    const out = await runPandaHook({
      pollFn: async () => ({ wakeAgent: false, reason: 'no_new_submissions' }),
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({ phase: '36_questions', last_revealed_at: null }),
      processedLoader: () => ({ processed_days: [], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('noop');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();
  });

  it('updates the panda_heart card via IPC when state is partial', async () => {
    const writeMessage = vi.fn().mockResolvedValue('/tmp/m.json');
    const writeTask = vi.fn();
    const out = await runPandaHook({
      pollFn: async () => ({
        wakeAgent: true,
        data: {
          type: 'partial',
          day: 15,
          question: 'What is the greatest accomplishment of your life?',
          question_number: 15,
          paden_answered: true,
          brenda_answered: false,
        },
      }),
      cardBuilder: ({ qNum, question, padenAnswered, brendaAnswered, day, phase, loveMapCount, lastRevealAt }) => {
        expect(qNum).toBe(15);
        expect(day).toBe(15);
        expect(question).toContain('greatest accomplishment');
        expect(padenAnswered).toBe(true);
        expect(brendaAnswered).toBe(false);
        expect(phase).toBe('36_questions');
        expect(loveMapCount).toBe(13);
        expect(lastRevealAt).toBe('2026-04-21T13:58:24Z');
        return 'panda card body';
      },
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({ phase: '36_questions', last_revealed_at: '2026-04-21T13:58:24Z' }),
      processedLoader: () => ({ processed_days: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('updated_card');
    expect(writeTask).not.toHaveBeenCalled();
    expect(writeMessage).toHaveBeenCalledOnce();
    const [calledGroup, calledMsg] = writeMessage.mock.calls[0];
    expect(calledGroup).toBe('discord_parents');
    expect(calledMsg.type).toBe('edit_message');
    expect(calledMsg.label).toBe('panda_heart');
    expect(calledMsg.pin).toBe(true);
    expect(calledMsg.upsert).toBe(true);
    expect(calledMsg.chatJid).toBe('dc:1490784303662239894');
    expect(calledMsg.text).toBe('panda card body');
    // Webhook persona must NOT be set — the card posts as Claudio (default).
    expect(calledMsg.sender).toBeUndefined();
  });

  it('schedules the reveal task when poll says full_reveal', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn().mockResolvedValue('/tmp/t.json');
    const out = await runPandaHook({
      pollFn: async () => ({
        wakeAgent: true,
        data: {
          type: 'full_reveal',
          day: 15,
          question: 'What is the greatest accomplishment of your life?',
          question_number: 15,
          paden_answer: 'shipping NanoClaw',
          brenda_answer: 'raising the kids',
        },
      }),
      cardBuilder: () => 'should_not_be_called',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({ phase: '36_questions' }),
      processedLoader: () => ({ processed_days: [], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('scheduled_reveal');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).toHaveBeenCalledOnce();
    const [calledGroup, calledTask] = writeTask.mock.calls[0];
    expect(calledGroup).toBe('discord_parents');
    expect(calledTask.type).toBe('schedule_task');
    expect(calledTask.schedule_type).toBe('once');
    expect(calledTask.targetJid).toBe('dc:1490784303662239894');
    expect(calledTask.prompt).toContain('Panda');
    expect(calledTask.prompt).toContain('FULL REVEAL');
    // Schedule must be ~5s in the future
    const scheduledAt = new Date(calledTask.schedule_value).getTime();
    expect(scheduledAt).toBeGreaterThan(Date.now() - 1000);
    expect(scheduledAt).toBeLessThan(Date.now() + 60_000);
  });

  it('returns ok=false with poll_threw when pollFn throws', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn();
    const out = await runPandaHook({
      pollFn: async () => {
        throw new Error('sheets exploded');
      },
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({}),
      processedLoader: () => ({ processed_days: [], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('poll_threw');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();
  });

  it('returns ok=false with write_card_failed when partial IPC write throws', async () => {
    const writeMessage = vi.fn().mockRejectedValue(new Error('disk full'));
    const writeTask = vi.fn();
    const out = await runPandaHook({
      pollFn: async () => ({
        wakeAgent: true,
        data: {
          type: 'partial',
          day: 15,
          question: 'q',
          question_number: 15,
          paden_answered: true,
          brenda_answered: false,
        },
      }),
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({ phase: '36_questions' }),
      processedLoader: () => ({ processed_days: [], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('write_card_failed');
  });

  it('returns ok=false with schedule_task_failed when reveal write throws', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn().mockRejectedValue(new Error('queue full'));
    const out = await runPandaHook({
      pollFn: async () => ({
        wakeAgent: true,
        data: {
          type: 'full_reveal',
          day: 15,
          question: 'q',
          question_number: 15,
          paden_answer: 'a',
          brenda_answer: 'b',
        },
      }),
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      stateLoader: () => ({}),
      processedLoader: () => ({ processed_days: [], card_acked: [] }),
      gameStatePath,
      processedPath,
      fingerprintPath,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('schedule_task_failed');
  });
});
