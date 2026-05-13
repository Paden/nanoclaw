/**
 * Host-side bridge for slash-command hooks that need to wake the agent or
 * post a card without going through the agent's send_message tool.
 *
 * Replaces the v1 IPC pattern (JSON-file drops under data/ipc/<group>/...)
 * with v2 primitives:
 *
 *   - writeIpcTask  → insertTask into the session's inbound.db. host-sweep
 *                     wakes the container within 60s and the agent runs the
 *                     prompt.
 *   - writeIpcMessage (edit_message with label/upsert) → writeOutboundDirect
 *                     into outbound.db. The delivery loop picks it up and
 *                     the channel adapter does the pin/upsert/edit.
 *
 * Slash scripts (`scripts/qotd-slash.mjs`, `wordle-slash.mjs`,
 * `chore-slash.mjs`) still import this module via `dist/ipc-writer.js` — the
 * function signatures are unchanged from v1 so they don't need to be touched.
 */
import { randomUUID } from 'crypto';

import { getAgentGroupByFolder } from './db/agent-groups.js';
import { findSessionByAgentGroup } from './db/sessions.js';
import { openInboundDb, writeOutboundDirect } from './session-manager.js';
import { insertTask } from './modules/scheduling/db.js';

const VALID_MESSAGE_TYPES = new Set([
  'message',
  'edit_message',
  'delete_message',
  'pin_message',
  'unpin_message',
  'add_reaction',
  'remove_reaction',
]);

interface IpcMessage {
  type: string;
  chatJid: string;
  text?: string;
  label?: string;
  pin?: boolean;
  upsert?: boolean;
  [key: string]: unknown;
}

interface IpcTask {
  type: 'schedule_task';
  prompt: string;
  targetJid: string;
  schedule_type: 'once' | 'recurring';
  schedule_value: string;
}

function parseJid(jid: string): { channelType: string; platformId: string } {
  const colon = jid.indexOf(':');
  if (colon < 0) throw new Error(`invalid jid (no scheme): ${jid}`);
  const scheme = jid.slice(0, colon);
  const platformId = jid.slice(colon + 1);
  const channelType = scheme === 'dc' ? 'discord' : scheme === 'tg' ? 'telegram' : scheme === 'sl' ? 'slack' : scheme;
  return { channelType, platformId };
}

function resolveGroupSession(groupFolder: string): { agentGroupId: string; sessionId: string } {
  const group = getAgentGroupByFolder(groupFolder);
  if (!group) throw new Error(`unknown group folder: ${groupFolder}`);
  const session = findSessionByAgentGroup(group.id);
  if (!session) throw new Error(`no session for agent group: ${group.id} (${groupFolder})`);
  return { agentGroupId: group.id, sessionId: session.id };
}

/**
 * Post (or edit, via label+upsert) a message to a channel without going
 * through the agent. Writes directly into the session's outbound.db; the
 * host's delivery loop picks it up and the channel adapter handles
 * label/pin/upsert.
 */
export async function writeIpcMessage(groupFolder: string, msg: IpcMessage): Promise<void> {
  if (!VALID_MESSAGE_TYPES.has(msg.type)) {
    throw new Error(`unknown ipc type: ${msg.type}`);
  }
  if (!msg.chatJid) {
    throw new Error('chatJid required');
  }

  const { agentGroupId, sessionId } = resolveGroupSession(groupFolder);
  const { channelType, platformId } = parseJid(msg.chatJid);

  const { type, chatJid, ...rest } = msg;
  void chatJid;

  // For non-text actions (unpin_message, delete_message, etc.) the adapter
  // dispatches on `content.operation`. Plain messages need no operation tag —
  // the adapter falls through to text delivery.
  const content: Record<string, unknown> = { ...rest };
  if (type !== 'message') {
    content.operation = type;
  }

  writeOutboundDirect(agentGroupId, sessionId, {
    id: `ipc-${Date.now()}-${randomUUID().slice(0, 8)}`,
    kind: 'chat',
    platformId,
    channelType,
    threadId: null,
    content: JSON.stringify(content),
  });
}

/**
 * Schedule a one-off agent task. The task lands in the session's inbound.db
 * and host-sweep wakes the container within 60s.
 *
 * (Recurring tasks aren't supported via this bridge yet — slash hooks only
 *  need one-off reveals.)
 */
export async function writeIpcTask(groupFolder: string, task: IpcTask): Promise<void> {
  if (task.type !== 'schedule_task') {
    throw new Error(`unknown ipc task type: ${task.type}`);
  }
  if (!task.prompt || !task.targetJid || !task.schedule_type || !task.schedule_value) {
    throw new Error('schedule_task requires prompt, targetJid, schedule_type, schedule_value');
  }
  if (task.schedule_type !== 'once') {
    throw new Error(`only schedule_type=once supported via host-ipc; got: ${task.schedule_type}`);
  }

  const { agentGroupId, sessionId } = resolveGroupSession(groupFolder);
  const { channelType, platformId } = parseJid(task.targetJid);

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    insertTask(db, {
      id: `task-${Date.now()}-${randomUUID().slice(0, 6)}`,
      processAfter: task.schedule_value,
      recurrence: null,
      platformId,
      channelType,
      threadId: null,
      content: JSON.stringify({ prompt: task.prompt, script: null }),
    });
  } finally {
    db.close();
  }
}
