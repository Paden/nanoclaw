# Modified src/ Files

These files existed in upstream and were modified. Apply changes surgically to the v2 versions — do NOT copy files wholesale, as v2 will have restructured them.

---

## src/config.ts

**Intent:** Add Ollama routing config, webhook persona map, Discord reactions mode, and a trigger-pattern builder that allows optional `@` prefix.

**How to apply — add these exports:**

```typescript
// Ollama / alternative model routing
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
export const OLLAMA_API_KEY =
  process.env.OLLAMA_API_KEY || envConfig.OLLAMA_API_KEY || 'ollama';
export const COMPACT_TOKEN_THRESHOLD = parseInt(
  process.env.COMPACT_TOKEN_THRESHOLD || '100000', 10);
export const COMPACT_MODEL =
  process.env.COMPACT_MODEL || envConfig.COMPACT_MODEL || 'gemma4:31b-cloud';

// Trigger pattern — allows optional @ prefix (e.g. both "Claudio" and "@Claudio")
export function buildTriggerPattern(trigger: string): RegExp {
  const name = trigger.trim().replace(/^@+/, '');
  return new RegExp(`^@?${escapeRegex(name)}\\b`, 'i');
}
export function getTriggerPattern(): RegExp {
  return buildTriggerPattern(ASSISTANT_NAME);
}
// Replace the static TRIGGER_PATTERN export with getTriggerPattern() calls,
// or keep both and update callers to use getTriggerPattern().

// Discord reaction inbound mode
type ReactionsMode = 'all' | 'own' | 'off';
function resolveReactionsMode(): ReactionsMode {
  const v = (process.env.DISCORD_REACTIONS_INBOUND || envConfig.DISCORD_REACTIONS_INBOUND || 'own').toLowerCase();
  if (v === 'all' || v === 'own' || v === 'off') return v;
  return 'own';
}
export const DISCORD_REACTIONS_INBOUND: ReactionsMode = resolveReactionsMode();

// Webhook personas for Discord pet voices and baby chimes
export const WEBHOOK_PERSONAS: Record<string, { name: string; avatar?: string }> = {
  Voss: {
    name: 'Voss 🌋',
    avatar: 'https://cdn.discordapp.com/attachments/1491554631413665872/1492346511525412955/image.png?ex=69daff7e&is=69d9adfe&hm=5f2469c5d3b10088478539899c65f1fb7c7feaff8dfb6493f44bc7d08262430b&',
  },
  Nyx: {
    name: 'Nyx 🌙',
    avatar: 'https://cdn.discordapp.com/attachments/1491554631413665872/1492348804010213426/image.png?ex=69db01a1&is=69d9b021&hm=2e4ed22ac6ebaa2f48588ffc2788bf6e550ab1cd3f2374d64ac306e3bdf310c5&',
  },
  Zima: {
    name: 'Zima ❄️',
    avatar: 'https://cdn.discordapp.com/attachments/1491554631413665872/1492348630244392990/image.png?ex=69db0177&is=69d9aff7&hm=c2f259ceb5b9e1095a5fea3b8bde3c19493627ee53f13f3030532801ec35f8b7&',
  },
  Emilio: {
    name: 'Emilio 👶',
    avatar: 'https://i.imgur.com/yVsvDuQ.jpeg',
  },
};
```

---

## src/db.ts

**Intent:** Add token usage tracking table, reactions storage table, and helper functions. Apply to v2's db.ts after the two-DB session split restructure — add to whichever DB file owns schema migrations.

**How to apply — add these tables to the schema migration block:**

```typescript
// Token usage per group
db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_folder TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_input_tokens INTEGER DEFAULT 0,
    cache_creation_input_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    timestamp TEXT NOT NULL
  )
`);

// Discord reaction storage
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    action TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);
```

**Add these functions:**

```typescript
export function logTokenUsage(entry: {
  group_folder: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  timestamp: string;
}): void { /* INSERT INTO token_usage */ }

export function getTokenUsageSince(groupFolder: string, since: string): {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
} { /* SELECT SUM from token_usage WHERE timestamp >= since */ }

export function storeReaction(entry: {
  chat_jid: string;
  message_id: string;
  user_id: string;
  emoji: string;
  action: 'add' | 'remove';
  timestamp: string;
}): void { /* INSERT INTO reactions */ }
```

Also check if v2 still has the `sessions` table — if so, ensure `created_at` column exists via migration:
```typescript
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN created_at TEXT`);
} catch { /* column already exists */ }
```

---

## src/container-runner.ts

**Intent:** Add five non-standard capabilities. Apply surgically — v2 will have restructured this file for the new entity model.

**⚠️ High risk — read v2's version first before applying any of these.**

### 1. Pet channel isolation

