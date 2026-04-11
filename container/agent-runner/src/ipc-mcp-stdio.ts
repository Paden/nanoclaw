/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Optionally tag the message with a label so you can edit/pin/delete it later (e.g. a persistent status card). Optionally pin on send.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Pet name to speak as (e.g. "Voss", "Nyx", "Zima"). Message appears from the pet via webhook, not Claudio.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'Logical label to remember this message by (e.g. "status_card"). Required to later edit/pin/delete it. Reusing a label overwrites the previous mapping.',
      ),
    pin: z
      .boolean()
      .optional()
      .describe('If true, pin the message after sending. Requires label.'),
    upsert: z
      .boolean()
      .optional()
      .describe(
        'If true and label already exists, edit the existing message instead of posting a new one. Use for persistent status cards — one call handles both create and update.',
      ),
  },
  async (args) => {
    const data: Record<string, string | boolean | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      label: args.label,
      pin: args.pin,
      upsert: args.upsert,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'edit_message',
  'Edit a previously-sent message identified by its label. Use this to keep a persistent status card up to date without re-posting.',
  {
    label: z.string().describe('Label used when sending the original message'),
    text: z.string().describe('New message text'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'edit_message',
      chatJid,
      label: args.label,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Edit queued.' }] };
  },
);

server.tool(
  'delete_message',
  'Delete a previously-sent message by label.',
  { label: z.string() },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'delete_message',
      chatJid,
      label: args.label,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Delete queued.' }] };
  },
);

server.tool(
  'pin_message',
  'Pin a previously-sent message by label.',
  { label: z.string() },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'pin_message',
      chatJid,
      label: args.label,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Pin queued.' }] };
  },
);

server.tool(
  'unpin_message',
  'Unpin a previously-sent message by label.',
  { label: z.string() },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'unpin_message',
      chatJid,
      label: args.label,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Unpin queued.' }] };
  },
);

server.tool(
  'discord_add_reaction',
  'Add a unicode emoji reaction to a Discord message. Target the message by its raw Discord message ID (from inbound messages) or by label (from a message you sent with a label). Unicode emoji only for v1 — e.g. "👍", "🎉", "❤️". Custom guild emoji are not supported.',
  {
    emoji: z
      .string()
      .describe('Unicode emoji character, e.g. "👍", "🎉", "❤️".'),
    messageId: z
      .string()
      .optional()
      .describe('Raw Discord message ID to react to (e.g. from an inbound message).'),
    label: z
      .string()
      .optional()
      .describe('Label of a previously-sent message to react to (alternative to messageId).'),
  },
  async (args) => {
    if (!args.messageId && !args.label) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide either messageId or label.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(MESSAGES_DIR, {
      type: 'add_reaction',
      chatJid,
      messageId: args.messageId,
      label: args.label,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Reaction queued.' }],
    };
  },
);

server.tool(
  'discord_remove_reaction',
  "Remove the bot's own unicode emoji reaction from a Discord message. Only removes reactions previously added by the bot.",
  {
    emoji: z.string().describe('Unicode emoji to remove.'),
    messageId: z
      .string()
      .optional()
      .describe('Raw Discord message ID.'),
    label: z
      .string()
      .optional()
      .describe('Label of a previously-sent message (alternative to messageId).'),
  },
  async (args) => {
    if (!args.messageId && !args.label) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide either messageId or label.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(MESSAGES_DIR, {
      type: 'remove_reaction',
      chatJid,
      messageId: args.messageId,
      label: args.label,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: 'Reaction removal queued.' }],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. Returns task ID. Use update_task to modify.

context_mode: "group" = with chat history, "isolated" = fresh session (include all context in prompt).

schedule_value (LOCAL timezone): cron="0 9 * * *", interval="300000" (ms), once="2026-02-01T15:30:00" (no Z suffix).

Task output is sent to the group. Use send_message for immediate delivery or <internal> tags to suppress.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

// register_group is only relevant for the main admin group — skip it entirely
// for other groups/DMs to save ~400 tokens of tool schema.
if (isMain) {
  server.tool(
    'register_group',
    `Register a new chat/group. Use available_groups.json for JIDs. Folder must be channel-prefixed: "{channel}_{name}" (e.g., "discord_general"). Lowercase with hyphens.`,
    {
      jid: z
        .string()
        .describe(
          'Chat JID (e.g., "dc:1234567890123456", "tg:-1001234567890")',
        ),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe('Channel-prefixed folder name (e.g., "discord_general")'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
      requiresTrigger: z
        .boolean()
        .optional()
        .describe(
          'If true, only respond when triggered. Default: false (respond to all).',
        ),
    },
    async (args) => {
      const data = {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        requiresTrigger: args.requiresTrigger ?? false,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
          },
        ],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
