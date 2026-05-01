import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeIpcMessage, writeIpcTask } from './ipc-writer.js';

describe('writeIpcMessage', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-writer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('drops a JSON file in data/ipc/<group>/messages/', async () => {
    await writeIpcMessage(
      'discord_test',
      { type: 'message', chatJid: 'dc:123', text: 'hi' },
      { rootDir: tmpRoot },
    );
    const dir = path.join(tmpRoot, 'data', 'ipc', 'discord_test', 'messages');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(body.type).toBe('message');
    expect(body.text).toBe('hi');
    expect(body.chatJid).toBe('dc:123');
  });

  it('preserves all message fields', async () => {
    await writeIpcMessage(
      'discord_test',
      {
        type: 'message',
        chatJid: 'dc:123',
        label: 'wordle_card',
        pin: true,
        upsert: true,
        sender: 'Claudio',
        text: 'card body',
      },
      { rootDir: tmpRoot },
    );
    const dir = path.join(tmpRoot, 'data', 'ipc', 'discord_test', 'messages');
    const body = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'),
    );
    expect(body.label).toBe('wordle_card');
    expect(body.pin).toBe(true);
    expect(body.upsert).toBe(true);
    expect(body.sender).toBe('Claudio');
  });

  it('rejects unknown message types', async () => {
    await expect(
      writeIpcMessage(
        'discord_test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'bogus' as any, chatJid: 'dc:1' },
        { rootDir: tmpRoot },
      ),
    ).rejects.toThrow(/unknown ipc type/);
  });

  it('rejects messages missing chatJid', async () => {
    await expect(
      writeIpcMessage(
        'discord_test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'message' } as any,
        { rootDir: tmpRoot },
      ),
    ).rejects.toThrow(/chatJid required/);
  });

  it('writeIpcTask drops JSON in tasks/ subdirectory', async () => {
    await writeIpcTask(
      'discord_test',
      {
        type: 'schedule_task',
        prompt: 'narrate the wordle saga',
        targetJid: 'dc:123',
        schedule_type: 'once',
        schedule_value: '2026-04-25T22:00:00Z',
      },
      { rootDir: tmpRoot },
    );
    const dir = path.join(tmpRoot, 'data', 'ipc', 'discord_test', 'tasks');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(body.type).toBe('schedule_task');
    expect(body.schedule_type).toBe('once');
  });

  it('writeIpcTask rejects missing required fields', async () => {
    await expect(
      writeIpcTask(
        'discord_test',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'schedule_task', prompt: 'x' } as any,
        { rootDir: tmpRoot },
      ),
    ).rejects.toThrow(/requires/);
  });

  it('produces unique filenames for rapid successive writes', async () => {
    const paths = await Promise.all([
      writeIpcMessage(
        'discord_test',
        { type: 'message', chatJid: 'dc:1', text: 'a' },
        { rootDir: tmpRoot },
      ),
      writeIpcMessage(
        'discord_test',
        { type: 'message', chatJid: 'dc:1', text: 'b' },
        { rootDir: tmpRoot },
      ),
      writeIpcMessage(
        'discord_test',
        { type: 'message', chatJid: 'dc:1', text: 'c' },
        { rootDir: tmpRoot },
      ),
    ]);
    expect(new Set(paths).size).toBe(3);
  });
});
