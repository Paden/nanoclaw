import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const VALID_MESSAGE_TYPES = new Set([
  'message',
  'edit_message',
  'delete_message',
  'pin_message',
  'unpin_message',
  'add_reaction',
  'remove_reaction',
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

export interface WriteIpcOptions {
  rootDir?: string;
}

export interface IpcTask {
  type: 'schedule_task';
  prompt: string;
  targetJid: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  // Optional context_mode, gate_script, etc. — passed through to scheduler.
  [key: string]: unknown;
}

async function dropJson(dir: string, body: unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, JSON.stringify(body, null, 2));
  return filepath;
}

// Drop a JSON file in data/ipc/<groupFolder>/messages/ so the host's IPC
// watcher picks it up and routes it to the matching channel. Used by
// host-side slash commands to post pinned cards / reveal messages without
// going through the agent.
export async function writeIpcMessage(
  groupFolder: string,
  msg: IpcMessage,
  opts: WriteIpcOptions = {},
): Promise<string> {
  if (!VALID_MESSAGE_TYPES.has(msg.type)) {
    throw new Error(`unknown ipc type: ${msg.type}`);
  }
  if (!msg.chatJid) {
    throw new Error('chatJid required');
  }
  const rootDir = opts.rootDir ?? process.cwd();
  const dir = path.join(rootDir, 'data', 'ipc', groupFolder, 'messages');
  return dropJson(dir, msg);
}

// Drop a JSON file in data/ipc/<groupFolder>/tasks/ to schedule a one-off
// agent fire (or recurring task) without going through the agent first.
// Used by host-side slash commands when state changes need narrative LLM
// output (e.g. wordle reveal saga, panda full reveal) — fire the agent
// once at the moment it's needed instead of polling every N minutes.
export async function writeIpcTask(
  groupFolder: string,
  task: IpcTask,
  opts: WriteIpcOptions = {},
): Promise<string> {
  if (task.type !== 'schedule_task') {
    throw new Error(`unknown ipc task type: ${task.type}`);
  }
  if (
    !task.prompt ||
    !task.targetJid ||
    !task.schedule_type ||
    !task.schedule_value
  ) {
    throw new Error(
      'schedule_task requires prompt, targetJid, schedule_type, schedule_value',
    );
  }
  const rootDir = opts.rootDir ?? process.cwd();
  const dir = path.join(rootDir, 'data', 'ipc', groupFolder, 'tasks');
  return dropJson(dir, task);
}