Groups outside `discord_silverthorne` and `discord_family-fun` get a scrubbed `groups/global/` overlay with pet lore lines filtered out. Prevents Voss/Nyx/Zima references leaking into Emilio or Panda contexts.

```typescript
const PET_CHANNELS = new Set(['discord_silverthorne', 'discord_family-fun']);
const GROUP_GLOBAL_OMITTED_FILES = new Set(['soul.md', 'claudio-journal.md']);
const PET_LINE_PATTERN = /Voss|Nyx|Zima|🌋|🌙|❄️/;

// When building the overlay for a non-pet group, filter out pet lines
// and omit files in GROUP_GLOBAL_OMITTED_FILES from groups/global/
```

### 2. Ollama local model routing

When `ANTHROPIC_MODEL` (or per-group `.model` file) doesn't start with `claude-`, bypass OneCLI and route to Ollama on port 11435:

```typescript
const isOllamaModel = !resolvedModel.startsWith('claude-');
if (isOllamaModel) {
  args.push('-e', 'ANTHROPIC_BASE_URL=http://host.docker.internal:11435');
  args.push('-e', `ANTHROPIC_API_KEY=${OLLAMA_API_KEY}`);
  // suppress telemetry
  args.push('-e', 'ANTHROPIC_DISABLE_TELEMETRY=1');
}
```

### 3. Per-group model override via `.model` file

```typescript
// In resolveGroupModel() or equivalent:
const modelFile = path.join(resolveGroupFolderPath(groupFolder), '.model');
if (fs.existsSync(modelFile)) {
  model = fs.readFileSync(modelFile, 'utf8').trim();
}
```

### 4. Google Calendar MCP credential mount

Mounts OAuth credentials into every container so Google Sheets/Calendar MCP can authenticate:

```typescript
const gcalCredsPath = path.join(DATA_DIR, 'google-calendar', 'gcp-oauth.keys.json');
const gcalTokenPath = path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');

// Add to docker run args:
args.push('-v', `${gcalCredsPath}:/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json:ro`);
args.push('-v', `${gcalTokenPath}:/home/node/.config/google-calendar-mcp/tokens.json:ro`);
```

Note: in v2 containers use Bun instead of Node, so the home path may be `/home/bun/` — check v2's container runner for the correct path.

### 5. Safety caps

```typescript
args.push('-e', 'NANOCLAW_MAX_TURNS=40');
```

---

## src/index.ts

**Intent:** Add compaction integration, orphaned IPC drain, token tracking, output filters, and hallucination guard. Apply surgically.

**How to apply:**

1. **Import new modules** at top:
   ```typescript
   import { shouldCompact, runCompaction } from './compaction.js';
   import { notifyCompaction } from './compaction-notify.js';
   import { storeReaction, logTokenUsage } from './db.js';
   ```

2. **Orphaned IPC drain** — on startup, check `data/ipc/<group>/input/` for stale files from containers that died mid-stream. Delete them to prevent replaying ghost messages.

3. **Token usage tracking** — in the streaming callback, accumulate `peakInputTokens` (not cumulative — track the single-call peak). After each turn, call `logTokenUsage()`. If peak exceeds `COMPACT_TOKEN_THRESHOLD`, trigger compaction.

4. **`[no-reply]` filter** — strip `[no-reply]` suffix from both task output and regular replies before posting to channel.

5. **`<internal>...</internal>` stripping** — strip these blocks from all outbound text. Agents wrap status/log content in `<internal>` tags; stripping here defends every send-path.

6. **Hallucinated-outage guard** — if agent reply contains phrases like "I'm having trouble connecting", "API appears to be down", "I cannot reach" (infrastructure-blame patterns), purge the session to prevent the agent from repeatedly blaming infra.

7. **`resolveGroupModel(groupFolder)`** — mirror of `container-runner`'s model resolution for host-side use (reads `.model` file, falls back to `ANTHROPIC_MODEL` env).

---

## src/types.ts

**Intent:** Extend the `Channel` interface with message editing, pinning, reactions, and webhook support. Add reaction event types.

**How to apply — add to `Channel` interface:**

```typescript
export interface Channel {
  // ... existing methods ...
  sendMessageWithId?(jid: string, text: string): Promise<string | undefined>;
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  deleteMessage?(jid: string, messageId: string): Promise<void>;
  pinMessage?(jid: string, messageId: string): Promise<void>;
  unpinMessage?(jid: string, messageId: string): Promise<void>;
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  sendWebhookMessage?(jid: string, text: string, name: string, avatar?: string): Promise<string | undefined>;
}

export interface ReactionEvent {
  chatJid: string;
  messageId: string;
  userId: string;
  emoji: string;
  action: 'add' | 'remove';
  timestamp: string;
}

export type OnReaction = (event: ReactionEvent) => void;
```
