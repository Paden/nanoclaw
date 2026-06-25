import { registerResource } from '../crud.js';
import { getSession } from '../../db/sessions.js';
import { rotateSession, jsonlBytesForSession } from '../../session-rotate.js';

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    reset: {
      access: 'approval',
      description:
        "Reset a session's SDK state to recover from the compaction-empty-output trap. " +
        'Kills the running container, archives the .claude-shared/projects/*.jsonl transcripts, ' +
        'and clears the continuation:claude row in outbound.db so the next message spawns a brand-new SDK session. ' +
        'Per-group long-term memory (CLAUDE.local.md, conversations/) is preserved. ' +
        'Use --id <session-id>. host-sweep also auto-rotates when transcripts exceed SESSION_JSONL_ROTATE_MB (default 5).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const session = getSession(id);
        if (!session) throw new Error(`No session: ${id}`);
        const beforeBytes = jsonlBytesForSession(session.agent_group_id, session.id);
        const outcome = rotateSession(session.agent_group_id, session.id, 'manual via ncl');
        return {
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          containerKilled: outcome.containerKilled,
          archivedJsonls: outcome.archivedJsonls.length,
          continuationDeleted: outcome.continuationDeleted,
          jsonlMbBefore: Math.round((beforeBytes / (1024 * 1024)) * 10) / 10,
        };
      },
    },
  },
});
