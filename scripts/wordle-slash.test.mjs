import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import the runWordleHook export from the .mjs slash. The module has
// top-level dynamic imports for sheets.mjs / score-guess.mjs but those are
// just imports — they don't perform I/O, so the module is safe to load in a
// test process. We pass injected deps so no real Sheets/IPC calls happen.
import { runWordleHook } from './wordle-slash.mjs';

describe('runWordleHook', () => {
  let tmpRoot;
  let groupFolder;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wordle-slash-test-'));
    groupFolder = 'discord_family-fun';
    // Ensure injected pollerStatePath sits inside tmpRoot.
    fs.mkdirSync(path.join(tmpRoot, 'groups', groupFolder), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does nothing when poll returns wakeAgent=false', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn();
    const out = await runWordleHook({
      groupFolder,
      pollFn: async () => ({ wakeAgent: false, reason: 'no_change' }),
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      sagaStateLoader: () => ({ day: 21, genre: 'pirate space opera' }),
      leaderboardLoader: () => null,
      pollerStatePath: path.join(tmpRoot, 'state.json'),
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('noop');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();
  });

  it('updates the pinned card via IPC when state changed mid-game', async () => {
    const writeMessage = vi.fn().mockResolvedValue('/tmp/x.json');
    const writeTask = vi.fn();
    const summary = {
      Paden: { guesses: 2, solved: false, done: false },
      Brenda: { guesses: 0, solved: false, done: false },
      Danny: { guesses: 0, solved: false, done: false },
    };
    const out = await runWordleHook({
      groupFolder,
      pollFn: async () => ({
        wakeAgent: true,
        data: { today: '2026-04-25', summary, all_done: false, needs_resolve: false },
      }),
      cardBuilder: ({ summary: s, day, genre, leaderboard, dateStr }) => {
        expect(s).toEqual(summary);
        expect(day).toBe(21);
        expect(genre).toBe('pirate space opera');
        expect(dateStr).toBe('2026-04-25');
        return `card body day=${day}`;
      },
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      sagaStateLoader: () => ({ day: 21, genre: 'pirate space opera' }),
      leaderboardLoader: () => ({ Paden: { wins: 5 } }),
      pollerStatePath: path.join(tmpRoot, 'state.json'),
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('updated_card');
    expect(writeTask).not.toHaveBeenCalled();
    expect(writeMessage).toHaveBeenCalledOnce();
    const [calledGroup, calledMsg] = writeMessage.mock.calls[0];
    expect(calledGroup).toBe(groupFolder);
    expect(calledMsg.type).toBe('message');
    expect(calledMsg.label).toBe('wordle_card');
    expect(calledMsg.pin).toBe(true);
    expect(calledMsg.upsert).toBe(true);
    expect(calledMsg.chatJid).toBe('dc:1490924818869260328');
    expect(calledMsg.text).toContain('card body day=21');
  });

  it('schedules the saga reveal task when needs_resolve=true', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn().mockResolvedValue('/tmp/t.json');
    const summary = {
      Paden: { guesses: 3, solved: true, done: true },
      Brenda: { guesses: 4, solved: true, done: true },
      Danny: { guesses: 6, solved: false, done: true },
    };
    const out = await runWordleHook({
      groupFolder,
      pollFn: async () => ({
        wakeAgent: true,
        data: { today: '2026-04-25', summary, all_done: true, needs_resolve: true },
      }),
      cardBuilder: () => 'should_not_be_called',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      sagaStateLoader: () => ({ day: 21, genre: 'pirate space opera' }),
      leaderboardLoader: () => null,
      pollerStatePath: path.join(tmpRoot, 'state.json'),
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe('scheduled_reveal');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).toHaveBeenCalledOnce();
    const [calledGroup, calledTask] = writeTask.mock.calls[0];
    expect(calledGroup).toBe(groupFolder);
    expect(calledTask.type).toBe('schedule_task');
    expect(calledTask.schedule_type).toBe('once');
    expect(calledTask.targetJid).toBe('dc:1490924818869260328');
    expect(calledTask.prompt).toContain('Saga Wordle');
    expect(calledTask.prompt).toContain('reveal');
    // Schedule must be ~5s in the future
    const scheduledAt = new Date(calledTask.schedule_value).getTime();
    expect(scheduledAt).toBeGreaterThan(Date.now() - 1000);
    expect(scheduledAt).toBeLessThan(Date.now() + 60_000);
  });

  it('returns ok=false with poll_threw when pollFn throws', async () => {
    const writeMessage = vi.fn();
    const writeTask = vi.fn();
    const out = await runWordleHook({
      groupFolder,
      pollFn: async () => {
        throw new Error('sheets exploded');
      },
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      sagaStateLoader: () => ({ day: 21, genre: 'pirate space opera' }),
      leaderboardLoader: () => null,
      pollerStatePath: path.join(tmpRoot, 'state.json'),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('poll_threw');
    expect(writeMessage).not.toHaveBeenCalled();
    expect(writeTask).not.toHaveBeenCalled();
  });

  it('returns ok=false with write_card_failed when IPC write throws', async () => {
    const writeMessage = vi.fn().mockRejectedValue(new Error('disk full'));
    const writeTask = vi.fn();
    const out = await runWordleHook({
      groupFolder,
      pollFn: async () => ({
        wakeAgent: true,
        data: {
          today: '2026-04-25',
          summary: {
            Paden: { guesses: 1, solved: false, done: false },
            Brenda: { guesses: 0, solved: false, done: false },
            Danny: { guesses: 0, solved: false, done: false },
          },
          all_done: false,
          needs_resolve: false,
        },
      }),
      cardBuilder: () => 'card',
      writeIpcMessageFn: writeMessage,
      writeIpcTaskFn: writeTask,
      sagaStateLoader: () => ({ day: 21, genre: 'pirate space opera' }),
      leaderboardLoader: () => null,
      pollerStatePath: path.join(tmpRoot, 'state.json'),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('write_card_failed');
  });
});
